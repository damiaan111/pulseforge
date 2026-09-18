// core.text.title on the real GPU (M16, M32): draws, is deterministic across runs and render
// order, honours its font asset, reports a missing font, and hides words per word.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import type { RenderProject } from '../../src/engine/core/project.ts';
import { rational } from '../../src/engine/core/time.ts';
import { DEFAULT_FONT_FILE, FONTS } from '../../setup/lib/paths.ts';
import { bundleElectron } from '../../spike/harness.ts';
import { renderFrames, type RenderedFrame } from '../../spike/lib/frames-run.ts';

const ELECTRON = resolve(import.meta.dirname, '..', '..', 'node_modules', 'electron', 'dist', 'electron.exe');
const BOLD = join(FONTS, 'inter', 'extras', 'ttf', 'Inter-Black.ttf');
const available = existsSync(ELECTRON) && existsSync(DEFAULT_FONT_FILE) && existsSync(BOLD);
const BOLD_HASH = available ? createHash('sha256').update(readFileSync(BOLD)).digest('hex') : '';
const FONT_ID = '0000000000A000000000000001';

function project(params: Record<string, unknown>, options: { withFont?: boolean; outSeconds?: number } = {}): RenderProject {
  return {
    schemaVersion: 0,
    seed: 3,
    durationTicks: 48_000 * 4,
    canvas: { width: 640, height: 360, fps: rational(60), background: '#000000' },
    audio: { leadInTicks: 0, clipInTicks: 0 },
    layers: [{
      id: 't', module: 'core.text.title', enabled: true, opacity: 1, blend: 'normal',
      params: { shadow: 0, animIn: 'none', animOut: 'none', ...params },
      timeRange: { inTicks: 0, outTicks: options.outSeconds === undefined ? null : options.outSeconds * 48_000 },
    }],
    ...(options.withFont === true ? { assets: { [FONT_ID]: { kind: 'font' as const, hash: BOLD_HASH, name: 'Inter-Black.ttf' } } } : {}),
  };
}

/** Fraction of pixels brighter than a threshold, in a column range. */
function lit(frame: RenderedFrame, x0 = 0, x1 = frame.width): number {
  let count = 0;
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = x0; x < x1; x += 1) if (frame.at(x, y).r > 128) count += 1;
  }
  return count / ((x1 - x0) * frame.height);
}

describe.skipIf(!available)('text layer on the GPU', () => {
  beforeAll(async () => {
    await bundleElectron();
  }, 180_000);

  it('draws white text centred, and nothing at the edges', async () => {
    const run = await renderFrames({ name: 'text-basic', project: project({ text: 'HELLO' }), frames: [30] });
    const frame = run.frames[0]!;
    expect(run.warnings).toEqual([]);
    expect(lit(frame)).toBeGreaterThan(0.003);
    expect(lit(frame, 0, 60)).toBe(0);
    expect(lit(frame, 580, 640)).toBe(0);
  }, 180_000);

  it('is deterministic across runs and render order', async () => {
    const params = { text: 'Night Drive\nsessions', glow: 1, strokeWidth: 0.05, plate: true, fillMode: 'gradient', animIn: 'stagger' };
    const [a, b] = await Promise.all([
      renderFrames({ name: 'text-det-a', project: project(params), frames: [5, 20, 90] }),
      renderFrames({ name: 'text-det-b', project: project(params), frames: [90, 5, 20] }),
    ]);
    const byIndex = (run: { frames: readonly RenderedFrame[] }) => Object.fromEntries(run.frames.map((f) => [f.frameIndex, f.sha256]));
    expect(byIndex(b)).toEqual(byIndex(a));
    expect(byIndex(a)[5]).not.toEqual(byIndex(a)[90]); // the animation actually moves
  }, 180_000);

  it('uses the chosen font asset: Inter Black covers more pixels than Regular', async () => {
    const [regular, black] = await Promise.all([
      renderFrames({ name: 'text-regular', project: project({ text: 'WEIGHT' }), frames: [30] }),
      renderFrames({ name: 'text-black', project: project({ text: 'WEIGHT', font: FONT_ID }, { withFont: true }), frames: [30], fonts: [{ hash: BOLD_HASH, file: BOLD }] }),
    ]);
    expect(black.warnings).toEqual([]);
    expect(lit(black.frames[0]!)).toBeGreaterThan(lit(regular.frames[0]!) * 1.3);
  }, 180_000);

  it('reports a font that is not registered, and still draws with the default', async () => {
    const run = await renderFrames({ name: 'text-missing-font', project: project({ text: 'WEIGHT', font: FONT_ID }, { withFont: true }), frames: [30] });
    expect(run.warnings.some((w) => w.includes('Inter-Black.ttf') && w.includes('default font'))).toBe(true);
    expect(lit(run.frames[0]!)).toBeGreaterThan(0.003);
  }, 180_000);

  it('typewriter shows the first word before the second, and fades out at the out point', async () => {
    const run = await renderFrames({
      name: 'text-typewriter',
      project: project({ text: 'LEFT RIGHT', animIn: 'typewriter', animOut: 'fade', animSeconds: 1, align: 'left' }, { outSeconds: 3 }),
      frames: [45, 120, 179],
    });
    const [mid, full, end] = run.frames as RenderedFrame[];
    // 0.75 s into a 1 s two-word typewriter: word one fully in, word two half.
    const half = 320;
    expect(lit(mid!, 0, half)).toBeGreaterThan(0.005);
    expect(lit(mid!, half, 640)).toBeLessThan(lit(full!, half, 640));
    // The last frame before the out point has faded almost to nothing.
    expect(lit(end!)).toBeLessThan(lit(full!) * 0.1);
  }, 180_000);
});
