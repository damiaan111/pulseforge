// Shared plumbing for spectrum-driven visualizers.
//
// Every module in the catalogue needs the same three things: the spectrum for this instant as
// something a shader can read, a few scalar features as uniforms, and the palette-aware fill
// colour in linear premultiplied form. Writing that three times would be tedious; writing it
// ten times would guarantee the tenth one drifts. So it lives here, and a new visualizer is a
// shader plus a schema (module-spec §0).
//
// The spectrum goes up as an R32F texture read with `texelFetch` — nearest, never filtered.
// Filtering float textures needs an extension that is not core WebGL2, and a module that
// silently rendered differently depending on an extension would break "same pixels everywhere".
// Shaders that want a smooth curve interpolate explicitly, which is also where they get to
// choose *how*.

import { sampleTrack, sampleTrackInto, type AnalysisSet } from '../core/analysis.ts';
import { parseHexColor, toLinearPremultiplied, type RGBA } from '../core/color.ts';
import type { RenderContext } from '../core/module.ts';
import type { Stem } from '../core/params.ts';

/** The scalar features a visualizer can react to without setting up a modulation binding. */
export interface FeatureUniforms {
  readonly rms: number;
  readonly peak: number;
  readonly onset: number;
  readonly beat: number;
  readonly centroid: number;
}

const NO_FEATURES: FeatureUniforms = { rms: 0, peak: 0, onset: 0, beat: 0, centroid: 0 };

export class AnalysisTexture {
  private readonly gl: WebGL2RenderingContext;
  private texture: WebGLTexture;
  private bins = 0;
  private scratch = new Float32Array(0);

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.texture = gl.createTexture();
  }

  /**
   * Uploads the spectrum at this frame's time and returns the features alongside it. Reports a
   * missing stem once through `ctx.warn` and leaves the texture empty rather than substituting
   * silence, because a binding on a stem that was never analysed is a mistake worth seeing.
   */
  update(ctx: RenderContext, stem: Stem, atSeconds = ctx.audioSeconds): { bins: number; features: FeatureUniforms } {
    const gl = this.gl;
    const source = ctx.analysis.sources.get(stem);
    if (source === undefined) {
      if (this.bins !== 0) {
        this.bins = 0;
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 1, 1, 0, gl.RED, gl.FLOAT, new Float32Array(1));
      }
      ctx.warn(`no analysis for stem "${stem}"; this layer has nothing to react to`);
      return { bins: 0, features: NO_FEATURES };
    }

    const track = source.spectrum;
    const channels = Math.max(1, track.channels);
    if (this.scratch.length !== channels) this.scratch = new Float32Array(channels);
    sampleTrackInto(track, atSeconds, this.scratch);

    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    if (this.bins !== channels) {
      this.bins = channels;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, channels, 1, 0, gl.RED, gl.FLOAT, this.scratch);
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, channels, 1, gl.RED, gl.FLOAT, this.scratch);
    }

    const feature = (name: string): number => {
      const found = source.features.get(name);
      return found === undefined ? 0 : sampleTrack(found, atSeconds);
    };
    return {
      bins: channels,
      features: {
        rms: feature('rms'),
        peak: feature('peak'),
        onset: feature('onset'),
        beat: feature('beat'),
        centroid: feature('centroid'),
      },
    };
  }

  bindTo(unit: number): void {
    this.gl.activeTexture(this.gl.TEXTURE0 + unit);
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.texture);
  }

  dispose(): void {
    this.gl.deleteTexture(this.texture);
  }
}

/** A colour parameter as the compositor wants it: linear light, premultiplied alpha. */
export function fillColour(hex: string, opacity = 1): RGBA {
  const parsed = parseHexColor(hex) ?? { r: 1, g: 0, b: 1, a: 1 };
  return toLinearPremultiplied({ ...parsed, a: parsed.a * opacity });
}

/**
 * Shared GLSL: reading the spectrum texture, and the smooth interpolation most curve-shaped
 * modules want. Declared once so every module samples the analysis the same way.
 */
export const SPECTRUM_GLSL = /* glsl */ `
uniform sampler2D u_spectrum;
uniform int u_bins;

float pf_bin(int index) {
  if (u_bins <= 0) return 0.0;
  return texelFetch(u_spectrum, ivec2(clamp(index, 0, u_bins - 1), 0), 0).r;
}

/** Spectrum at a fractional position in 0..1, smoothly interpolated. */
float pf_spectrum(float position) {
  if (u_bins <= 0) return 0.0;
  float x = clamp(position, 0.0, 1.0) * float(u_bins - 1);
  int i = int(floor(x));
  float f = x - float(i);
  // Smoothstep between bins: linear interpolation makes a visibly faceted curve at low
  // bin counts, which is exactly where these modules are usually run.
  f = f * f * (3.0 - 2.0 * f);
  return mix(pf_bin(i), pf_bin(i + 1), f);
}
`;

/** True when the set has anything at all — used to keep "no audio" from looking like a bug. */
export function hasAnalysis(analysis: AnalysisSet): boolean {
  return analysis.sources.size > 0;
}
