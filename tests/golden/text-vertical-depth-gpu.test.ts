// Two additions to core.text.title on the real GPU: vertical columns and an extruded side. Both are
// off unless asked for, so a project that never mentions them draws what it always drew.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import type { ModulationBinding } from '../../src/engine/core/modulation.ts';
import type { RenderProject } from '../../src/engine/core/project.ts';
import { rational } from '../../src/engine/core/time.ts';
import { DEFAULT_FONT_FILE } from '../../setup/lib/paths.ts';
import { fallbackFontFiles } from '../../src/assets/fonts.ts';
import { bundleElectron } from '../../spike/harness.ts';
import { renderFrames, type RenderedFrame } from '../../spike/lib/frames-run.ts';

const ELECTRON = resolve(import.meta.dirname, '..', '..', 'node_modules', 'electron', 'dist', 'electron.exe');
const available = existsSync(ELECTRON) && existsSync(DEFAULT_FONT_FILE) && fallbackFontFiles().length > 0;
const W = 640;
const H = 360;

function project(params: Record<string, unknown>): RenderProject {
  return {
    schemaVersion: 0,
    seed: 3,
    durationTicks: 48_000 * 4,
    canvas: { width: W, height: H, fps: rational(60), background: '#000000' },
    audio: { leadInTicks: 0, clipInTicks: 0 },
    layers: [{
      id: 't', module: 'core.text.title', enabled: true, opacity: 1, blend: 'normal',
      params: { shadow: 0, animIn: 'none', animOut: 'none', ...params },
      timeRange: { inTicks: 0, outTicks: null },
    }],
  };
}

/** The lit pixels' bounding box, and how many there are. */
function extent(frame: RenderedFrame, threshold = 64): { width: number; height: number; count: number; right: number } {
  let x0 = Infinity;
  let x1 = -1;
  let y0 = Infinity;
  let y1 = -1;
  let count = 0;
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      if (frame.at(x, y).r <= threshold) continue;
      count += 1;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  }
  return { width: x1 - x0 + 1, height: y1 - y0 + 1, count, right: x1 };
}

