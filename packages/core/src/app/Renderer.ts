import {EventDispatcher, ValueDispatcher} from '../events';
import type {Scene, Sound, Threadable} from '../scenes';
import {ReadOnlyTimeEvents} from '../scenes/timeEvents';
import {
  getActiveAnimationGroup,
  isActiveAnimationGroupWait,
} from '../flow/animationGroup';
import {clampRemap} from '../tweening';
import {Vector2} from '../types';
import {Semaphore} from '../utils';
import type {Exporter} from './Exporter';
import {PlaybackManager, PlaybackState} from './PlaybackManager';
import {PlaybackStatus} from './PlaybackStatus';
import type {Project} from './Project';
import {SharedWebGLContext} from './SharedWebGLContext';
import {Stage, StageSettings} from './Stage';
import {TimeEstimator} from './TimeEstimator';

export interface RendererSettings extends StageSettings {
  name: string;
  range: [number, number];
  fps: number;
  /**
   * The name of the only scene to render.
   *
   * @remarks
   * When set, the `range` is ignored and the whole scene is rendered instead.
   */
  scene?: string | null;
  /**
   * Whether to leave out the idle frames of top-level waits.
   *
   * @remarks
   * Applies to animation groups consisting of a single `waitFor` or
   * `waitUntil` call. The first frame of such a group is always exported,
   * the following frames only if something moved in them.
   */
  skipWaits?: boolean;
  exporter: {
    name: string;
    options: unknown;
  };
}

export enum RendererState {
  Initial,
  Working,
  Aborting,
}

export enum RendererResult {
  Success,
  Error,
  Aborted,
}

/**
 * The state of the top-level wait that is currently being trimmed.
 */
interface WaitTrim {
  /**
   * Identifies the wait among all animation groups of the project.
   */
  key: string;
  /**
   * Whether anything has moved since the first frame of the wait.
   */
  active: boolean;
  /**
   * Whether the picture has been found to stay the same while the threads are
   * idle. Checked anew after each rendered frame.
   */
  verified: boolean;
  /**
   * Whether the picture has been found to change while the threads are idle.
   * Such a wait is rendered in full.
   */
  restless: boolean;
  /**
   * Idle frames that have not been exported, as `[frame, sceneFrame]`.
   */
  held: [number, number][];
}

function isIdle(scene: Scene | null): boolean {
  if (!scene) return true;
  const thread = (scene as Partial<Threadable>).onThreadChanged?.current;
  return thread?.idle ?? false;
}

function isSameImage(a: ImageData, b: ImageData): boolean {
  if (a.width !== b.width || a.height !== b.height) return false;
  const pixelsA = new Uint32Array(a.data.buffer);
  const pixelsB = new Uint32Array(b.data.buffer);
  for (let i = 0; i < pixelsA.length; i++) {
    if (pixelsA[i] !== pixelsB[i]) return false;
  }
  return true;
}

/**
 * The rendering logic used by the editor to export animations.
 *
 * @remarks
 * This class uses the `PlaybackManager` to render animations. In contrast to a
 * player, a renderer does not use an update loop. It plays through the
 * animation as fast as it can, occasionally pausing to keep the UI responsive.
 *
 * The actual exporting is outsourced to an {@link Exporter}.
 */
export class Renderer {
  public get onStateChanged() {
    return this.state.subscribable;
  }
  private readonly state = new ValueDispatcher(RendererState.Initial);

  public get onFinished() {
    return this.finished.subscribable;
  }
  private readonly finished = new EventDispatcher<RendererResult>();

  public get onFrameChanged() {
    return this.frame.subscribable;
  }
  private readonly frame = new ValueDispatcher(0);

  public readonly stage = new Stage();
  public readonly estimator = new TimeEstimator();

  private readonly lock = new Semaphore();
  private readonly playback: PlaybackManager;
  private readonly status: PlaybackStatus;
  private readonly sharedWebGLContext: SharedWebGLContext;
  private exporter: Exporter | null = null;
  private waitTrim: WaitTrim | null = null;
  private abortController: AbortController | null = null;

  public constructor(private project: Project) {
    this.playback = new PlaybackManager();
    this.status = new PlaybackStatus(this.playback);
    this.sharedWebGLContext = new SharedWebGLContext(this.project.logger);
    const scenes: Scene[] = [];
    for (const description of project.scenes) {
      const scene = new description.klass({
        ...description,
        meta: description.meta.clone(),
        logger: this.project.logger,
        playback: this.status,
        size: new Vector2(1920, 1080),
        resolutionScale: 1,
        timeEventsClass: ReadOnlyTimeEvents,
        sharedWebGLContext: this.sharedWebGLContext,
        experimentalFeatures: project.experimentalFeatures,
      });
      scenes.push(scene);
    }
    this.playback.setup(scenes);
  }

