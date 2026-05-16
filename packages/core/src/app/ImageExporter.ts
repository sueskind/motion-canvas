import {EventDispatcher} from '../events';
import {
  BoolMetaField,
  EnumMetaField,
  NumberMetaField,
  ObjectMetaField,
  ValueOf,
} from '../meta';
import {clamp} from '../tweening';
import {CanvasOutputMimeType} from '../types';
import type {Exporter} from './Exporter';
import type {Logger} from './Logger';
import type {Project} from './Project';
import type {RendererSettings} from './Renderer';
import {FileTypes} from './presets';

const EXPORT_FRAME_LIMIT = 256;
const EXPORT_RETRY_DELAY = 1000;

type ImageExporterOptions = ValueOf<ReturnType<typeof ImageExporter.meta>>;

interface ServerResponse {
  frame: number;
}

interface ExportPayload {
  frame: number;
  data: string;
  mimeType: CanvasOutputMimeType;
  subDirectories: string[];
  name: string;
}

/**
 * Image sequence exporter.
 *
 * @internal
 */
export class ImageExporter implements Exporter {
  public static readonly id = '@motion-canvas/core/image-sequence';
  public static readonly displayName = 'Image sequence';

  public static meta() {
    const meta = new ObjectMetaField(this.name, {
      fileType: new EnumMetaField('file type', FileTypes),
      quality: new NumberMetaField('quality', 100)
        .setRange(0, 100)
        .describe('A number between 0 and 100 indicating the image quality.'),
      groupByScene: new BoolMetaField('group by scene', false).describe(
        'Group exported images by scene. When checked, separates the sequence into subdirectories for each scene in the project.',
      ),
      groupByAnimation: new BoolMetaField('group by animation', false).describe(
        'Group exported images by animation. Each top-level `yield*` statement in a scene becomes its own subdirectory (0001, 0002, ...). Without "group by scene", frames from different scenes share folders.',
      ),
      saveOneFrameGroups: new BoolMetaField(
        'save one-frame groups',
        true,
      ).describe(
        'When unchecked, groups that end up containing only a single frame are discarded instead of written to disk. Has no effect when neither grouping option is enabled.',
      ),
    });

    meta.fileType.onChanged.subscribe(value => {
      meta.quality.disable(value === 'image/png');
    });

    const refreshGroupedState = () => {
      const grouped = meta.groupByScene.get() || meta.groupByAnimation.get();
      meta.saveOneFrameGroups.disable(!grouped);
    };
    meta.groupByScene.onChanged.subscribe(refreshGroupedState);
    meta.groupByAnimation.onChanged.subscribe(refreshGroupedState);
    refreshGroupedState();

    return meta;
  }

  public static async create(
    project: Project,
    settings: RendererSettings,
  ): Promise<ImageExporter> {
    return new ImageExporter(project.logger, settings);
  }

  private static readonly response = new EventDispatcher<ServerResponse>();

  static {
    if (import.meta.hot) {
      import.meta.hot.on('motion-canvas:export-ack', response => {
        this.response.dispatch(response);
      });
    }
  }

  private readonly frameLookup = new Set<number>();
  private readonly projectName: string;
  private readonly quality: number;
  private readonly fileType: CanvasOutputMimeType;
  private readonly groupByScene: boolean;
  private readonly groupByAnimation: boolean;
  private readonly saveOneFrameGroups: boolean;
  private lastGroupKey: string | null = null;
  private animationFrame = 0;
  private pendingPayload: ExportPayload | null = null;

  public constructor(
    private readonly logger: Logger,
    private readonly settings: RendererSettings,
  ) {
    const options = settings.exporter.options as ImageExporterOptions;
    this.projectName = settings.name;
    this.quality = clamp(0, 1, options.quality / 100);
    this.fileType = options.fileType;
    this.groupByScene = options.groupByScene;
    this.groupByAnimation = options.groupByAnimation;
    this.saveOneFrameGroups = options.saveOneFrameGroups;
  }

  public async start() {
    ImageExporter.response.subscribe(this.handleResponse);
  }

  public async handleFrame(
    canvas: HTMLCanvasElement,
    frame: number,
    sceneFrame: number,
    sceneName: string,
    signal: AbortSignal,
    _context: CanvasRenderingContext2D,
    animationName: string | null = null,
  ) {
    if (this.frameLookup.has(frame)) {
      this.logger.warn(`Frame no. ${frame} is already being exported.`);
      return;
    }
    if (!import.meta.hot) return;

    while (this.frameLookup.size > EXPORT_FRAME_LIMIT) {
      await new Promise(resolve => setTimeout(resolve, EXPORT_RETRY_DELAY));
      if (signal.aborted) {
        return;
      }
    }

    const subDirectories = [this.projectName];
    if (this.groupByScene) subDirectories.push(sceneName);
    if (this.groupByAnimation) {
      subDirectories.push(`${sceneName}-${animationName ?? '_ungrouped'}`);
    }
    const grouping = this.groupByScene || this.groupByAnimation;
    const groupKey = grouping ? subDirectories.join('/') : null;
    const groupChanged = groupKey !== null && groupKey !== this.lastGroupKey;

    if (groupChanged) {
      // Previous group is finished. Flush or discard whatever is buffered.
      this.resolvePending();
      this.lastGroupKey = groupKey;
      this.animationFrame = 0;
    } else if (this.groupByAnimation && groupKey !== null) {
      this.animationFrame++;
    }

    let frameNumber: number;
    if (this.groupByAnimation) {
      frameNumber = this.animationFrame;
    } else if (this.groupByScene) {
      frameNumber = sceneFrame;
    } else {
      frameNumber = frame;
    }

    const paddedFrame = frameNumber.toString().padStart(6, '0');
    const name = this.groupByAnimation
      ? `${sceneName}-${animationName ?? '_ungrouped'}-${paddedFrame}`
      : paddedFrame;

    const payload: ExportPayload = {
      frame,
      data: canvas.toDataURL(this.fileType, this.quality),
      mimeType: this.fileType,
      subDirectories,
      name,
    };

    // Buffer the first frame of each group so that 1-frame groups can be
    // discarded if `saveOneFrameGroups` is unchecked. When grouping is off
    // there is no concept of a group, so just stream frames as before.
    if (!this.saveOneFrameGroups && grouping && groupChanged) {
      this.pendingPayload = payload;
      return;
    }

    if (this.pendingPayload) {
      // We just confirmed the buffered frame's group has >= 2 frames.
      this.sendPayload(this.pendingPayload);
      this.pendingPayload = null;
    }
    this.sendPayload(payload);
  }

  public async stop() {
    this.resolvePending();
    while (this.frameLookup.size > 0) {
      await new Promise(resolve => setTimeout(resolve, EXPORT_RETRY_DELAY));
    }
    ImageExporter.response.unsubscribe(this.handleResponse);
  }

  private sendPayload(payload: ExportPayload) {
    this.frameLookup.add(payload.frame);
    import.meta.hot!.send('motion-canvas:export', payload);
  }

  private resolvePending() {
    if (!this.pendingPayload) return;
    if (this.saveOneFrameGroups) {
      this.sendPayload(this.pendingPayload);
    }
    this.pendingPayload = null;
  }

  private handleResponse = ({frame}: ServerResponse) => {
    this.frameLookup.delete(frame);
  };
}
