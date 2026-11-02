// Shadertoy-dialect shaders on the GPU (S2): `mainImage` runs with Shadertoy's coordinates (origin
// bottom-left) and colours (display-referred, decoded to linear), `iTime` is the timeline's time,
// `iChannel0` is Shadertoy's audio texture with the spectrum on a linear frequency axis, a render is
// repeatable, and a compile error names the author's own line.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import type { AnyLayerSpec, RenderProject } from '../../src/engine/core/project.ts';
import { rational } from '../../src/engine/core/time.ts';
import { shadertoyFileSource, type ShaderModuleSource } from '../../src/engine/modules/shader-module.ts';
import { bundleElectron } from '../../spike/harness.ts';
import { renderFrames } from '../../spike/lib/frames-run.ts';

const ELECTRON = resolve(import.meta.dirname, '..', '..', 'node_modules', 'electron', 'dist', 'electron.exe');
const available = existsSync(ELECTRON);
const W = 200;
const H = 100;

/** Red follows x, green follows y (so up is up), blue is iTime's fraction. */
const GRADIENT = shadertoyFileSource('Gradient.glsl', `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  fragColor = vec4(uv.x, uv.y, fract(iTime), 1.0);
}
`);

/** The audio texture: brightness of the spectrum at 1 kHz (left half) and at 8 kHz (right half). */
const AUDIO = shadertoyFileSource('Audio.glsl', `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  float x = fragCoord.x < iResolution.x * 0.5 ? 1000.0 / 11025.0 : 8000.0 / 11025.0;
  float fft = texture(iChannel0, vec2(x, 0.25)).x;
  float wave = texture(iChannel0, vec2(0.5, 0.75)).x;
  fragColor = vec4(fft, wave, 0.0, 1.0);
}
`);

/** Hands its input back untouched, as an effect, so anything but the same picture is the wrapper's doing. */
const PASS_THROUGH: ShaderModuleSource = {
  manifest: { id: 'user.shadertoy.pass', version: '1', kind: 'effect', name: 'Pass', dialect: 'shadertoy', channels: ['input'] },
  shader: `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  fragColor = texture(iChannel0, fragCoord / iResolution.xy);
}
`,
  origin: 'Pass.glsl',
};

/** Line 3 has a type error. */
const BROKEN = shadertoyFileSource('Broken.glsl', `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  float ok = 1.0;
  vec2 wrong = 3.0 * true;
  fragColor = vec4(ok);
}
`);

const layer = (source: ShaderModuleSource): AnyLayerSpec => ({
  id: `layer-${source.manifest.id}`, module: source.manifest.id, enabled: true, opacity: 1, blend: 'normal', params: {},
});

function project(layers: readonly AnyLayerSpec[]): RenderProject {
  return {
    schemaVersion: 0, seed: 3, durationTicks: 48_000 * 2,
    canvas: { width: W, height: H, fps: rational(10), background: '#000000' },
    audio: { leadInTicks: 0, clipInTicks: 0 },
    layers,
  };
}

/** Two seconds of a 1 kHz sine: loud at 1 kHz, silent at 8 kHz. */
const SINE = Float32Array.from({ length: 96_000 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 1000 * i) / 48_000));

describe.skipIf(!available)('Shadertoy shaders on the GPU', () => {
  beforeAll(async () => {
    await bundleElectron();
  }, 180_000);

  it('coordinates, colour and iTime as on Shadertoy, repeatably', async () => {
    const [run, again] = await Promise.all([
      renderFrames({ name: 'st-gradient', project: project([layer(GRADIENT)]), frames: [5], modules: [GRADIENT] }),
      renderFrames({ name: 'st-gradient-2', project: project([layer(GRADIENT)]), frames: [5], modules: [GRADIENT] }),
    ]);
    expect(run.warnings).toEqual([]);
    const frame = run.frames[0]!;
    // Shadertoy's 0.5 is a display value: it must come out as the display value 0.5 (≈128).
    const middle = frame.at(W / 2, H / 2);
    expect(Math.abs(middle.r - 128)).toBeLessThanOrEqual(3);
    // Up is up: the top row is green, the bottom row is not.
    expect(frame.at(W / 2, 1).g).toBeGreaterThan(240);
    expect(frame.at(W / 2, H - 2).g).toBeLessThan(10);
    // iTime at frame 5 of 10 fps is 0.5.
    expect(Math.abs(middle.b - 128)).toBeLessThanOrEqual(3);
    expect(again.frames[0]!.sha256).toBe(frame.sha256);
  }, 180_000);

  it('iChannel0 is the audio texture: the spectrum on a linear axis, the wave row at rest', async () => {
    const run = await renderFrames({ name: 'st-audio', project: project([layer(AUDIO)]), frames: [10], modules: [AUDIO], pcm: SINE });
    expect(run.warnings).toEqual([]);
    const frame = run.frames[0]!;
    const at1k = frame.at(W / 4, H / 2);
    const at8k = frame.at((3 * W) / 4, H / 2);
    expect(at1k.r).toBeGreaterThan(150);
    expect(at8k.r).toBeLessThan(60);
    // Row 1 (the waveform) is not available from the analysis: flat 0.5, as Shadertoy's silence.
    expect(Math.abs(at1k.g - 128)).toBeLessThanOrEqual(3);
  }, 180_000);

  it('the input channel is display colour, read once: mid-grey comes back as mid-grey', async () => {
    const grey: AnyLayerSpec = {
      id: 'grey', module: 'core.source.background', enabled: true, opacity: 1, blend: 'normal', params: { mode: 'solid', colorA: '#808080' },
      effects: [{ id: 'fx', module: PASS_THROUGH.manifest.id, enabled: true, params: {} }],
    };
    const run = await renderFrames({ name: 'st-input', project: project([grey]), frames: [0], modules: [PASS_THROUGH] });
    const middle = run.frames[0]!.at(W / 2, H / 2);
    expect(run.warnings).toEqual([]);
    expect(Math.abs(middle.r - 128)).toBeLessThanOrEqual(1);
    expect(Math.abs(middle.g - 128)).toBeLessThanOrEqual(1);
    expect(Math.abs(middle.b - 128)).toBeLessThanOrEqual(1);
  }, 180_000);

  it('a compile error names the author’s own line, and the layer is skipped', async () => {
    const run = await renderFrames({ name: 'st-broken', project: project([layer(GRADIENT), layer(BROKEN)]), frames: [0], modules: [GRADIENT, BROKEN] });
    const warning = run.warnings.find((w) => w.includes(BROKEN.manifest.id));
    expect(warning).toBeDefined();
    expect(warning).toMatch(/:3\b/);
    expect(run.frames[0]!.at(W / 2, 1).g).toBeGreaterThan(240);
  }, 180_000);
});
