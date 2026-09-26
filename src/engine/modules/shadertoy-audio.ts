// Shadertoy's audio input, for Shadertoy-dialect drop-in shaders (S2).
//
// On shadertoy.com a music input is a 512×2 texture: row 0 is the spectrum (512 bins on a linear
// axis from 0 to ~11 kHz, dB-mapped to 0..1), row 1 the waveform (0.5 is silence). Shaders read it
// with `texture(iChannel0, vec2(x, 0.25))` for the spectrum and `vec2(x, 0.75)` for the wave.
//
// Pulseforge's analysis has the spectrum (64 log-spaced bins, 30 Hz–16 kHz, dB-mapped the same way),
// so row 0 is that spectrum resampled onto Shadertoy's linear axis — pure arithmetic on fixed
// constants, so the same analysis gives the same texture everywhere. The analysis keeps no
// per-frame waveform, so row 1 is flat 0.5 — documented in the authoring guide rather than faked.
// R8 with linear filtering: Shadertoy shaders sample it filtered, and 8-bit is what they expect.

import { sampleTrackInto } from '../core/analysis.ts';
import type { RenderContext } from '../core/module.ts';

/** Columns on Shadertoy's audio texture, and the frequency its last column stands for. */
export const SHADERTOY_AUDIO_WIDTH = 512;
const SHADERTOY_TOP_HZ = 11_025;
/** Pulseforge's spectrum range (DEFAULT_SPECTRUM_SETTINGS; not per project). */
const MIN_HZ = 30;
const MAX_HZ = 16_000;

/**
 * Row 0: Shadertoy's linear frequency axis sampled from log-spaced bins. Below the lowest analysed
 * frequency the first bin holds; between bins, linear interpolation. Pure, for the tests.
 */
export function shadertoySpectrumRow(bins: Float32Array, out: Uint8Array = new Uint8Array(SHADERTOY_AUDIO_WIDTH)): Uint8Array {
  const n = bins.length;
  for (let i = 0; i < SHADERTOY_AUDIO_WIDTH; i += 1) {
    if (n === 0) {
      out[i] = 0;
      continue;
    }
    const hz = ((i + 0.5) / SHADERTOY_AUDIO_WIDTH) * SHADERTOY_TOP_HZ;
    // Bin b covers [MIN·r^b, MIN·r^(b+1)) with r = (MAX/MIN)^(1/n); its centre is at b + 0.5.
    const position = hz <= MIN_HZ ? 0 : (Math.log(hz / MIN_HZ) / Math.log(MAX_HZ / MIN_HZ)) * n - 0.5;
    const clamped = Math.min(n - 1, Math.max(0, position));
    const lo = Math.floor(clamped);
    const hi = Math.min(n - 1, lo + 1);
    const f = clamped - lo;
    const value = (bins[lo] as number) * (1 - f) + (bins[hi] as number) * f;
    out[i] = Math.round(Math.min(1, Math.max(0, value)) * 255);
  }
  return out;
}

export class ShadertoyAudioTexture {
  private readonly gl: WebGL2RenderingContext;
  readonly texture: WebGLTexture;
  private readonly pixels = new Uint8Array(SHADERTOY_AUDIO_WIDTH * 2);
  private scratch = new Float32Array(0);

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.texture = gl.createTexture();
    this.pixels.fill(128, SHADERTOY_AUDIO_WIDTH);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, SHADERTOY_AUDIO_WIDTH, 2, 0, gl.RED, gl.UNSIGNED_BYTE, this.pixels);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /** Row 0 from the stem's spectrum at this frame; silence (and row 1 at 0.5) without one. */
  update(ctx: RenderContext, stem: string): void {
    const source = ctx.analysis.sources.get(stem as never);
    const row = this.pixels.subarray(0, SHADERTOY_AUDIO_WIDTH);
    if (source === undefined) {
      row.fill(0);
    } else {
      const channels = Math.max(1, source.spectrum.channels);
      if (this.scratch.length !== channels) this.scratch = new Float32Array(channels);
      sampleTrackInto(source.spectrum, ctx.audioSeconds, this.scratch);
      shadertoySpectrumRow(this.scratch, row);
    }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SHADERTOY_AUDIO_WIDTH, 1, gl.RED, gl.UNSIGNED_BYTE, row);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  dispose(): void {
    this.gl.deleteTexture(this.texture);
  }
}
