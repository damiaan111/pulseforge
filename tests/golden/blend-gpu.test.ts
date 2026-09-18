// The separable blend modes on the real GPU (M7, compositor-spec §3).
//
// A solid colour is blended over the test pattern in each mode, and the pixels are checked against
// the W3C formulas computed here, independently of the shader, then through the engine's own tone
// curve (D48 — a dodge can reach 1.0, which sits above the shoulder) and sRGB encoding.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { linearToSrgb, parseHexColor, srgbToLinear, tonemap } from '../../src/engine/core/color.ts';
import type { AnyLayerSpec, BlendMode, RenderProject } from '../../src/engine/core/project.ts';
import { rational } from '../../src/engine/core/time.ts';
import { TEST_PATTERN_COLORS, TEST_PATTERN_COLUMNS, TEST_PATTERN_ROWS } from '../../src/engine/modules/test-pattern.ts';
import { bundleElectron } from '../../spike/harness.ts';
import { renderFrames } from '../../spike/lib/frames-run.ts';

const ELECTRON = resolve(import.meta.dirname, '..', '..', 'node_modules', 'electron', 'dist', 'electron.exe');
const available = existsSync(ELECTRON);

const W = 320;
const H = 180;
const TOP = '#b04a70';

function project(layers: AnyLayerSpec[]): RenderProject {
  return {
    schemaVersion: 0,
    seed: 1,
    durationTicks: 48_000,
    canvas: { width: W, height: H, fps: rational(30), background: '#000000' },
    audio: { leadInTicks: 0, clipInTicks: 0 },
    layers,
  };
}

const pattern: AnyLayerSpec = { id: 'p', module: 'core.test.pattern', enabled: true, opacity: 1, blend: 'normal', params: {} };
const solid = (blend: BlendMode): AnyLayerSpec => ({
  id: 's', module: 'core.source.background', enabled: true, opacity: 1, blend, params: { mode: 'solid', colorA: TOP },
});

const linear = (hex: string): [number, number, number] => {
  const c = parseHexColor(hex)!;
  return [srgbToLinear(c.r), srgbToLinear(c.g), srgbToLinear(c.b)];
};

/** The W3C separable formulas, as the spec writes them. Both inputs opaque, so B is the result. */
function expected(mode: BlendMode, s: number, b: number): number {
  const c = (x: number) => Math.min(1, Math.max(0, x));
  const hard = (sv: number, bv: number) => (sv <= 0.5 ? bv * 2 * sv : 1 - (1 - bv) * (1 - (2 * sv - 1)));
  switch (mode) {
    case 'multiply': return s * b;
    case 'overlay': return hard(c(b), c(s));
    case 'hard-light': return hard(c(s), c(b));
    case 'soft-light': {
      const sv = c(s);
      const bv = c(b);
      const d = bv <= 0.25 ? ((16 * bv - 12) * bv + 4) * bv : Math.sqrt(bv);
      return sv <= 0.5 ? bv - (1 - 2 * sv) * bv * (1 - bv) : bv + (2 * sv - 1) * (d - bv);
    }
    case 'darken': return Math.min(s, b);
    case 'lighten': return Math.max(s, b);
    case 'difference': return Math.abs(s - b);
    case 'exclusion': return s + b - 2 * s * b;
    case 'color-dodge': return c(b) === 0 ? 0 : Math.min(1, c(b) / Math.max(1e-6, 1 - c(s)));
    case 'color-burn': return c(b) === 1 ? 1 : 1 - Math.min(1, (1 - c(b)) / Math.max(1e-6, c(s)));
    default: throw new Error(mode);
  }
}

/** Centre pixel of a test-pattern patch, and that patch's colour. Top-down rows. */
function patch(index: number): { x: number; y: number; hex: string } {
  const col = index % TEST_PATTERN_COLUMNS;
  const row = Math.floor(index / TEST_PATTERN_COLUMNS);
  return {
    x: Math.floor((col + 0.5) * (W / TEST_PATTERN_COLUMNS)),
    y: Math.floor((row + 0.5) * (H / TEST_PATTERN_ROWS)),
    hex: TEST_PATTERN_COLORS[index]!,
  };
}

// Mid greys and saturated colours.
const PATCHES = [2, 4, 5, 8, 11, 20, 22];
const MODES: BlendMode[] = ['multiply', 'overlay', 'soft-light', 'hard-light', 'darken', 'lighten', 'difference', 'exclusion', 'color-dodge', 'color-burn'];

describe.skipIf(!available)('blend modes on the GPU', () => {
  beforeAll(async () => {
    await bundleElectron();
  }, 180_000);

  it.each(MODES)('%s matches the W3C formula', async (mode) => {
    const run = await renderFrames({ name: `blend-${mode}`, project: project([pattern, solid(mode)]), frames: [0] });
    expect(run.warnings).toEqual([]);
    const frame = run.frames[0]!;
    const s = linear(TOP);
    for (const index of PATCHES) {
      const { x, y, hex } = patch(index);
      const b = linear(hex);
      const got = frame.at(x, y);
      const mapped = tonemap(expected(mode, s[0]!, b[0]!), expected(mode, s[1]!, b[1]!), expected(mode, s[2]!, b[2]!));
      const want = mapped.map((v) => Math.round(linearToSrgb(v) * 255));
      // Within 2 code values: half-float intermediates and sRGB rounding, nothing more.
      expect(Math.abs(got.r - want[0]!), `${mode} patch ${index} r`).toBeLessThanOrEqual(2);
      expect(Math.abs(got.g - want[1]!), `${mode} patch ${index} g`).toBeLessThanOrEqual(2);
      expect(Math.abs(got.b - want[2]!), `${mode} patch ${index} b`).toBeLessThanOrEqual(2);
    }
  }, 180_000);

  it('a blended layer over a transparent backdrop (alone inside a group) draws as itself', async () => {
    const grouped: AnyLayerSpec = { id: 'g', kind: 'group', enabled: true, opacity: 1, blend: 'normal', children: [solid('multiply')] };
    const [inGroup, plain] = await Promise.all([
      renderFrames({ name: 'blend-group', project: project([pattern, grouped]), frames: [0] }),
      renderFrames({ name: 'blend-plain', project: project([pattern, solid('normal')]), frames: [0] }),
    ]);
    // Multiply inside an empty group has a transparent backdrop, so the colour comes through as-is.
    expect(inGroup.frames[0]!.sha256).toBe(plain.frames[0]!.sha256);
  }, 180_000);

  it('fixed-function modes are unchanged by the new pass', async () => {
    const run = await renderFrames({ name: 'blend-screen', project: project([pattern, solid('screen')]), frames: [0] });
    const s = linear(TOP);
    const { x, y, hex } = patch(4);
    const b = linear(hex);
    const got = run.frames[0]!.at(x, y);
    const want = Math.round(linearToSrgb(s[0]! + b[0]! - s[0]! * b[0]!) * 255);
    expect(Math.abs(got.r - want)).toBeLessThanOrEqual(2);
  }, 180_000);
});
