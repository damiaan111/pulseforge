// Layer opacity as a modulation target, on the real GPU (P7: the auto-director's presence curves).
//
// A solid white layer whose opacity follows a curve: invisible before its section, fading in across
// it, fully there after. Checked by pixel, so the binding is proven to reach the compositor and not
// just the evaluator.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import type { ModulationBinding } from '../../src/engine/core/modulation.ts';
import type { RenderProject } from '../../src/engine/core/project.ts';
import { rational } from '../../src/engine/core/time.ts';
import { bundleElectron } from '../../spike/harness.ts';
import { renderFrames } from '../../spike/lib/frames-run.ts';

const ELECTRON = resolve(import.meta.dirname, '..', '..', 'node_modules', 'electron', 'dist', 'electron.exe');
const available = existsSync(ELECTRON);

/** 0 until 0.5 s, then a linear fade to 1 at 1.5 s: a section entering with a one-second fade. */
const presence: ModulationBinding = {
  id: 'presence',
  enabled: true,
  source: { type: 'curve', stem: 'mix', points: [{ ticks: 24_000, value: 0 }, { ticks: 72_000, value: 1 }] },
  target: 'layers.white.opacity',
  inputRange: 'auto',
  curve: { type: 'linear', amount: 0 },
  envelope: { attackMs: 0, releaseMs: 0, mode: 'peak' },
  quantise: null,
  lookAheadMs: 0,
  // opacity × (1 + s − 1) = opacity × s
  amount: 1,
  offset: -1,
  invert: false,
  mode: 'multiply',
  order: 0,
  clampOutput: null,
};

const project: RenderProject = {
  schemaVersion: 0,
  seed: 1,
  durationTicks: 96_000,
  canvas: { width: 64, height: 36, fps: rational(10), background: '#000000' },
  audio: { leadInTicks: 0, clipInTicks: 0 },
  layers: [{ id: 'white', module: 'core.source.background', enabled: true, opacity: 1, blend: 'normal', params: { mode: 'solid', colorA: '#ffffff' } }],
  globalModulations: [presence],
};

describe.skipIf(!available)('layer opacity follows a binding', () => {
  beforeAll(async () => {
    await bundleElectron();
  }, 180_000);

  it('is invisible before its curve rises, half-way through the fade, and fully there after', async () => {
    // 10 fps: frame 2 = 0.2 s, frame 10 = 1.0 s (half-way), frame 18 = 1.8 s.
    const run = await renderFrames({ name: 'opacity-modulation', project, frames: [2, 10, 18] });
    expect(run.warnings).toEqual([]);
    const [before, middle, after] = run.frames.map((frame) => frame.at(32, 18).r);
    expect(before).toBe(0);
    expect(after).toBeGreaterThanOrEqual(250);
    // Half coverage of white over black, through the tone curve and sRGB: clearly between the two.
    expect(middle).toBeGreaterThan(60);
    expect(middle).toBeLessThan(230);
  }, 180_000);
});
