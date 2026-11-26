// The effect chain on the real GPU (module-spec §8, compositor-spec §1 step 3).
//
// Three things worth checking against pixels rather than reasoning:
//  - the chain runs in order, and each pass sees the previous one's output;
//  - bloom spreads light *outside* the bright source, which is the whole point of it;
//  - the blur radius follows the canvas reference size, so a 4K render is not a thinner,
//    weaker version of the 1080p one (module-spec §6).

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { EffectSpec, RenderProject } from '../../src/engine/core/project.ts';
import { IDENTITY_LAYER_TRANSFORM } from '../../src/engine/core/layout.ts';
import { rational } from '../../src/engine/core/time.ts';
import { bundleElectron } from '../../spike/harness.ts';
import { renderFrames, type RenderedFrame } from '../../spike/lib/frames-run.ts';

const ELECTRON = resolve(import.meta.dirname, '..', '..', 'node_modules', 'electron', 'dist', 'electron.exe');
const available = existsSync(ELECTRON);

/**
 * A small white square in the middle of a black frame: the simplest thing that makes a glow's
 * spread measurable, because every lit pixel outside the square came from the effect.
 */
const SQUARE = 0.12;

function squareProject(effects: readonly EffectSpec[], size = { width: 320, height: 180 }): RenderProject {
  return {
    schemaVersion: 0,
    seed: 1,
    canvas: { width: size.width, height: size.height, fps: rational(60), background: '#000000' },
    audio: { leadInTicks: 0, clipInTicks: 0 },
    layers: [{
      id: 'square',
      module: 'core.visualizer.bars',
      enabled: true,
      opacity: 1,
      blend: 'normal',
      // One fat, full-height bar in the middle, at full brightness: a bright block to bloom.
      params: {
        source: 'mix', barCount: 8, barWidth: 1, spread: SQUARE, baseline: 0.75,
        minHeight: 0.5, maxHeight: 0.5, fill: '#ffffff',
      },
      transform: IDENTITY_LAYER_TRANSFORM,
      effects,
    }],
  };
}

const bloom = (params: Record<string, unknown> = {}): EffectSpec => ({
  id: 'bloom1',
  module: 'core.effect.bloom',
  enabled: true,
  params: { threshold: 0.3, knee: 0.2, intensity: 1.2, radius: 0.05, passes: 3, ...params },
});

const vignette = (params: Record<string, unknown> = {}): EffectSpec => ({
  id: 'vignette1',
  module: 'core.effect.vignette',
  enabled: true,
  params: { amount: 1, radius: 0.1, softness: 0.3, roundness: 1, ...params },
});

const luma = (c: { r: number; g: number; b: number }) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

/** Total brightness along a horizontal line — a simple measure of how far light has spread. */
function rowEnergy(frame: RenderedFrame, y: number): number {
  let total = 0;
  for (let x = 0; x < frame.width; x += 1) total += luma(frame.at(x, y));
  return total;
}

const render = async (name: string, project: RenderProject) =>
  (await renderFrames({ name, project, frames: [30] })).frames[0] as RenderedFrame;

describe.skipIf(!available)('effect chain on the GPU', () => {
  it('bloom spreads light outside the bright source', async () => {
    await bundleElectron();
    const [plain, glowing] = await Promise.all([
      render('fx-plain', squareProject([])),
      render('fx-bloom', squareProject([bloom()])),
    ]);

    const y = Math.floor(plain.height * 0.5);
    // Well outside the bar: black without bloom, lit with it.
    const outside = Math.floor(plain.width * 0.5 + plain.width * SQUARE);
    expect(luma(plain.at(outside, y))).toBeLessThan(2);
    expect(luma(glowing.at(outside, y))).toBeGreaterThan(8);
    expect(rowEnergy(glowing, y)).toBeGreaterThan(rowEnergy(plain, y) * 1.2);
  }, 180_000);

  it('a wider radius spreads further', async () => {
    await bundleElectron();
    const [tight, wide] = await Promise.all([
      render('fx-tight', squareProject([bloom({ radius: 0.01 })])),
      render('fx-wide', squareProject([bloom({ radius: 0.12 })])),
    ]);
    const y = Math.floor(tight.height * 0.5);
    const far = Math.floor(tight.width * 0.5 + tight.width * 0.3);
    expect(luma(wide.at(far, y))).toBeGreaterThan(luma(tight.at(far, y)));
  }, 180_000);

  it('the blur radius follows the canvas reference size, not a pixel count', async () => {
    await bundleElectron();
    // The same project at two resolutions: the glow must cover the same *fraction* of the
    // frame, or 4K exports look thin next to the 1080p preview.
    const [small, large] = await Promise.all([
      render('fx-small', squareProject([bloom()], { width: 320, height: 180 })),
      render('fx-large', squareProject([bloom()], { width: 640, height: 360 })),
    ]);

    /** How far from the centre, as a fraction of width, the glow is still visible. */
    const reach = (frame: RenderedFrame) => {
      const y = Math.floor(frame.height * 0.5);
      const centre = Math.floor(frame.width * 0.5);
      let x = frame.width - 1;
      while (x > centre && luma(frame.at(x, y)) < 4) x -= 1;
      return (x - centre) / frame.width;
    };
    expect(reach(large)).toBeCloseTo(reach(small), 1);
  }, 180_000);

  it('vignette darkens the corners and leaves the centre alone', async () => {
    await bundleElectron();
    const [plain, shaded] = await Promise.all([
      render('fx-vig-plain', squareProject([])),
      render('fx-vig', squareProject([vignette()])),
    ]);
    const y = Math.floor(plain.height * 0.5);
    const centre = Math.floor(plain.width * 0.5);
    expect(luma(shaded.at(centre, y))).toBeCloseTo(luma(plain.at(centre, y)), -1);
    // The bar reaches the frame edge vertically, so the top corner of it is darkened.
    expect(rowEnergy(shaded, 2)).toBeLessThanOrEqual(rowEnergy(plain, 2));
  }, 180_000);

  it('runs the chain in order: each pass sees the previous one', async () => {
    await bundleElectron();
    // Vignette-then-bloom blooms the already-darkened image; bloom-then-vignette darkens the
    // glow. Different pictures — which is exactly why the order is explicit and reorderable.
    const [first, second] = await Promise.all([
      render('fx-order-a', squareProject([vignette(), bloom()])),
      render('fx-order-b', squareProject([bloom(), vignette()])),
    ]);
    expect(first.sha256).not.toBe(second.sha256);
  }, 180_000);

  it('reports an unknown effect module instead of dropping it silently', async () => {
    await bundleElectron();
    const project = squareProject([{ id: 'nope', module: 'core.effect.telepathy', enabled: true, params: {} }]);
    const run = await renderFrames({ name: 'fx-unknown', project, frames: [0] });
    expect(run.warnings.join('\n')).toContain('unknown effect module "core.effect.telepathy"');
  }, 180_000);

  it('skips a disabled effect', async () => {
    await bundleElectron();
    const [off, none] = await Promise.all([
      render('fx-off', squareProject([{ ...bloom(), enabled: false }])),
      render('fx-none', squareProject([])),
    ]);
    expect(off.sha256).toBe(none.sha256);
  }, 180_000);
});
