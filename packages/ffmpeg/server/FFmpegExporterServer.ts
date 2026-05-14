import type {
  RendererResult,
  RendererSettings,
  Sound,
} from '@motion-canvas/core';
import type {PluginConfig} from '@motion-canvas/vite-plugin';
import {ffmpegPath, ffprobePath} from 'ffmpeg-ffprobe-static';
import type {AudioVideoFilter, FilterSpecification} from 'fluent-ffmpeg';
import ffmpeg from 'fluent-ffmpeg';
import * as fs from 'fs';
import * as path from 'path';
import {Readable} from 'stream';
import {ImageStream} from './ImageStream';

ffmpeg.setFfmpegPath(ffmpegPath!);
ffmpeg.setFfprobePath(ffprobePath!);

export interface FFmpegExporterSettings extends RendererSettings {
  audio?: string;
  audioOffset?: number;

  sounds: Sound[];
  duration: number;

  fastStart: boolean;
  includeAudio: boolean;
  audioSampleRate: number;

  groupByScene: boolean;
  groupByAnimation: boolean;
}

function formatFilters(filters: AudioVideoFilter[]): string {
  return filters
    .map(f => {
      let options: string[] = [];
      if (typeof f.options === 'string') {
        options = [f.options];
      } else if (f.options.constructor === Array) {
        options = f.options;
      } else {
        options = Object.entries(f.options)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => `${k}=${v}`);
      }
      return `${f.filter}=${options.join(':')}`;
    })
    .join(',');
}

interface Pipeline {
  command: ffmpeg.FfmpegCommand;
  stream: ImageStream;
  promise: Promise<void>;
}

/**
 * The server-side implementation of the FFmpeg video exporter.
 */
export class FFmpegExporterServer {
  private readonly size: {x: number; y: number};
  private readonly grouped: boolean;
  private pipeline: Pipeline | null = null;

  public constructor(
    private readonly settings: FFmpegExporterSettings,
    private readonly config: PluginConfig,
  ) {
    this.size = {
      x: Math.round(settings.size.x * settings.resolutionScale),
      y: Math.round(settings.size.y * settings.resolutionScale),
    };
    this.grouped = settings.groupByScene || settings.groupByAnimation;

    if (!this.grouped) {
      // Preserve original single-output behavior: build the command up front
      // with audio mixing and the project duration.
      this.pipeline = this.buildPipeline(
        path.join(this.config.output, `${settings.name}.mp4`),
        settings.includeAudio,
        true,
      );
    }
  }

  public async start() {
    if (!fs.existsSync(this.config.output)) {
      await fs.promises.mkdir(this.config.output, {recursive: true});
    }
    if (this.pipeline) {
      this.pipeline.command.on('stderr', console.error);
      this.pipeline.command.run();
    }
  }

  public async rollover(args: {relativePath: string}) {
    if (this.pipeline) {
      this.pipeline.stream.pushImage(null);
      await this.pipeline.promise;
    }

    const outputPath = path.join(
      this.config.output,
      this.settings.name,
      `${args.relativePath}.mp4`,
    );
    await fs.promises.mkdir(path.dirname(outputPath), {recursive: true});

    // Audio is omitted in grouped mode (rolling audio across multiple outputs
    // is out of scope; the user re-syncs audio in their editor).
    this.pipeline = this.buildPipeline(outputPath, false, false);
    this.pipeline.command.on('stderr', console.error);
    this.pipeline.command.run();
  }

  public async handleFrame(req: Readable) {
    if (!this.pipeline) {
      // Grouped mode but rollover hasn't fired yet (shouldn't happen — the
      // client invokes rollover before the first handleFrame in grouped mode).
      // Drop the frame's body to avoid hanging the request.
      req.resume();
      return;
    }
    await this.pipeline.stream.pushImage(req);
  }

  public async end(result: RendererResult) {
    if (!this.pipeline) return;
    this.pipeline.stream.pushImage(null);
    if (result === 1) {
      try {
        this.pipeline.command.kill('SIGKILL');
        await this.pipeline.promise;
      } catch (_) {
        // do nothing
      }
    } else {
      await this.pipeline.promise;
    }
    this.pipeline = null;
  }

  private buildPipeline(
    outputPath: string,
    includeAudio: boolean,
    capDuration: boolean,
  ): Pipeline {
    const stream = new ImageStream(this.size);
    const command = ffmpeg();

    // Input image sequence
    command
      .input(stream)
      .inputFormat('rawvideo')
      .inputOptions(['-pix_fmt rgba', '-s:v', `${this.size.x}x${this.size.y}`])
      .inputFps(this.settings.fps);

    if (includeAudio) {
      const sounds = [...this.settings.sounds];
      if (this.settings.audio) {
        sounds.push({
          audio: this.settings.audio,
          realPlaybackRate: 1,
          offset: this.settings.audioOffset ?? 0,
        });
      }

      const filterSpec: FilterSpecification[] = [];
      const streams: string[] = [];

      for (let i = 0; i < sounds.length; i++) {
        const sound = sounds[i];
        command.input(sound.audio.slice(1));

        let trimmed = sound.start ?? 0;
        if (sound.offset < 0) {
          trimmed -= sound.offset * sound.realPlaybackRate;
        }

        if (trimmed !== 0) {
          command.inputOptions(`-ss ${trimmed}`);
        }

        const filters: AudioVideoFilter[] = [];
        if (sound.end !== undefined) {
          filters.push({
            filter: 'atrim',
            options: {end: sound.end - trimmed},
          });
        }

        filters.push({
          filter: 'aresample',
          options: this.settings.audioSampleRate.toString(),
        });

        if (sound.gain) {
          filters.push({
            filter: 'volume',
            options: {volume: `${sound.gain}dB`},
          });
        }

        if (sound.realPlaybackRate !== 1) {
          const rate = Math.round(
            this.settings.audioSampleRate * sound.realPlaybackRate,
          );
          filters.push({
            filter: 'asetrate',
            options: {r: rate},
          });
          filters.push({
            filter: 'aresample',
            options: this.settings.audioSampleRate.toString(),
          });
        }

        if (sound.offset > 0) {
          const delay = Math.round(sound.offset * 1000);
          filters.push({
            filter: 'adelay',
            options: {delays: delay, all: 1},
          });
        }

        if (filters.length > 0) {
          filterSpec.push({
            inputs: `${i + 1}:a`,
            filter: formatFilters(filters),
            outputs: `a${i + 1}`,
          });
          streams.push(`a${i + 1}`);
        } else {
          streams.push(`${i + 1}:a`);
        }
      }

      if (sounds.length > 0) {
        command.complexFilter([
          ...filterSpec,
          {
            filter: 'amix',
            // eslint-disable-next-line @typescript-eslint/naming-convention
            options: {
              inputs: sounds.length,
              dropout_transition: 0,
              normalize: 0,
            },
            inputs: streams,
            outputs: 'a',
          },
        ]);
        command.outputOptions(['-map 0:v', '-map [a]']);
      }
    }

    const outputOptions = ['-pix_fmt yuv420p'];
    if (capDuration) {
      outputOptions.push(
        `-t ${this.settings.duration / this.settings.fps}`,
      );
    }

    command
      .output(outputPath)
      .outputOptions(outputOptions)
      .outputFps(this.settings.fps)
      .size(`${this.size.x}x${this.size.y}`);
    if (this.settings.fastStart) {
      command.outputOptions(['-movflags +faststart']);
    }

    const promise = new Promise<void>((resolve, reject) => {
      command.on('end', () => resolve()).on('error', reject);
    });

    return {command, stream, promise};
  }
}