describe.skipIf(!available)('vertical and extruded titles on the GPU', () => {
  beforeAll(async () => {
    await bundleElectron();
  }, 180_000);

  it('a project that sets neither draws the same bytes as one that sets them to their defaults', async () => {
    const [plain, explicit] = await Promise.all([
      renderFrames({ name: 'tvd-plain', project: project({ text: 'HELLO', glow: 0.5 }), frames: [30] }),
      renderFrames({ name: 'tvd-explicit', project: project({ text: 'HELLO', glow: 0.5, direction: 'horizontal', depth: 0, depthAngle: 200, depthColor: '#ff0000' }), frames: [30] }),
    ]);
    expect(explicit.frames[0]!.sha256).toBe(plain.frames[0]!.sha256);
  }, 180_000);

  it('vertical text stands taller than it is wide, in the order it reads', async () => {
    const text = '日本語';
    const [across, down, reversed] = await Promise.all([
      renderFrames({ name: 'tvd-across', project: project({ text, size: 0.1 }), frames: [30] }),
      renderFrames({ name: 'tvd-down', project: project({ text, size: 0.1, direction: 'vertical' }), frames: [30] }),
      renderFrames({ name: 'tvd-reversed', project: project({ text: '語本日', size: 0.1, direction: 'vertical' }), frames: [30] }),
    ]);
    expect(down.warnings).toEqual([]);
    const a = extent(across.frames[0]!);
    const d = extent(down.frames[0]!);
    expect(a.width).toBeGreaterThan(a.height * 2);
    expect(d.height).toBeGreaterThan(d.width * 2);
    expect(reversed.frames[0]!.sha256).not.toBe(down.frames[0]!.sha256);
  }, 180_000);

  it('a second paragraph makes a column to the left, and wraps at the canvas height', async () => {
    const [one, two, wrapped] = await Promise.all([
      renderFrames({ name: 'tvd-one', project: project({ text: 'ABC', size: 0.1, direction: 'vertical' }), frames: [30] }),
      renderFrames({ name: 'tvd-two', project: project({ text: 'ABC\nDEF', size: 0.1, direction: 'vertical' }), frames: [30] }),
      renderFrames({ name: 'tvd-wrapped', project: project({ text: 'AB CD EF GH IJ KL', size: 0.1, maxWidth: 0.5, direction: 'vertical' }), frames: [30] }),
    ]);
    const single = extent(one.frames[0]!);
    expect(extent(two.frames[0]!).width).toBeGreaterThan(single.width * 1.5);
    const w = extent(wrapped.frames[0]!);
    expect(w.height).toBeLessThanOrEqual(H * 0.5 + 4);
    expect(w.width).toBeGreaterThan(single.width * 1.5);
  }, 180_000);

  it('per-word animation, outline and reports work in columns; repeatably', async () => {
    const params = { text: 'ONE TWO', size: 0.1, direction: 'vertical', animIn: 'typewriter', animSeconds: 2, strokeWidth: 0.05, strokeColor: '#ff0000' };
    const [a, b, joined] = await Promise.all([
      renderFrames({ name: 'tvd-word-a', project: project(params), frames: [40, 150] }),
      renderFrames({ name: 'tvd-word-b', project: project(params), frames: [150, 40] }),
      renderFrames({ name: 'tvd-joined', project: project({ text: 'مرحبا', direction: 'vertical' }), frames: [10] }),
    ]);
    const hash = (run: typeof a, index: number) => run.frames.find((f) => f.frameIndex === index)!.sha256;
    expect(hash(b, 40)).toBe(hash(a, 40));
    expect(hash(b, 150)).toBe(hash(a, 150));
    const early = extent(a.frames.find((f) => f.frameIndex === 40)!);
    const late = extent(a.frames.find((f) => f.frameIndex === 150)!);
    expect(late.count).toBeGreaterThan(early.count * 1.4); // the second word has arrived
    expect(joined.warnings.join(' ')).toContain('do not join');
  }, 180_000);

  it('depth pulls a side out in its direction, in its colour, behind the face', async () => {
    const base = { text: 'I', size: 0.3 };
    const [flat, right, down] = await Promise.all([
      renderFrames({ name: 'tvd-flat', project: project(base), frames: [30] }),
      renderFrames({ name: 'tvd-right', project: project({ ...base, depth: 0.3, depthAngle: 0, depthColor: '#ff0000' }), frames: [30] }),
      renderFrames({ name: 'tvd-down2', project: project({ ...base, depth: 0.3, depthAngle: 90, depthColor: '#ff0000' }), frames: [30] }),
    ]);
    expect(right.warnings).toEqual([]);
    const f = extent(flat.frames[0]!);
    const r = extent(right.frames[0]!);
    const d = extent(down.frames[0]!);
    expect(r.right).toBeGreaterThan(f.right + 20);
    expect(r.height).toBeLessThanOrEqual(f.height + 2);
    expect(d.height).toBeGreaterThan(f.height + 20);
    // The side is red, the face stays white.
    const side = right.frames[0]!.at(f.right + 5, H / 2);
    expect(side.r).toBeGreaterThan(100);
    expect(side.g).toBeLessThan(30);
    const face = right.frames[0]!.at(W / 2, H / 2);
    expect(face.g).toBeGreaterThan(240);
  }, 180_000);

  it('depth follows a modulation binding', async () => {
    const swell: ModulationBinding = {
      id: 'swell',
      enabled: true,
      source: { type: 'curve', stem: 'mix', points: [{ ticks: 0, value: 0 }, { ticks: 48_000, value: 1 }] },
      target: 'layers.t.params.depth',
      inputRange: 'auto',
      curve: { type: 'linear', amount: 0 },
      envelope: { attackMs: 0, releaseMs: 0, mode: 'peak' },
      quantise: null,
      lookAheadMs: 0,
      amount: 0.3,
      offset: 0,
      invert: false,
      mode: 'add',
      order: 0,
      clampOutput: null,
    };
    const run = await renderFrames({
      name: 'tvd-modulated',
      project: { ...project({ text: 'I', size: 0.3, depthAngle: 0, depthColor: '#ff0000' }), globalModulations: [swell] },
      frames: [0, 60],
    });
    expect(run.warnings).toEqual([]);
    const [start, end] = run.frames.map((frame) => extent(frame));
    expect(end!.right).toBeGreaterThan(start!.right + 20);
  }, 180_000);
});
