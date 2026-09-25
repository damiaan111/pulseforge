// Keyframes on the real GPU (S1): a parameter, the opacity and the transform of a layer each follow
// their track, and a modulation still rides on top of a keyed value (module-spec §5 step 3 then 4).

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import type { AutomationTrackSpec } from '../../src/engine/core/automation.ts';
import type { RenderProject } from '../../src/engine/core/project.ts';
import { rational } from '../../src/engine/core/time.ts';
import { bundleElectron } from '../../spike/harness.ts';
import { renderFrames } from '../../spike/lib/frames-run.ts';

const ELECTRON = resolve(import.meta.dirname, '..', '..', 'node_modules', 'electron', 'dist', 'electron.exe');
const available = existsSync(ELECTRON);
const S = 48_000;

function project(automation: AutomationTrackSpec[]): RenderProject {
  return {
    schemaVersion: 0,
    seed: 1,
    durationTicks: 3 * S,
    canvas: { width: 64, height: 36, fps: rational(10), background: '#000000' },
    audio: { leadInTicks: 0, clipInTicks: 0 },
    layers: [{
      id: 'box', module: 'core.source.background', enabled: true, opacity: 1, blend: 'normal', params: { mode: 'solid', colorA: '#ffffff' },
      transform: { x: 0.5, y: 0.5, scaleX: 0.25, scaleY: 1, rotationDeg: 0, skewXDeg: 0, skewYDeg: 0, anchor: 'center', scaleReference: 'max' },
    }],
    automation,
  };
}

describe.skipIf(!available)('keyframes drive the render', () => {
  beforeAll(async () => {
    await bundleElectron();
  }, 180_000);

  it('a colour key, an opacity key and a moving transform, each at its time', async () => {
    const run = await renderFrames({
      name: 'keyframes',
      project: project([
        // Red at 0 s, blue at 2 s (hold after).
        { id: 'c', target: 'layers.box.params.colorA', keyframes: [{ ticks: 0, value: '#ff0000', easing: 'linear' }, { ticks: 2 * S, value: '#0000ff', easing: 'linear' }] },
        // The quarter-width box slides from the left edge to the right edge.
        { id: 'x', target: 'layers.box.transform.x', keyframes: [{ ticks: 0, value: 0.125, easing: 'linear' }, { ticks: 2 * S, value: 0.875, easing: 'linear' }] },
        // Visible, then gone after 2.5 s (hold).
        { id: 'o', target: 'layers.box.opacity', keyframes: [{ ticks: 0, value: 1, easing: 'hold' }, { ticks: 2.5 * S, value: 0, easing: 'linear' }] },
      ]),
      frames: [0, 20, 28],
    });
    expect(run.warnings).toEqual([]);
    const [start, end, gone] = run.frames;
    // 0 s: red, on the left.
    // Full channels come out a few codes under 255 through the tone curve's shoulder (D48).
    expect(start!.at(8, 18).r).toBeGreaterThan(240);
    expect(start!.at(8, 18).b).toBeLessThan(5);
    expect(start!.at(56, 18).r).toBeLessThan(5);
    // 2 s: blue, on the right.
    expect(end!.at(56, 18).b).toBeGreaterThan(240);
    expect(end!.at(56, 18).r).toBeLessThan(5);
    expect(end!.at(8, 18).b).toBeLessThan(5);
    // 2.8 s: faded out by its opacity key.
    expect(gone!.at(56, 18).b).toBeLessThan(5);
  }, 180_000);
});
