// Spatial supersampling (export-spec §9): the same picture, with softer edges, and deterministic.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import type { RenderProject } from '../../src/engine/core/project.ts';
import { rational } from '../../src/engine/core/time.ts';
import { DEFAULT_FONT_FILE } from '../../setup/lib/paths.ts';
import { bundleElectron } from '../../spike/harness.ts';
import { renderFrames, type RenderedFrame } from '../../spike/lib/frames-run.ts';

const ELECTRON = resolve(import.meta.dirname, '..', '..', 'node_modules', 'electron', 'dist', 'electron.exe');
const available = existsSync(ELECTRON) && existsSync(DEFAULT_FONT_FILE);

const project: RenderProject = {
  schemaVersion: 0,
  seed: 3,
  durationTicks: 48_000 * 4,
  canvas: { width: 320, height: 180, fps: rational(60), background: '#000000' },
  audio: { leadInTicks: 0, clipInTicks: 0 },
  layers: [{
    id: 't', module: 'core.text.title', enabled: true, opacity: 1, blend: 'normal',
    params: { text: 'THIN LINES', shadow: 0, animIn: 'none', animOut: 'none' },
    timeRange: { inTicks: 0, outTicks: null },
  }],
};

/** How many pixels sit between black and white: the edge softness of white text on black. */
function greys(frame: RenderedFrame): number {
  let count = 0;
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      const { r } = frame.at(x, y);
      if (r > 30 && r < 225) count += 1;
    }
  }
  return count;
}

function difference(a: RenderedFrame, b: RenderedFrame): number {
  let total = 0;
  for (let y = 0; y < a.height; y += 1) for (let x = 0; x < a.width; x += 1) total += Math.abs(a.at(x, y).r - b.at(x, y).r);
  return total / (a.width * a.height);
}

describe.skipIf(!available)('supersampling', () => {
  beforeAll(async () => {
    await bundleElectron();
  }, 180_000);

  it('draws the same picture at the output size, deterministically', async () => {
    const [plain, once, twice] = await Promise.all([
      renderFrames({ name: 'ss-plain', project, frames: [30] }),
      renderFrames({ name: 'ss-a', project, frames: [30], supersample: 2 }),
      renderFrames({ name: 'ss-b', project, frames: [30], supersample: 2 }),
    ]);
    const a = plain.frames[0] as RenderedFrame;
    const b = once.frames[0] as RenderedFrame;
    expect(once.warnings).toEqual([]);
    expect([b.width, b.height]).toEqual([320, 180]);
    expect((twice.frames[0] as RenderedFrame).sha256).toBe(b.sha256);
    expect(b.sha256).not.toBe(a.sha256);
    expect(difference(a, b)).toBeLessThan(6);
  }, 180_000);

  it('works under motion blur, whose sum cannot be filtered', async () => {
    const run = await renderFrames({ name: 'ss-blur', project, frames: [30], supersample: 2, motionBlur: { samples: 4, shutterDegrees: 180 } });
    expect(run.warnings).toEqual([]);
    expect(greys(run.frames[0] as RenderedFrame)).toBeGreaterThan(50);
  }, 180_000);
});
