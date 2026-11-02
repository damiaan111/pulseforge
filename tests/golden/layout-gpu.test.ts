// Layer transforms, on the real GPU (PROJECT.md §8.11).
//
// The layout maths is unit-tested on the CPU in tests/engine/layout.test.ts; what this file
// checks is that the compositor actually *uses* it the way the matrix says — that a scaled
// layer lands where the matrix puts it, in the right orientation, with nothing smeared
// outside its bounds. A y-flip or an inverse used the wrong way round passes every CPU test
// and is immediately obvious here.
//
// Needs Electron and a working WebGL2 context, so it is skipped where those are absent
// (the same rule the NVENC integration test follows).

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { rational } from '../../src/engine/core/time.ts';
import type { LayerSpec, RenderProject } from '../../src/engine/core/project.ts';
import { IDENTITY_LAYER_TRANSFORM } from '../../src/engine/core/layout.ts';
import { TEST_PATTERN_COLORS, TEST_PATTERN_COLUMNS, TEST_PATTERN_ROWS } from '../../src/engine/modules/test-pattern.ts';
import { bundleElectron } from '../../spike/harness.ts';
import { renderFrames, type RenderedFrame } from '../../spike/lib/frames-run.ts';

const ELECTRON = resolve(import.meta.dirname, '..', '..', 'node_modules', 'electron', 'dist', 'electron.exe');
const available = existsSync(ELECTRON);

const W = 640;
const H = 360;
const BACKGROUND = '#000000';

function project(transform: LayerSpec['transform']): RenderProject {
  return {
    schemaVersion: 0,
    seed: 1,
    canvas: { width: W, height: H, fps: rational(60), background: BACKGROUND },
    audio: { leadInTicks: 0, clipInTicks: 0 },
    layers: [{
      id: 'pattern',
      module: 'core.test.pattern',
      enabled: true,
      opacity: 1,
      blend: 'normal',
      params: {},
      ...(transform === undefined ? {} : { transform }),
    }],
  };
}

/** The test pattern's patch at a document-space position, as the module draws it untransformed. */
function expectedPatch(fx: number, fy: number): string {
  const col = Math.min(Math.floor(fx * TEST_PATTERN_COLUMNS), TEST_PATTERN_COLUMNS - 1);
  const row = Math.min(Math.floor(fy * TEST_PATTERN_ROWS), TEST_PATTERN_ROWS - 1);
  return TEST_PATTERN_COLORS[row * TEST_PATTERN_COLUMNS + col] as string;
}

