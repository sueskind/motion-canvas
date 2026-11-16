import {
  BoolMetaField,
  ColorMetaField,
  EnumMetaField,
  ExporterMetaField,
  MetaField,
  NumberMetaField,
  ObjectMetaField,
  RangeMetaField,
  Vector2MetaField,
} from '../meta';
import {CanvasColorSpace, Color, Vector2} from '../types';
import {ColorSpaces, FrameRates, Scales} from './presets';
import type {Project} from './Project';

function createProjectMetadata(project: Project) {
  const meta = {
    version: new MetaField('version', 1),
    shared: new ObjectMetaField('General', {
      background: new ColorMetaField('background', null),
      range: new RangeMetaField('range', [0, Infinity]),
      size: new Vector2MetaField('resolution', new Vector2(1920, 1080)),
      audioOffset: new NumberMetaField('audio offset', 0)
        .setPrecision(4)
        .setStep(0.1),
    }),
    preview: new ObjectMetaField('Preview', {
      fps: new NumberMetaField('frame rate', 30)
        .setPresets(FrameRates)
        .setRange(1),
      resolutionScale: new EnumMetaField('scale', Scales, 1),
    }),
    rendering: new ObjectMetaField('Rendering', {
      fps: new NumberMetaField('frame rate', 60)
        .setPresets(FrameRates)
        .setRange(1),
      resolutionScale: new EnumMetaField('scale', Scales, 1),
      colorSpace: new EnumMetaField('color space', ColorSpaces),
      skipWaits: new BoolMetaField('skip idle waits', false).describe(
        'Leave out the frames of top-level `waitFor` and `waitUntil` statements in which nothing moves. Only the first frame of such a wait is exported, which makes it a one-frame group when grouping by animation. A wait during which something still animates in the background is cut down to the part where things move. Waits inside other animations are never touched.',
      ),
      exporter: new ExporterMetaField('exporter', project),
    }),
  };

  meta.shared.audioOffset.disable(!project.audio);

  return meta;
}

export class ProjectMetadata extends ObjectMetaField<
  ReturnType<typeof createProjectMetadata>
> {
  public constructor(project: Project) {
    super('project', createProjectMetadata(project));
  }

  public getFullPreviewSettings(): {
    fps: number;
    resolutionScale: number;
    background: Color | null;
    range: [number, number];
    size: Vector2;
    audioOffset: number;
  } {
    return {
      ...this.shared.get(),
      ...this.preview.get(),
    };
  }

  public getFullRenderingSettings(): {
    fps: number;
    resolutionScale: number;
    colorSpace: CanvasColorSpace;
    skipWaits: boolean;
    background: Color | null;
    range: [number, number];
    size: Vector2;
    audioOffset: number;
    exporter: {
      name: string;
      options: unknown;
    };
  } {
    return {
      ...this.shared.get(),
      ...this.rendering.get(),
    };
  }
}
