// The shape every 3D scene module shares (M37, module-spec §1 `scene3d`).
//
// A scene module is a Three.js scene plus an `update` that poses it for one frame from the
// parameters and the analysis — from scratch, every frame. Everything else is the same for every
// scene and lives here: reading the analysis, the camera rig, rendering through the shared
// renderer with its state hygiene, handing depth on, and reporting anything that went wrong.

import {
  DataTexture, FloatType, NearestFilter, PerspectiveCamera, RedFormat, type Scene,
} from 'three';
import { sampleTrack, sampleTrackInto, type SourceAnalysis } from '../../core/analysis.ts';
import { parseHexColor, srgbToLinear } from '../../core/color.ts';
import type { LayerDepth, ModuleDefinition, ModuleInstance, ModuleManifest, RenderContext } from '../../core/module.ts';
import { str, type ParamSpec, type ParamValues, type Stem } from '../../core/params.ts';
import type { FeatureUniforms } from '../analysis-texture.ts';
import { cameraPose } from './camera.ts';
import { SceneRenderer } from './host.ts';

export interface SceneFrame {
  readonly ctx: RenderContext;
  readonly params: ParamValues;
  /** Timeline seconds. */
  readonly t: number;
  /** The analysed source for the chosen stem; undefined when that stem was never analysed. */
  readonly source: SourceAnalysis | undefined;
  /** The spectrum at this frame, one value per bin (empty without analysis). */
  readonly spectrum: Float32Array;
  readonly features: FeatureUniforms;
  /** The feature the layer's `drive` parameter picks, 0..1. */
  readonly level: number;
}

export interface SceneContent {
  readonly scene: Scene;
  /** Poses the scene for this frame. Must depend only on the frame — no state from earlier frames. */
  update(frame: SceneFrame): void;
  dispose(): void;
}

export interface SceneOptions {
  /** Camera clip range in scene units; depth of field linearises depth with these. */
  readonly near?: number;
  readonly far?: number;
}

/** The parameters every scene starts with: which stem it listens to, and what drives it. */
export function reactivityParams(defaultDrive: 'beat' | 'rms' | 'onset' | 'peak' = 'rms'): ParamSpec[] {
  return [
    { key: 'source', label: 'Source', group: 'Audio', type: 'select:stem', default: 'mix' },
    {
      key: 'drive', label: 'Driven by', group: 'Audio', type: 'enum', default: defaultDrive,
      options: [
        { value: 'rms', label: 'Loudness' },
        { value: 'beat', label: 'Beat' },
        { value: 'onset', label: 'Onsets' },
        { value: 'peak', label: 'Peak' },
      ],
    },
  ];
}

const NO_FEATURES: FeatureUniforms = { rms: 0, peak: 0, onset: 0, beat: 0, centroid: 0 };

/** A colour parameter as linear RGB, which is what Three's materials take here (no colour management). */
export function linearColour(hex: string): [number, number, number] {
  const parsed = parseHexColor(hex) ?? { r: 1, g: 0, b: 1, a: 1 };
  return [srgbToLinear(parsed.r), srgbToLinear(parsed.g), srgbToLinear(parsed.b)];
}

/**
 * The spectrum as a float texture for Three's shaders: `bins` wide and `rows` tall, one row per
 * moment (a history, for scenes that lay the past out in space). Read with `texelFetch` — never
 * filtered, because float filtering is an extension (analysis-texture.ts says why that matters).
 */
export class SpectrumTexture {
  texture: DataTexture;
  private data: Float32Array;
  bins = 0;
  rows = 0;

  constructor() {
    this.data = new Float32Array(1);
    this.texture = this.create(1, 1);
  }

  /** Resizes if needed and returns the backing array to fill, row-major, bins across. */
  begin(bins: number, rows: number): Float32Array {
    const width = Math.max(1, bins);
    const height = Math.max(1, rows);
    if (width !== this.bins || height !== this.rows) {
      this.texture.dispose();
      this.data = new Float32Array(width * height);
      this.texture = this.create(width, height);
      this.bins = width;
      this.rows = height;
    }
    return this.data;
  }

  /** Marks the data for upload. Called after `begin`'s array has been filled. */
  commit(): void {
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
  }

  private create(width: number, height: number): DataTexture {
    const texture = new DataTexture(this.data, width, height, RedFormat, FloatType);
    texture.minFilter = NearestFilter;
    texture.magFilter = NearestFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    return texture;
  }
}

