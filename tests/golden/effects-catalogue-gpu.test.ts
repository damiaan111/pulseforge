// Every effect in the catalogue, on the real GPU.
//
// Distinct from effects-gpu.test.ts, which checks the *chain* — ordering, bloom's spread,
// resolution independence — against measured pixels. This one is breadth: it walks the whole
// catalogue so adding an effect cannot mean adding an untested one.
//
// It is the companion to modules-gpu.test.ts, and it has to ask a different question. A visualizer
// fails visibly when its shader is wrong: nothing is drawn. An effect fails *invisibly* — the
// chain still hands the layer through, and a broken effect looks exactly like an effect at
// default settings. So each one here is applied to a known layer and must **change the frame**
// as well as compile, and must produce the same change twice.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { BUILTIN_MODULES } from '../../src/engine/engine.ts';
import type { RenderProject } from '../../src/engine/core/project.ts';
import { rational } from '../../src/engine/core/time.ts';
import { bundleElectron } from '../../spike/harness.ts';
import { renderFrames, type RenderedFrame } from '../../spike/lib/frames-run.ts';

const ELECTRON = resolve(import.meta.dirname, '..', '..', 'node_modules', 'electron', 'dist', 'electron.exe');
const available = existsSync(ELECTRON);

const EFFECTS = BUILTIN_MODULES.filter((m) => m.manifest.kind === 'effect').map((m) => m.manifest.id);

/**
 * Settings that make each effect visible at its own defaults' scale. Left empty an effect might
 * legitimately be a near no-op — `glitch` with no burst, `grade` with neutral tone — and the
 * "it changed something" assertion would be testing nothing.
 */
const VISIBLE_SETTINGS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  'core.effect.bloom': { intensity: 2, threshold: 0.2 },
  'core.effect.vignette': { amount: 1, radius: 0.2 },
  'core.effect.blur': { radius: 0.05 },
  'core.effect.grade': { exposure: 1.5, saturation: 0, contrast: 1.8 },
  'core.effect.chromatic': { amount: 0.03, falloff: 0 },
  'core.effect.grain': { amount: 0.4, size: 3 },
  'core.effect.pixelate': { size: 0.06 },
  'core.effect.scanlines': { lines: 40, depth: 1 },
  // Rotation aims the mirrored wedge; bars draw along the bottom of the frame.
  'core.effect.kaleidoscope': { segments: 5, zoom: 0.6, rotation: -90 },
  'core.effect.glitch': { amount: 1, density: 1, displace: 0.3 },
  // Focused just in front of the camera, so the whole scene behind it is thrown out of focus.
  'core.effect.dof': { focus: 2, range: 0, amount: 1 },
};

const NEEDS_DEPTH = new Set(BUILTIN_MODULES.filter((m) => m.manifest.capabilities.needsDepth === true).map((m) => m.manifest.id));

/** Depth effects run only on 3D scene layers (D18), so they get a scene to act on. */
function hostFor(effectId: string | null): string {
  return effectId !== null && NEEDS_DEPTH.has(effectId) ? 'core.scene3d.city' : 'core.visualizer.bars';
}

/** A layer with enough structure that any of these effects has something to act on. */
function projectFor(effectId: string | null, host = hostFor(effectId)): RenderProject {
  return {
    schemaVersion: 0,
    seed: 4242,
    durationTicks: 48_000 * 2,
    canvas: { width: 320, height: 180, fps: rational(60), background: '#000000' },
    audio: { leadInTicks: 0, clipInTicks: 0 },
    layers: [{
      id: 'v',
      module: host,
      enabled: true,
      opacity: 1,
      blend: 'normal',
      params: {},
      ...(effectId === null ? {} : {
        effects: [{ id: 'fx', module: effectId, enabled: true, params: VISIBLE_SETTINGS[effectId] ?? {} }],
      }),
    }],
  };
}

describe.skipIf(!available)('every effect renders on the GPU', () => {
  /** The host layer with no effect, per host module. */
  const plain = new Map<string, RenderedFrame>();

  beforeAll(async () => {
    await bundleElectron();
    for (const host of new Set(EFFECTS.map(hostFor))) {
      const run = await renderFrames({ name: `fx-plain-${host.replace(/\W+/g, '-')}`, project: projectFor(null, host), frames: [40] });
      plain.set(host, run.frames[0] as RenderedFrame);
    }
  }, 300_000);

  it('has the effects the catalogue claims', () => {
    // M12 asks for ten.
    expect(EFFECTS.length).toBeGreaterThanOrEqual(10);
  });

  it('declares visible settings for every effect', () => {
    // Without this the list and the table drift apart and an effect quietly stops being tested.
    expect(EFFECTS.filter((id) => VISIBLE_SETTINGS[id] === undefined)).toEqual([]);
  });

  it.each(EFFECTS)('%s compiles and changes the frame', async (effectId) => {
    const name = effectId.replace(/\W+/g, '-');
    const run = await renderFrames({ name: `fx-${name}`, project: projectFor(effectId), frames: [40] });
    const frame = run.frames[0] as RenderedFrame;
    expect(run.warnings.filter((w) => w.includes('no input texture') || w.includes('is not applied'))).toEqual([]);
    expect(frame.sha256).not.toEqual(plain.get(hostFor(effectId))?.sha256);
    // Not just *different*: an effect that blanked the frame would also differ.
    expect(litFraction(frame)).toBeGreaterThan(0.002);
  }, 180_000);

  it.each(EFFECTS)('%s is deterministic', async (effectId) => {
    const name = effectId.replace(/\W+/g, '-');
    const [a, b] = await Promise.all([
      renderFrames({ name: `fxdet-a-${name}`, project: projectFor(effectId), frames: [12, 40] }),
      renderFrames({ name: `fxdet-b-${name}`, project: projectFor(effectId), frames: [40, 12] }),
    ]);
    const byIndex = (run: { frames: readonly RenderedFrame[] }) =>
      Object.fromEntries(run.frames.map((f) => [f.frameIndex, f.sha256]));
    expect(byIndex(b)).toEqual(byIndex(a));
  }, 180_000);
});

function litFraction(frame: RenderedFrame): number {
  let count = 0;
  for (let i = 0; i < frame.pixels.length; i += 4) {
    if ((frame.pixels[i] ?? 0) + (frame.pixels[i + 1] ?? 0) + (frame.pixels[i + 2] ?? 0) > 24) count += 1;
  }
  return count / (frame.width * frame.height);
}
