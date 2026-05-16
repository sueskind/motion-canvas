import type {
  Exporter,
  Project,
  RendererResult,
  RendererSettings,
  Sound,
} from '@motion-canvas/core';
import {
  BoolMetaField,
  EventDispatcher,
  NumberMetaField,
  ObjectMetaField,
  ValueOf,
} from '@motion-canvas/core';

type ServerResponse =
  | {
      status: 'success';
      method: string;
      data: unknown;
    }
  | {
      status: 'error';
      method: string;
      message?: string;
    };

type FFmpegExporterOptions = ValueOf<
  ReturnType<typeof FFmpegExporterClient.meta>
>;

type InvokeStrategy = 'ws' | 'octet-stream';

const EXPORT_FRAME_LIMIT = 256;
const EXPORT_RETRY_DELAY = 1000;

/**
 * FFmpeg video exporter.
 *
 * @remarks
 * Most of the export logic is handled on the server. This class communicates
 * with the FFmpegBridge through a WebSocket connection which lets it invoke
 * methods on the FFmpegExporterServer class.
 *
 * For example, calling the following method:
 * ```ts
 * async this.invoke('process', 7);
 * ```
 * Will invoke the `process` method on the FFmpegExporterServer class with `7`
 * as the argument. The result of the method will be returned as a Promise.
 *
 * Before any methods can be invoked, the FFmpegExporterServer class must be
 * initialized by invoking `start`.
 */
export class FFmpegExporterClient implements Exporter {
  public static readonly id = '@motion-canvas/ffmpeg';
  public static readonly displayName = 'Video (FFmpeg)';

  public static meta(project: Project) {
    const meta = new ObjectMetaField(this.displayName, {
      fastStart: new BoolMetaField('fast start', true),
      includeAudio: new BoolMetaField('include audio', true).disable(
        !project.audio,
      ),
      audioSampleRate: new NumberMetaField('audio sample rate', 48000),
      groupByScene: new BoolMetaField('group by scene', false).describe(
        'Output one mp4 per scene. Audio is omitted.',
      ),
      groupByAnimation: new BoolMetaField('group by animation', false).describe(
        'Output one mp4 per animation (each top-level `yield*` in a scene). Audio is omitted.',
      ),
      saveOneFrameGroups: new BoolMetaField(
        'save one-frame groups',
        true,
      ).describe(
        'When unchecked, groups that end up containing only a single frame are skipped (no mp4 is produced for them). Has no effect when neither grouping option is enabled.',
      ),
    });

    const refreshGroupedState = () => {
      const grouped =
        meta.groupByScene.get() || meta.groupByAnimation.get();
      meta.includeAudio.disable(!project.audio || grouped);
      meta.saveOneFrameGroups.disable(!grouped);
    };
    meta.groupByScene.onChanged.subscribe(refreshGroupedState);
    meta.groupByAnimation.onChanged.subscribe(refreshGroupedState);
    refreshGroupedState();

    return meta;
  }

  public static async create(project: Project, settings: RendererSettings) {
    return new FFmpegExporterClient(project, settings);
  }

  private static readonly response = new EventDispatcher<ServerResponse>();

  static {
    if (import.meta.hot) {
      import.meta.hot.on(
        `motion-canvas/ffmpeg-ack`,
        (response: ServerResponse) => this.response.dispatch(response),
      );
    }
  }

  private concurrentFrames = 0;
  private error: unknown = false;
  private lastEmittedGroupKey: string | null = null;
  private groupByScene = false;
  private groupByAnimation = false;
  private saveOneFrameGroups = true;
  private pendingFrame: Uint8ClampedArray | null = null;
  private pendingGroupKey: string | null = null;

  public constructor(
    private readonly project: Project,
    private readonly settings: RendererSettings,
  ) {}

  public async start(sounds: Sound[], duration: number): Promise<void> {
    const options = this.settings.exporter.options as FFmpegExporterOptions;
    this.groupByScene = options.groupByScene;
    this.groupByAnimation = options.groupByAnimation;
    this.saveOneFrameGroups = options.saveOneFrameGroups;
    await this.invoke('start', {
      ...this.settings,
      ...options,
      audio: this.project.audio,
      audioOffset:
        this.project.meta.shared.audioOffset.get() - this.settings.range[0],
      sounds,
      duration,
    });
  }

  private buildGroupKey(
    sceneName: string,
    animationName: string | null,
  ): string {
    const parts: string[] = [];
    if (this.groupByScene) parts.push(sceneName);
    if (this.groupByAnimation) {
      parts.push(`${sceneName}-${animationName ?? '_ungrouped'}`);
    }
    return parts.join('/');
  }