/**
 * GLSL for Three's shaders: the spectrum texture, and a smooth read of it at (position 0..1,
 * row). Rows are interpolated linearly, bins with a smoothstep — the same curve as the 2D
 * modules' `pf_spectrum`, so a 3D bar and a 2D bar agree about what the music is doing.
 */
export const SCENE_SPECTRUM_GLSL = /* glsl */ `
uniform sampler2D pf_spec;
uniform int pf_bins;
uniform int pf_rows;
float pf_bin(int i, int row) {
  return texelFetch(pf_spec, ivec2(clamp(i, 0, pf_bins - 1), clamp(row, 0, pf_rows - 1)), 0).r;
}
float pf_spectrumRow(float position, int row) {
  float x = clamp(position, 0.0, 1.0) * float(pf_bins - 1);
  int i = int(floor(x));
  float f = x - float(i);
  f = f * f * (3.0 - 2.0 * f);
  return mix(pf_bin(i, row), pf_bin(i + 1, row), f);
}
float pf_spectrumAt(float position, float row) {
  float r = clamp(row, 0.0, float(pf_rows - 1));
  int r0 = int(floor(r));
  return mix(pf_spectrumRow(position, r0), pf_spectrumRow(position, r0 + 1), r - float(r0));
}
`;

/** Uniform objects for `SCENE_SPECTRUM_GLSL`, kept current from a SpectrumTexture each frame. */
export function spectrumUniforms(spectrum: SpectrumTexture) {
  return {
    pf_spec: { value: spectrum.texture },
    pf_bins: { value: spectrum.bins },
    pf_rows: { value: spectrum.rows },
  };
}

export function syncSpectrumUniforms(uniforms: ReturnType<typeof spectrumUniforms>, spectrum: SpectrumTexture): void {
  uniforms.pf_spec.value = spectrum.texture;
  uniforms.pf_bins.value = spectrum.bins;
  uniforms.pf_rows.value = spectrum.rows;
}

export function scene3dModule(
  manifest: ModuleManifest,
  build: () => SceneContent,
  options: SceneOptions = {},
): ModuleDefinition {
  const near = options.near ?? 0.1;
  const far = options.far ?? 200;

  return {
    manifest,
    create(gl: WebGL2RenderingContext): ModuleInstance {
      const renderer = new SceneRenderer(gl);
      let content: SceneContent;
      try {
        content = build();
      } catch (error) {
        renderer.dispose();
        throw error;
      }
      const camera = new PerspectiveCamera(50, 1, near, far);
      let spectrum = new Float32Array(0);
      let depth: LayerDepth | null = null;

      return {
        resize() {},
        render(ctx, params) {
          const stem = str(params, 'source') as Stem;
          const source = ctx.analysis.sources.get(stem);
          let features = NO_FEATURES;
          if (source === undefined) {
            ctx.warn(`no analysis for stem "${stem}"; this layer has nothing to react to`);
            spectrum = new Float32Array(0);
          } else {
            const channels = Math.max(1, source.spectrum.channels);
            if (spectrum.length !== channels) spectrum = new Float32Array(channels);
            sampleTrackInto(source.spectrum, ctx.audioSeconds, spectrum);
            const feature = (name: string) => {
              const track = source.features.get(name);
              return track === undefined ? 0 : sampleTrack(track, ctx.audioSeconds);
            };
            features = { rms: feature('rms'), peak: feature('peak'), onset: feature('onset'), beat: feature('beat'), centroid: feature('centroid') };
          }
          const drive = str(params, 'drive');
          const level = drive === 'beat' ? features.beat : drive === 'onset' ? features.onset : drive === 'peak' ? features.peak : features.rms;

          content.update({ ctx, params, t: ctx.time.t, source, spectrum, features, level: Math.min(1, Math.max(0, level)) });

          const { width, height } = ctx.outputTarget;
          const pose = cameraPose(params, ctx.time.t, features.beat, ctx.prng, width / height);
          camera.position.set(...pose.position);
          camera.up.set(0, 1, 0);
          camera.lookAt(...pose.target);
          camera.rotateZ(pose.roll);
          camera.fov = pose.fov;
          camera.aspect = width / height;
          camera.updateProjectionMatrix();

          const result = renderer.render(content.scene, camera, ctx.outputTarget, ctx.quality);
          if (result.error !== null) ctx.warn(`${manifest.name}: ${result.error}`);
          depth = result.depth;
        },
        depth: () => depth,
        dispose() {
          content.dispose();
          renderer.dispose();
        },
      };
    },
  };
}
