// LUTs on the GPU (S11): a .cube table grades the picture exactly as the CPU reference says, in
// display values by default (as LUTs are made) or in linear light; Amount blends; a missing LUT passes
// the picture through and says so.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import type { AnyLayerSpec, RenderProject } from '../../src/engine/core/project.ts';
import { rational } from '../../src/engine/core/time.ts';
import { bundleElectron } from '../../spike/harness.ts';
import { renderFrames } from '../../spike/lib/frames-run.ts';

const ELECTRON = resolve(import.meta.dirname, '..', '..', 'node_modules', 'electron', 'dist', 'electron.exe');
const available = existsSync(ELECTRON);

/** A 17-point 3D LUT that rotates the channels: out = (g, b, r). Linear, so trilinear is exact. */
function swapCube(): string {
  const n = 17;
  const rows: string[] = [];
  for (let b = 0; b < n; b += 1) for (let g = 0; g < n; g += 1) for (let r = 0; r < n; r += 1) {
    rows.push(`${(g / (n - 1)).toFixed(6)} ${(b / (n - 1)).toFixed(6)} ${(r / (n - 1)).toFixed(6)}`);
  }
  return `TITLE "Swap"\nLUT_3D_SIZE ${n}\n${rows.join('\n')}\n`;
}
/** 1D, inverting every channel: out = 1 - in. */
const INVERT_1D = 'LUT_1D_SIZE 2\n1 1 1\n0 0 0\n';

const LUTS = [{ hash: 'swap', text: swapCube() }, { hash: 'invert', text: INVERT_1D }];
const ASSETS = { L1: { kind: 'lut' as const, hash: 'swap', name: 'Swap.cube' }, L2: { kind: 'lut' as const, hash: 'invert', name: 'Invert.cube' } };

function project(effect: Record<string, unknown>): RenderProject {
  const layer: AnyLayerSpec = {
    id: 'bg', module: 'core.source.background', enabled: true, opacity: 1, blend: 'normal', params: { mode: 'solid', colorA: '#336699' },
    effects: [{ id: 'fx', module: 'core.effect.lut', enabled: true, params: { lut: 'L1', amount: 1, space: 'display', ...effect } }],
  };
  return {
    schemaVersion: 0, seed: 1, durationTicks: 48_000,
    canvas: { width: 64, height: 36, fps: rational(10), background: '#000000' },
    audio: { leadInTicks: 0, clipInTicks: 0 },
    assets: ASSETS,
    layers: [layer],
  };
}

describe.skipIf(!available)('LUTs on the GPU', () => {
  beforeAll(async () => {
    await bundleElectron();
  }, 180_000);

  it('grades in display values as the table says; 1D tables, Amount, and a missing LUT', async () => {
    const [swap, invert, half, missing, again] = await Promise.all([
      renderFrames({ name: 'lut-swap', project: project({}), frames: [0], luts: LUTS }),
      renderFrames({ name: 'lut-invert', project: project({ lut: 'L2' }), frames: [0], luts: LUTS }),
      renderFrames({ name: 'lut-half', project: project({ lut: 'L2', amount: 0.5, space: 'linear' }), frames: [0], luts: LUTS }),
      renderFrames({ name: 'lut-missing', project: project({ lut: 'nope' }), frames: [0], luts: LUTS }),
      renderFrames({ name: 'lut-swap-2', project: project({}), frames: [0], luts: LUTS }),
    ]);
    const px = (run: typeof swap) => run.frames[0]!.at(32, 18);
    const near = (got: number, want: number) => expect(Math.abs(got - want)).toBeLessThanOrEqual(2);
    // #336699 = (51, 102, 153) → channels rotated: (102, 153, 51).
    expect(swap.warnings).toEqual([]);
    near(px(swap).r, 102);
    near(px(swap).g, 153);
    near(px(swap).b, 51);
    // Display-referred inversion: 255 - value.
    near(px(invert).r, 204);
    near(px(invert).g, 153);
    near(px(invert).b, 102);
    // In linear light, half way between the colour and its inversion: mid grey (linear 0.5 → 188).
    near(px(half).r, 188);
    near(px(half).b, 188);
    // Missing: said, and the picture unchanged.
    expect(missing.warnings.join(' ')).toMatch(/LUT: .*"nope".*passes through/);
    near(px(missing).r, 51);
    near(px(missing).b, 153);
    expect(again.frames[0]!.sha256).toBe(swap.frames[0]!.sha256);
  }, 180_000);

  it('after a vignette, a LUT grades darkened colour, not a see-through corner (the vignette keeps alpha)', async () => {
    const black = (global: NonNullable<RenderProject['globalEffects']>): RenderProject => ({
      ...project({}), layers: [{ id: 'bg', module: 'core.source.background', enabled: true, opacity: 1, blend: 'normal', params: { mode: 'solid', colorA: '#000000' } }],
      globalEffects: global,
    });
    const lut = { id: 'fxl', module: 'core.effect.lut', enabled: true, params: { lut: 'L2', amount: 1, space: 'display' } };
    const vignette = { id: 'fxv', module: 'core.effect.vignette', enabled: true, params: {} };
    const [vignetteFirst, lutFirst] = await Promise.all([
      renderFrames({ name: 'lut-after-vignette', project: black([vignette, lut]), frames: [0], luts: LUTS }),
      renderFrames({ name: 'vignette-after-lut', project: black([lut, vignette]), frames: [0], luts: LUTS }),
    ]);
    // Black, darkened, inverted: white to the corners. Inverted, then darkened: dark corners.
    expect(vignetteFirst.frames[0]!.at(0, 0).r).toBeGreaterThan(245);
    expect(lutFirst.frames[0]!.at(0, 0).r).toBeLessThan(220);
    expect(lutFirst.frames[0]!.at(32, 18).r).toBeGreaterThan(245);
  }, 180_000);
});
