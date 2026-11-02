// Masking on the real GPU (S7, compositor-spec §5): a layer shows only where its mask layer is,
// in canvas space; invert flips that; luma reads brightness rather than coverage; feather softens
// the edge; and the mask source itself is not drawn.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import type { AnyLayerSpec, LayerMaskSpec, RenderProject } from '../../src/engine/core/project.ts';
import { rational } from '../../src/engine/core/time.ts';
import { bundleElectron } from '../../spike/harness.ts';
import { renderFrames } from '../../spike/lib/frames-run.ts';

const ELECTRON = resolve(import.meta.dirname, '..', '..', 'node_modules', 'electron', 'dist', 'electron.exe');
const available = existsSync(ELECTRON);
const W = 64;
const H = 36;

/** A white half-frame box on the left: the mask source. Hidden unless `visible`. */
const box = (color = '#ffffff', visible = false): AnyLayerSpec => ({
  id: 'box', module: 'core.source.background', enabled: true, opacity: 1, blend: 'normal',
  params: { mode: 'solid', colorA: color },
  transform: { x: 0.25, y: 0.5, scaleX: 0.5, scaleY: 1, rotationDeg: 0, skewXDeg: 0, skewYDeg: 0, anchor: 'center', scaleReference: 'max' },
  ...(visible ? {} : { maskOnly: true }),
});
/** A solid red frame, masked by the box. */
const red = (mask: Partial<LayerMaskSpec> = {}): AnyLayerSpec => ({
  id: 'red', module: 'core.source.background', enabled: true, opacity: 1, blend: 'normal',
  params: { mode: 'solid', colorA: '#ff0000' },
  mask: { sourceId: 'box', channel: 'alpha', invert: false, feather: 0, ...mask },
});

function project(layers: AnyLayerSpec[]): RenderProject {
  return {
    schemaVersion: 0, seed: 1, durationTicks: 48_000,
    canvas: { width: W, height: H, fps: rational(10), background: '#000000' },
    audio: { leadInTicks: 0, clipInTicks: 0 },
    layers,
  };
}

describe.skipIf(!available)('masks on the GPU', () => {
  beforeAll(async () => {
    await bundleElectron();
  }, 180_000);

  it('alpha, invert, luma and feather; the source is hidden unless shown', async () => {
    const runs = await Promise.all([
      renderFrames({ name: 'mask-alpha', project: project([box(), red()]), frames: [0] }),
      renderFrames({ name: 'mask-invert', project: project([box(), red({ invert: true })]), frames: [0] }),
      // A dark box: fully opaque, but its luma is low — luma mask lets little through.
      renderFrames({ name: 'mask-luma', project: project([box('#202020'), red({ channel: 'luma' })]), frames: [0] }),
      renderFrames({ name: 'mask-feather', project: project([box(), red({ feather: 0.25 })]), frames: [0] }),
      renderFrames({ name: 'mask-shown', project: project([box('#00ff00', true), red({ invert: true })]), frames: [0] }),
    ]);
    for (const run of runs) expect(run.warnings).toEqual([]);
    const [alpha, invert, luma, feather, shown] = runs.map((r) => r.frames[0]!) as [NonNullable<(typeof runs)[0]['frames'][0]>, NonNullable<(typeof runs)[0]['frames'][0]>, NonNullable<(typeof runs)[0]['frames'][0]>, NonNullable<(typeof runs)[0]['frames'][0]>, NonNullable<(typeof runs)[0]['frames'][0]>];
    const left = { x: 8, y: 18 };
    const right = { x: 56, y: 18 };
    // Alpha: red where the box is, black elsewhere — and never the white box itself.
    expect(alpha.at(left.x, left.y)).toMatchObject({ g: 0, b: 0 });
    expect(alpha.at(left.x, left.y).r).toBeGreaterThan(240);
    expect(alpha.at(right.x, right.y).r).toBeLessThan(5);
    // Invert: the other half.
    expect(invert.at(left.x, left.y).r).toBeLessThan(5);
    expect(invert.at(right.x, right.y).r).toBeGreaterThan(240);
    // Luma: a dark (#202020, ~1.4% linear) box lets through only a little red.
    expect(luma.at(left.x, left.y).r).toBeGreaterThan(5);
    expect(luma.at(left.x, left.y).r).toBeLessThan(80);
    // Feather: soft at the edge (x = 32), still full in the middle of the box.
    expect(feather.at(8, 18).r).toBeGreaterThan(200);
    const edge = feather.at(32, 18).r;
    expect(edge).toBeGreaterThan(40);
    expect(edge).toBeLessThan(230);
    // A source that is also meant to be seen is drawn too: the green box on the left, and the
    // inverted-mask red on the right.
    expect(shown.at(left.x, left.y).g).toBeGreaterThan(240);
    expect(shown.at(right.x, right.y).r).toBeGreaterThan(240);
  }, 180_000);
});