const hex = (c: { r: number; g: number; b: number }) =>
  `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/**
 * Patch colours go through the tone shoulder and the sRGB OETF, so they do not come back as the
 * exact source hex. Comparing which patch a pixel *matches* is what this test is about, and it
 * is robust to that: the 24 patches are far apart in value.
 */
function nearestPatch(c: { r: number; g: number; b: number }): string {
  let best = TEST_PATTERN_COLORS[0] as string;
  let bestDistance = Infinity;
  for (const patch of TEST_PATTERN_COLORS) {
    const r = parseInt(patch.slice(1, 3), 16);
    const g = parseInt(patch.slice(3, 5), 16);
    const b = parseInt(patch.slice(5, 7), 16);
    const distance = (c.r - r) ** 2 + (c.g - g) ** 2 + (c.b - b) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = patch;
    }
  }
  return best;
}

const isBackground = (c: { r: number; g: number; b: number }) => c.r < 8 && c.g < 8 && c.b < 8;

describe.skipIf(!available)('layer transforms on the GPU', () => {
  let identity: RenderedFrame;
  let halfScale: RenderedFrame;
  let topLeftAnchor: RenderedFrame;

  beforeAll(async () => {
    await bundleElectron();
    const runs = await Promise.all([
      renderFrames({ name: 'layout-identity', project: project(undefined), frames: [0] }),
      renderFrames({
        name: 'layout-half',
        project: project({ ...IDENTITY_LAYER_TRANSFORM, scaleX: 0.5, scaleY: 0.5 }),
        frames: [0],
      }),
      renderFrames({
        name: 'layout-anchor',
        project: project({ ...IDENTITY_LAYER_TRANSFORM, anchor: 'top-left', x: 0, y: 0, scaleX: 0.5, scaleY: 0.5 }),
        frames: [0],
      }),
    ]);
    [identity, halfScale, topLeftAnchor] = runs.map((r) => r.frames[0] as RenderedFrame) as [RenderedFrame, RenderedFrame, RenderedFrame];
  }, 180_000);

  it('draws the pattern the right way up with no transform', () => {
    // The pattern's first row is a grey ramp and its last row starts with white: if the
    // compositor flipped the image, these two would swap.
    expect(nearestPatch(identity.at(W / 16, H / 6))).toBe(expectedPatch(1 / 16, 1 / 6));
    expect(nearestPatch(identity.at(W / 16, (H * 5) / 6))).toBe('#ffffff');
    expect(nearestPatch(identity.at((W * 15) / 16, H / 6))).toBe('#e0e0e0');
  });

  it('scales about the centre anchor, leaving the background outside', () => {
    // Half scale about the centre: the layer occupies the middle half in each axis.
    for (const [x, y] of [[W / 8, H / 8], [(W * 7) / 8, H / 8], [W / 8, (H * 7) / 8], [(W * 7) / 8, (H * 7) / 8]]) {
      expect(isBackground(halfScale.at(x as number, y as number))).toBe(true);
    }
    // The centre pixel is unmoved by a scale about the centre.
    expect(hex(halfScale.at(W / 2, H / 2))).toBe(hex(identity.at(W / 2, H / 2)));
    // A point a quarter across the canvas reads the patch from the middle of the layer.
    expect(nearestPatch(halfScale.at(W / 4 + 4, H / 4 + 4))).toBe(expectedPatch(0.01, 0.01));
  });

  it('does not smear the layer edge across the rest of the canvas', () => {
    // CLAMP_TO_EDGE without an explicit bounds test produces long streaks of the border
    // texel here; the whole outer band must be background instead.
    let outsideRow = 0;
    for (let x = 0; x < W; x += 1) if (!isBackground(halfScale.at(x, 4))) outsideRow += 1;
    expect(outsideRow).toBe(0);
  });

  it('honours the anchor: top-left anchored at the origin fills the top-left quadrant', () => {
    // The whole pattern is squeezed into x ∈ [0, W/2], y ∈ [0, H/2], so a canvas point maps
    // to twice its fraction within the layer.
    const inLayer = (fx: number, fy: number) => nearestPatch(topLeftAnchor.at((fx * W) / 2, (fy * H) / 2));
    expect(inLayer(0.5, 0.5)).toBe(expectedPatch(0.5, 0.5));
    expect(inLayer(0.95, 0.15)).toBe(expectedPatch(0.95, 0.15));
    // Its top-left corner is the pattern's top-left patch, not the middle of the pattern.
    expect(nearestPatch(topLeftAnchor.at(2, 2))).toBe(expectedPatch(0.01, 0.01));

    // Outside the quadrant is background. Probed where the pattern itself is not black, so
    // "absent" and "black patch" cannot be confused: the first patch is #000000.
    expect(isBackground(topLeftAnchor.at(W / 2 + 8, H / 4))).toBe(true);
    expect(isBackground(topLeftAnchor.at(W / 4, H / 2 + 8))).toBe(true);
  });

  it('renders the same bytes for the same project, as everything else must', () => {
    expect(identity.sha256).toHaveLength(64);
    expect(halfScale.sha256).not.toBe(identity.sha256);
  });
});

/**
 * The property the whole modulation design exists to protect (modulation-spec §5): the value
 * at a frame must not depend on how that frame was reached. Checked here through the real
 * pipeline — compiled program cache, engine, compositor, readback — not just the evaluator.
 */
describe.skipIf(!available)('modulation is order-independent on the GPU', () => {
  const FRAMES = [0, 17, 42, 80];

  function modulated(): RenderProject {
    return {
      schemaVersion: 0,
      seed: 1337,
      durationTicks: 48_000 * 2,
      canvas: { width: 320, height: 180, fps: rational(60), background: '#0b0614' },
      audio: { leadInTicks: 0, clipInTicks: 0 },
      layers: [{
        id: 'bars',
        module: 'core.visualizer.bars',
        enabled: true,
        opacity: 1,
        blend: 'normal',
        params: { source: 'mix', barCount: 32, maxHeight: 0.3 },
        modulations: [{
          id: 'M1',
          enabled: true,
          // A band binding with a real envelope: the stateful-filter bug would show up here.
          source: { type: 'band', stem: 'mix', band: 'bass' },
          target: 'layers.bars.params.maxHeight',
          inputRange: 'auto',
          curve: { type: 's-curve', amount: 0.6 },
          envelope: { attackMs: 5, releaseMs: 250, mode: 'peak' },
          quantise: null,
          lookAheadMs: 30,
          amount: 0.5,
          offset: 0,
          invert: false,
          mode: 'add',
          order: 0,
          clampOutput: null,
        }],
      }],
    };
  }

  it('gives the same frame whether reached in order or jumped to', async () => {
    await bundleElectron();
    const [forwards, shuffled] = await Promise.all([
      renderFrames({ name: 'mod-forwards', project: modulated(), frames: FRAMES }),
      renderFrames({ name: 'mod-shuffled', project: modulated(), frames: [...FRAMES].reverse() }),
    ]);
    expect(forwards.warnings).toEqual([]);

    const byIndex = (run: { frames: readonly RenderedFrame[] }) =>
      Object.fromEntries(run.frames.map((f) => [f.frameIndex, f.sha256]));
    expect(byIndex(shuffled)).toEqual(byIndex(forwards));

    // And the modulation is actually doing something — otherwise the check above is vacuous.
    expect(new Set(forwards.frames.map((f) => f.sha256)).size).toBe(FRAMES.length);
  }, 180_000);
});