  /**
   * Render the animation using the provided settings.
   *
   * @param settings - The rendering settings.
   */
  public async render(settings: RendererSettings) {
    if (this.state.current !== RendererState.Initial) return;
    await this.lock.acquire();
    this.estimator.reset();
    this.state.current = RendererState.Working;
    let result: RendererResult;
    try {
      this.abortController = new AbortController();
      result = await this.run(settings, this.abortController.signal);
    } catch (e: any) {
      this.project.logger.error(e);
      result = RendererResult.Error;
      if (this.exporter) {
        try {
          await this.exporter.stop?.(result);
        } catch (_) {
          // do nothing
        }
        this.exporter = null;
      }
    }

    this.estimator.update(1);
    this.state.current = RendererState.Initial;
    this.finished.dispatch(result);
    this.sharedWebGLContext.dispose();
    this.lock.release();
  }

  /**
   * Abort the ongoing render process.
   */
  public abort() {
    if (this.state.current !== RendererState.Working) return;
    this.abortController?.abort();
    this.state.current = RendererState.Aborting;
  }

  /**
   * Export an individual frame.
   *
   * @remarks
   * This method always uses the default `ImageExporter`.
   *
   * @param settings - The rendering settings.
   * @param time - The timestamp to export.
   */
  public async renderFrame(settings: RendererSettings, time: number) {
    await this.lock.acquire();

    try {
      const frame = this.status.secondsToFrames(time);
      this.stage.configure(settings);
      this.playback.fps = settings.fps;
      this.playback.state = PlaybackState.Rendering;

      await this.reloadScenes(settings);
      await this.playback.reset();
      await this.playback.seek(frame);
      await this.stage.render(
        this.playback.currentScene!,
        this.playback.previousScene,
      );

      if (import.meta.hot) {
        import.meta.hot.send('motion-canvas:export', {
          frame,
          name: frame.toString().padStart(6, '0'),
          data: this.stage.finalBuffer.toDataURL('image/png'),
          mimeType: 'image/png',
          subDirectories: ['still', this.project.name],
        });
      }
    } catch (e: any) {
      this.project.logger.error(e);
    }

    this.lock.release();
  }

  private async run(
    settings: RendererSettings,
    signal: AbortSignal,
  ): Promise<RendererResult> {
    const exporterClass = this.project.meta.rendering.exporter.exporters.find(
      exporter => exporter.id === settings.exporter.name,
    );
    if (!exporterClass) {
      this.project.logger.error(
        `Could not find the "${settings.exporter.name}" exporter.`,
      );
      return RendererResult.Error;
    }

    await this.prepare(settings);
    if (signal.aborted) return RendererResult.Aborted;

    let scene: Scene | null = null;
    if (settings.scene) {
      scene = this.findScene(settings.scene);
      if (!scene) {
        this.project.logger.error(
          `Could not find the "${settings.scene}" scene.`,
        );
        return RendererResult.Error;
      }
      settings = {...settings, range: this.getSceneRange(scene)};
    }

    this.exporter = await exporterClass.create(this.project, settings);
    const overrides = await this.exporter.configuration?.();
    if (overrides) {
      settings = {...settings, ...overrides};
      await this.prepare(settings);
      if (signal.aborted) return RendererResult.Aborted;
      if (scene) {
        settings = {...settings, range: this.getSceneRange(scene)};
      }
    }

    let from = this.status.secondsToFrames(settings.range[0]);
    let to = Math.min(
      this.playback.duration,
      this.status.secondsToFrames(settings.range[1]),
    );
    if (scene) {
      from = scene.firstFrame;
      to = scene.lastFrame;
    }
    this.frame.current = from;

    const sounds = this.collectSounds();
    await this.playback.reset();
    if (signal.aborted) return RendererResult.Aborted;

    await this.playback.seek(from);
    if (signal.aborted) return RendererResult.Aborted;

    await this.exporter.start?.(sounds, to - from);
    this.waitTrim = null;
    const skipWaits = settings.skipWaits ?? false;
    let lastRefresh = performance.now();
    let result = RendererResult.Success;
    try {
      this.estimator.reset(1 / (to - from));
      await this.exportFrame(signal, skipWaits);
      this.estimator.update(clampRemap(from, to, 0, 1, this.playback.frame));

      if (signal.aborted) {
        result = RendererResult.Aborted;
      } else {
        let finished = false;
        while (!finished) {
          await this.playback.progress();
          if (scene && this.playback.currentScene !== scene) {
            // This frame already belongs to the next scene.
            break;
          }
          if (this.playback.finished) {
            // The last scene has run to its end. This frame lies one past
            // the animation's last frame (it is frame number `duration`) and
            // shows that last frame again.
            break;
          }
          await this.exportFrame(signal, skipWaits);
          this.estimator.update(
            clampRemap(from, to, 0, 1, this.playback.frame),
          );
          if (performance.now() - lastRefresh > 1 / 30) {
            lastRefresh = performance.now();
            await new Promise(resolve => setTimeout(resolve, 0));
          }
          if (this.playback.finished || this.playback.frame >= to) {
            finished = true;
          }
          if (signal.aborted) {
            result = RendererResult.Aborted;
            finished = true;
          }
        }
      }
    } catch (e: any) {
      this.project.logger.error(e);
      result = RendererResult.Error;
    }

    await this.exporter.stop?.(result);
    this.exporter = null;
    return result;
  }

