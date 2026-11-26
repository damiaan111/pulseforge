// core.source.logo on the real GPU (M15): placed at a fixed size with its aspect kept, tinted,
// pulsing with the audio, and visibly wrong — never blank — when its image is missing.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import type { DecodedImage } from '../../src/engine/core/image.ts';
import type { RenderProject } from '../../src/engine/core/project.ts';
import { rational } from '../../src/engine/core/time.ts';
import { bundleElectron } from '../../spike/harness.ts';
import { renderFrames, type RenderedFrame } from '../../spike/lib/frames-run.ts';

const ELECTRON = resolve(import.meta.dirname, '..', '..', 'node_modules', 'electron', 'dist', 'electron.exe');
const available = existsSync(ELECTRON);
const ASSET = '0000000000A000000000000001';

/** 4×2 solid white, opaque: a 2:1 logo, so the aspect is visible in the result. */
const WIDE: DecodedImage = { width: 4, height: 2, pixels: new Uint8Array(4 * 2 * 4).fill(255) };
const images = new Map([['logohash', WIDE]]);

function project(params: Record<string, unknown>, withAsset = true): RenderProject {
  return {
    schemaVersion: 0,
    seed: 1,
    durationTicks: 48_000 * 2,
    canvas: { width: 200, height: 200, fps: rational(60), background: '#000000' },
    audio: { leadInTicks: 0, clipInTicks: 0 },
    layers: [{ id: 'logo', module: 'core.source.logo', enabled: true, opacity: 1, blend: 'normal', params }],
    ...(withAsset ? { assets: { [ASSET]: { kind: 'image' as const, hash: 'logohash', name: 'logo.png' } } } : {}),
  };
}

/** Width and height of the lit region, in pixels. */
function extent(frame: RenderedFrame): { width: number; height: number } {
  let minX = frame.width;
  let maxX = -1;
  let minY = frame.height;
  let maxY = -1;
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      if (frame.at(x, y).r > 40 || frame.at(x, y).g > 40 || frame.at(x, y).b > 40) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }
  return { width: maxX - minX + 1, height: maxY - minY + 1 };
}

describe.skipIf(!available)('logo layer on the GPU', () => {
  beforeAll(async () => {
    await bundleElectron();
  }, 180_000);

  it('draws at the requested width, keeping the image aspect', async () => {
    const run = await renderFrames({ name: 'logo-size', project: project({ image: ASSET, size: 0.5 }), frames: [0], images });
    const { width, height } = extent(run.frames[0]!);
    expect(run.warnings).toEqual([]);
    // 0.5 of the 200 px reference, and a 2:1 image, so 100×50 give or take a sampled edge.
    expect(Math.abs(width - 100)).toBeLessThanOrEqual(2);
    expect(Math.abs(height - 50)).toBeLessThanOrEqual(2);
  }, 180_000);

  it('tints towards the chosen colour', async () => {
    const run = await renderFrames({
      name: 'logo-tint',
      project: project({ image: ASSET, size: 0.5, tint: '#ff0000', tintAmount: 1 }),
      frames: [0],
      images,
    });
    const pixel = run.frames[0]!.at(100, 100);
    expect(pixel.r).toBeGreaterThan(200);
    expect(pixel.g).toBeLessThan(40);
  }, 180_000);

  it('pulses with the audio, and does not when the pulse is zero', async () => {
    const still = await renderFrames({ name: 'logo-still', project: project({ image: ASSET, size: 0.3, pulse: 0 }), frames: [0, 30, 60], images });
    const sizes = still.frames.map((f) => extent(f).width);
    expect(new Set(sizes).size).toBe(1);

    const pulsing = await renderFrames({
      name: 'logo-pulse',
      project: project({ image: ASSET, size: 0.3, pulse: 1, drive: 'onset' }),
      frames: [0, 5, 10, 15, 20, 25, 30, 40, 50, 60],
      images,
    });
    const widths = pulsing.frames.map((f) => extent(f).width);
    expect(Math.max(...widths)).toBeGreaterThan(Math.min(...widths));
    // Never smaller than its resting size, and never runaway.
    expect(Math.min(...widths)).toBeGreaterThanOrEqual(58); // never below its resting size
    expect(Math.max(...widths)).toBeLessThanOrEqual(92); // and never runaway
  }, 180_000);

  it('shows a placeholder and warns when the image is missing', async () => {
    const run = await renderFrames({ name: 'logo-missing', project: project({ image: ASSET, size: 0.4 }), frames: [0] });
    expect(run.warnings.some((w) => w.includes('not available'))).toBe(true);
    expect(extent(run.frames[0]!).width).toBeGreaterThan(10);
  }, 180_000);
});
