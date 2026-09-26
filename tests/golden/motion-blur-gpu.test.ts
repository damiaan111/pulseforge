// Motion blur on the real GPU (S10, export-spec §9): a moving box is smeared across the shutter,
// evenly either side of where it is at the frame's time; the result is repeatable; and a picture
// that does not move comes out byte-identical to the unblurred one.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import type { AutomationTrackSpec } from '../../src/engine/core/automation.ts';
import type { RenderProject } from '../../src/engine/core/project.ts';
import { MOTION_BLUR_DEFAULT, rational } from '../../src/engine/core/time.ts';
import { bundleElectron } from '../../spike/harness.ts';
import { renderFrames } from '../../spike/lib/frames-run.ts';

const ELECTRON = resolve(import.meta.dirname, '..', '..', 'node_modules', 'electron', 'dist', 'electron.exe');
const available = existsSync(ELECTRON);
const S = 48_000;

/** An 8 px white box on a 64 px frame; keyed, it crosses the frame in 0.5 s (128 px/s). */
function project(moving: boolean): RenderProject {
  const automation: AutomationTrackSpec[] = moving
    ? [{ id: 'x', target: 'layers.box.transform.x', keyframes: [{ ticks: 0, value: 0, easing: 'linear' }, { ticks: S / 2, value: 1, easing: 'linear' }] }]
    : [];
  return {
    schemaVersion: 0,
    seed: 1,
    durationTicks: S,
    canvas: { width: 64, height: 36, fps: rational(10), background: '#000000' },
    audio: { leadInTicks: 0, clipInTicks: 0 },
    layers: [{
      id: 'box', module: 'core.source.background', enabled: true, opacity: 1, blend: 'normal', params: { mode: 'solid', colorA: '#ffffff' },
      transform: { x: 0.4, y: 0.5, scaleX: 0.125, scaleY: 1, rotationDeg: 0, skewXDeg: 0, skewYDeg: 0, anchor: 'center', scaleReference: 'max' },
    }],
    automation,
  };
}

describe.skipIf(!available)('motion blur on the GPU', () => {
  beforeAll(async () => {
    await bundleElectron();
  }, 180_000);

  it('smears a moving box across the shutter, symmetrically, and repeatably', async () => {
    const [sharp, blurred, again] = await Promise.all([
      renderFrames({ name: 'blur-off', project: project(true), frames: [2] }),
      renderFrames({ name: 'blur-on', project: project(true), frames: [2], motionBlur: MOTION_BLUR_DEFAULT }),
      renderFrames({ name: 'blur-again', project: project(true), frames: [2], motionBlur: MOTION_BLUR_DEFAULT }),
    ]);
    for (const run of [sharp, blurred, again]) expect(run.warnings).toEqual([]);
    const off = sharp.frames[0]!;
    const on = blurred.frames[0]!;
    // At 0.2 s the box is centred on x = 25.6 px, covering 21.6–29.6. A 180° shutter at 10 fps is
    // open for 0.05 s, 6.4 px of travel: the blurred box reaches from 18.4 to 32.8.
    expect(off.at(25, 18).r).toBeGreaterThan(240);
    expect(off.at(19, 18).r).toBeLessThan(5);
    expect(off.at(31, 18).r).toBeLessThan(5);
    expect(on.at(25, 18).r).toBeGreaterThan(240);
    // Pixel centres 20.5 and 30.5 sit the same distance either side of the box's centre.
    const lead = on.at(30, 18).r;
    const trail = on.at(20, 18).r;
    expect(lead).toBeGreaterThan(20);
    expect(lead).toBeLessThan(235);
    expect(trail).toBeGreaterThan(20);
    expect(trail).toBeLessThan(235);
    // Centred on the frame's time: as much smear ahead of the box as behind it.
    expect(Math.abs(lead - trail)).toBeLessThanOrEqual(2);
    // Outside the shutter's reach, nothing.
    expect(on.at(16, 18).r).toBeLessThan(5);
    expect(on.at(35, 18).r).toBeLessThan(5);
    expect(again.frames[0]!.sha256).toBe(on.sha256);
  }, 180_000);

  it('leaves a still picture exactly as it was', async () => {
    const [off, on] = await Promise.all([
      renderFrames({ name: 'still-off', project: project(false), frames: [0, 5] }),
      renderFrames({ name: 'still-on', project: project(false), frames: [0, 5], motionBlur: MOTION_BLUR_DEFAULT }),
    ]);
    // Eight equal weights of 1/8 sum exactly in float32, so a static frame's bytes do not move.
    expect(on.frames.map((f) => f.sha256)).toEqual(off.frames.map((f) => f.sha256));
  }, 180_000);
});
