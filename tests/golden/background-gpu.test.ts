// core.source.background on the real GPU (M14): solid, gradient in linear light, image fit
// modes with the right way up, and a missing image that is visibly wrong rather than black.

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

/** 2×2, top row red | blue, bottom row green | white. Straight RGBA8, top row first. */
const QUAD: DecodedImage = {
  width: 2,
  height: 2,
  pixels: new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255, 0, 255, 0, 255, 255, 255, 255, 255]),
};

function project(params: Record<string, unknown>, withAsset = true): RenderProject {
  return {
    schemaVersion: 0,
    seed: 1,
    durationTicks: 48_000,
    canvas: { width: 320, height: 180, fps: rational(60), background: '#000000' },
    audio: { leadInTicks: 0, clipInTicks: 0 },
    layers: [{ id: 'bg', module: 'core.source.background', enabled: true, opacity: 1, blend: 'normal', params }],
    ...(withAsset ? { assets: { img: { kind: 'image' as const, hash: 'quad', name: 'quad.png' } } } : {}),
  };
}

async function one(name: string, params: Record<string, unknown>, images?: ReadonlyMap<string, DecodedImage>) {
  const run = await renderFrames({ name: `bg-${name}`, project: project(params), frames: [0], ...(images === undefined ? {} : { images }) });
  return { frame: run.frames[0] as RenderedFrame, warnings: run.warnings };
}

// Full-scale primaries pass through the D48 tone shoulder (knee 0.9), which lands 255 on ~251 and
// bleeds a little into the other channels — so image checks allow for that, solids stay tight.
const near = (actual: { r: number; g: number; b: number }, expected: [number, number, number], tolerance = 14) => {
  expect(Math.abs(actual.r - expected[0])).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual.g - expected[1])).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual.b - expected[2])).toBeLessThanOrEqual(tolerance);
};

describe.skipIf(!available)('background module on the GPU', () => {
  beforeAll(async () => {
    await bundleElectron();
  }, 180_000);

  it('solid fills with the colour', async () => {
    const { frame } = await one('solid', { mode: 'solid', colorA: '#336699' });
    near(frame.at(10, 10), [0x33, 0x66, 0x99], 2);
    near(frame.at(300, 170), [0x33, 0x66, 0x99], 2);
  }, 180_000);

  it('a linear gradient interpolates in linear light, left to right at 0°', async () => {
    const { frame } = await one('gradient', { mode: 'gradient', colorA: '#000000', colorB: '#ffffff', angle: 0 });
    // 2.5 px in is linear 0.008, which sRGB encodes to ~22 — the curve is steep near black.
    expect(frame.at(2, 90).r).toBeLessThan(30);
    expect(frame.at(317, 90).r).toBeGreaterThan(240);
    // Linear 0.5 encodes to sRGB ≈ 188; an sRGB-space mix would give 128.
    expect(Math.abs(frame.at(160, 90).r - 188)).toBeLessThanOrEqual(4);
  }, 180_000);

  it('stretch shows the image the right way up and the right way round', async () => {
    const { frame, warnings } = await one('stretch', { mode: 'image', image: 'img', fit: 'stretch' }, new Map([['quad', QUAD]]));
    near(frame.at(40, 45), [255, 0, 0]);
    near(frame.at(280, 45), [0, 0, 255]);
    near(frame.at(40, 135), [0, 255, 0]);
    near(frame.at(280, 135), [255, 255, 255]);
    expect(warnings.filter((w) => w.startsWith('background'))).toEqual([]);
  }, 180_000);

  it('contain letterboxes a wide image with the base colour', async () => {
    const wide: DecodedImage = { width: 4, height: 1, pixels: new Uint8Array(16).fill(255) };
    const { frame } = await one('contain', { mode: 'image', image: 'img', fit: 'contain', colorA: '#000000' }, new Map([['quad', wide]]));
    near(frame.at(160, 90), [255, 255, 255]);
    near(frame.at(160, 3), [0, 0, 0]); // 4:1 in 16:9 leaves bars above and below
  }, 180_000);

  it('a missing image draws the checkerboard and says so', async () => {
    const { frame, warnings } = await one('missing', { mode: 'image', image: 'img', fit: 'cover' });
    expect(warnings.some((w) => w.includes('not available'))).toBe(true);
    const lum = (x: number, y: number) => frame.at(x, y).r;
    const values = new Set([lum(5, 5), lum(20, 5), lum(5, 20), lum(20, 20)]);
    expect(values.size).toBeGreaterThan(1); // not flat black
  }, 180_000);

  it('drift is deterministic in time and never reveals the edge', async () => {
    const images = new Map([['quad', QUAD]]);
    const params = { mode: 'image', image: 'img', fit: 'cover', drift: 1, driftSeconds: 4 };
    const [a, b] = await Promise.all([
      renderFrames({ name: 'bg-drift-a', project: project(params), frames: [0, 90], images }),
      renderFrames({ name: 'bg-drift-b', project: project(params), frames: [90, 0], images }),
    ]);
    const byIndex = (run: { frames: readonly RenderedFrame[] }) => Object.fromEntries(run.frames.map((f) => [f.frameIndex, f.sha256]));
    expect(byIndex(b)).toEqual(byIndex(a));
    expect(byIndex(a)[0]).not.toEqual(byIndex(a)[90]);
  }, 180_000);
});