  /**
   * Configure the stage and the playback, and recalculate the scenes.
   *
   * @param settings - The rendering settings.
   */
  private async prepare(settings: RendererSettings) {
    this.stage.configure(settings);
    this.playback.fps = settings.fps;
    this.playback.state = PlaybackState.Rendering;
    await this.reloadScenes(settings);
    await this.playback.recalculate();
  }

  private findScene(name: string): Scene | null {
    return (
      this.playback.onScenesRecalculated.current.find(
        scene => scene.name === name,
      ) ?? null
    );
  }

  private getSceneRange(scene: Scene): [number, number] {
    return [
      this.status.framesToSeconds(scene.firstFrame),
      this.status.framesToSeconds(scene.lastFrame),
    ];
  }

  private async reloadScenes(settings: RendererSettings) {
    for (let i = 0; i < this.project.scenes.length; i++) {
      const description = this.project.scenes[i];
      const scene = this.playback.onScenesRecalculated.current[i];
      scene.reload({
        config: description.onReplaced.current.config,
        size: settings.size,
        resolutionScale: settings.resolutionScale,
      });
      scene.meta.set(description.meta.get());
      scene.variables.updateSignals(this.project.variables ?? {});
    }
  }

  private collectSounds() {
    const sounds: Sound[] = [];
    for (const scene of this.playback.onScenesRecalculated.current) {
      sounds.push(...scene.sounds.getSounds());
    }
    return sounds;
  }

  private async exportFrame(signal: AbortSignal, skipWaits: boolean) {
    const scene = this.playback.currentScene;
    const frame = this.playback.frame;
    const sceneFrame = frame - scene.firstFrame;
    this.frame.current = frame;

    if (!skipWaits || !isActiveAnimationGroupWait(scene)) {
      this.waitTrim = null;
      await this.renderFrameAndSend(frame, sceneFrame, signal);
      return;
    }

    const key = `${scene.name}/${getActiveAnimationGroup(scene)}`;
    if (this.waitTrim?.key !== key) {
      // The first frame of a wait shows the outcome of whatever came before
      // it, so it's always exported. The idle frames right after it are just
      // a longer hold of that image.
      this.waitTrim = {
        key,
        active: false,
        verified: false,
        restless: false,
        held: [],
      };
      await this.renderFrameAndSend(frame, sceneFrame, signal);
      return;
    }

    const trim = this.waitTrim;
    let rendered = false;
    if (
      !trim.restless &&
      isIdle(scene) &&
      isIdle(this.playback.previousScene)
    ) {
      if (!trim.verified) {
        // Not everything that moves is driven by a thread: signals can depend
        // on time directly, as do shaders and videos. Such things move
        // continuously, so one look at the picture is enough to notice them.
        const before = this.readStage();
        await this.renderStage();
        rendered = true;
        trim.verified = true;
        trim.restless = !isSameImage(before, this.readStage());
      }

      if (!trim.restless) {
        // Nothing moved. This frame is only exported if something moves again
        // before the wait is over.
        trim.held.push([frame, sceneFrame]);
        return;
      }
    }

    if (trim.active) {
      // A pause between two movements is a part of the animation. The stage
      // still shows the same picture as during the held frames.
      for (const [heldFrame, heldSceneFrame] of trim.held) {
        await this.send(heldFrame, heldSceneFrame, signal);
      }
    }
    trim.held = [];
    trim.active = true;
    trim.verified = false;
    if (!rendered) {
      await this.renderStage();
    }
    await this.send(frame, sceneFrame, signal);
  }

  private async renderFrameAndSend(
    frame: number,
    sceneFrame: number,
    signal: AbortSignal,
  ) {
    await this.renderStage();
    await this.send(frame, sceneFrame, signal);
  }

  private async renderStage() {
    await this.stage.render(
      this.playback.currentScene!,
      this.playback.previousScene,
    );
  }

  private readStage(): ImageData {
    const {width, height} = this.stage.finalBuffer;
    return this.stage.context.getImageData(0, 0, width, height);
  }

  private async send(frame: number, sceneFrame: number, signal: AbortSignal) {
    const scene = this.playback.currentScene;
    await this.exporter!.handleFrame(
      this.stage.finalBuffer,
      frame,
      sceneFrame,
      scene.name,
      signal,
      this.stage.context,
      getActiveAnimationGroup(scene),
    );
  }
}