  public async handleFrame(
    canvas: HTMLCanvasElement,
    _frame: number,
    _sceneFrame: number,
    sceneName: string,
    _signal: AbortSignal,
    context: CanvasRenderingContext2D,
    animationName: string | null = null,
  ): Promise<void> {
    while (this.concurrentFrames >= EXPORT_FRAME_LIMIT) {
      await new Promise(resolve => setTimeout(resolve, EXPORT_RETRY_DELAY));
    }

    if (this.error) {
      throw this.error;
    }

    const grouping = this.groupByScene || this.groupByAnimation;
    const groupKey = grouping
      ? this.buildGroupKey(sceneName, animationName)
      : null;

    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;

    if (!grouping || this.saveOneFrameGroups) {
      // Original behavior: roll over immediately on every group change.
      if (groupKey !== null && groupKey !== this.lastEmittedGroupKey) {
        await this.rolloverTo(groupKey);
      }
      this.sendFrame(data);
      return;
    }

    // Buffered behavior: defer the rollover (and the first frame) until the
    // pending group is confirmed to contain at least two frames. A 1-frame
    // group ends up discarded — no rollover means no output file is created
    // for it.
    if (this.pendingFrame) {
      if (this.pendingGroupKey === groupKey) {
        // Second frame of the pending group → commit it.
        await this.rolloverTo(groupKey!);
        this.sendFrame(this.pendingFrame);
        this.pendingFrame = null;
        this.pendingGroupKey = null;
        this.sendFrame(data);
        return;
      }
      // Group changed before a second frame arrived → discard pending.
      this.pendingFrame = null;
      this.pendingGroupKey = null;
    }

    if (groupKey === this.lastEmittedGroupKey) {
      // We're still inside the currently-open output; stream normally.
      this.sendFrame(data);
    } else {
      // First frame of a new group; hold it until we know if it's keepers.
      this.pendingFrame = data;
      this.pendingGroupKey = groupKey;
    }
  }

  public async stop(result: RendererResult): Promise<void> {
    // A trailing pending frame here means the final group only ever had one
    // frame — discard it (or flush it, if the user opted to keep one-frame
    // groups).
    if (this.pendingFrame && this.pendingGroupKey !== null) {
      if (this.saveOneFrameGroups) {
        await this.rolloverTo(this.pendingGroupKey);
        this.sendFrame(this.pendingFrame);
      }
      this.pendingFrame = null;
      this.pendingGroupKey = null;
    }

    while (this.concurrentFrames >= EXPORT_FRAME_LIMIT) {
      await new Promise(resolve => setTimeout(resolve, EXPORT_RETRY_DELAY));
    }

    if (this.error) {
      throw this.error;
    }

    await this.invoke('end', result);
  }

  private async rolloverTo(groupKey: string): Promise<void> {
    if (groupKey === this.lastEmittedGroupKey) return;
    // Wait for any in-flight frames before rolling over so they go to the
    // previous file, not the new one.
    while (this.concurrentFrames > 0) {
      await new Promise(resolve => setTimeout(resolve, EXPORT_RETRY_DELAY));
    }
    if (this.error) {
      throw this.error;
    }
    await this.invoke('rollover', {relativePath: groupKey});
    this.lastEmittedGroupKey = groupKey;
  }

  private sendFrame(data: Uint8ClampedArray): void {
    this.concurrentFrames++;
    this.invoke('handleFrame', data, 'octet-stream')
      .then(() => {
        this.concurrentFrames--;
      })
      .catch(error => {
        this.error = error;
        this.concurrentFrames--;
      });
  }

  /**
   * Remotely invoke a method on the server and wait for a response.
   *
   * @param method - The method name to execute on the server.
   * @param data - The data that will be passed as an argument to the method.
   *               Should be serializable.
   * @param strategy - How the data should be sent to the server.
   */
  private invoke<TResponse = unknown, TData = unknown>(
    method: string,
    data: TData,
    strategy: InvokeStrategy = 'ws',
  ): Promise<TResponse> {
    if (import.meta.hot) {
      return new Promise((resolve, reject) => {
        const handle = (response: ServerResponse) => {
          if (response.method !== method) {
            return;
          }

          FFmpegExporterClient.response.unsubscribe(handle);
          if (response.status === 'success') {
            resolve(response.data as TResponse);
          } else {
            reject({
              message: 'An error occurred while exporting the video.',
              remarks: `Method: ${method}<br>Server error: ${response.message}`,
              object: data,
            });
          }
        };
        FFmpegExporterClient.response.subscribe(handle);
        switch (strategy) {
          case 'ws':
            import.meta.hot!.send('motion-canvas/ffmpeg', {method, data});
            break;
          case 'octet-stream':
            fetch(`/ffmpeg/${method}`, {
              method: 'POST',
              body: data as ArrayBuffer,
              // eslint-disable-next-line @typescript-eslint/naming-convention
              headers: {'Content-Type': 'application/octet-stream'},
            }).catch(reject);
            break;
        }
      });
    } else {
      throw new Error('FFmpegExporter can only be used locally.');
    }
  }
}
