// Layer groups on the real GPU (M38): children composite into the group's own target, and the
// group's opacity, transform, blend and effect chain then apply to that result.
//
// The discriminating case is opacity. Two opaque children in a half-transparent group must show
// only the top one at 50 % — if the group were flattened into two 50 % layers (what the engine did
// before), the lower child would bleed through. That single check is the whole feature.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import type { AnyLayerSpec, GroupSpec, RenderProject } from '../../src/engine/core/project.ts';
import { rational } from '../../src/engine/core/time.ts';
import { bundleElectron } from '../../spike/harness.ts';
import { renderFrames, type RenderedFrame } from '../../spike/lib/frames-run.ts';

const ELECTRON = resolve(import.meta.dirname, '..', '..', 'node_modules', 'electron', 'dist', 'electron.exe');
const available = existsSync(ELECTRON);

let nextId = 0;
const id = (prefix: string) => `${prefix}${String(++nextId).padStart(6, '0')}`;

/** A full-canvas solid colour, as an ordinary module layer. */
const solid = (color: string): AnyLayerSpec => ({
  id: id('solid'),
  module: 'core.source.background',
  enabled: true,
  opacity: 1,
  blend: 'normal',
  params: { mode: 'solid', colorA: color },
});

const group = (children: readonly AnyLayerSpec[], options: Partial<GroupSpec> = {}): GroupSpec => ({
  kind: 'group',
  id: id('group'),
  enabled: true,
  opacity: 1,
  blend: 'normal',
  children,
  ...options,
});

function project(layers: readonly AnyLayerSpec[]): RenderProject {
  return {
    schemaVersion: 0,
    seed: 1,
    durationTicks: 48_000,
    canvas: { width: 160, height: 90, fps: rational(60), background: '#000000' },
    audio: { leadInTicks: 0, clipInTicks: 0 },
    layers,
  };
}

const at = (frame: RenderedFrame, x: number, y: number) => frame.at(x, y);

describe.skipIf(!available)('layer groups on the GPU', () => {
  beforeAll(async () => {
    await bundleElectron();
  }, 180_000);

  it('applies group opacity to the composited children, not to each child', async () => {
    const grouped = await renderFrames({
      name: 'group-opacity',
      project: project([group([solid('#ff0000'), solid('#0000ff')], { opacity: 0.5 })]),
      frames: [0],
    });
    const pixel = at(grouped.frames[0]!, 80, 45);
    // Inside the group the blue covers the red completely; only then is the result halved.
    expect(pixel.b).toBeGreaterThan(100);
    expect(pixel.r).toBeLessThan(8);
  }, 180_000);

  it('transforms the group as one image', async () => {
    const scaled = await renderFrames({
      name: 'group-transform',
      project: project([group([solid('#00ff00')], {
        transform: { x: 0.5, y: 0.5, scaleX: 0.5, scaleY: 0.5, rotationDeg: 0, skewXDeg: 0, skewYDeg: 0, anchor: 'center', scaleReference: 'min' },
      })]),
      frames: [0],
    });
    const frame = scaled.frames[0]!;
    expect(at(frame, 80, 45).g).toBeGreaterThan(200); // centre: the group's content
    expect(at(frame, 4, 4).g).toBeLessThan(8); // corner: outside the scaled group
  }, 180_000);

  it('runs the group effect chain over the composite', async () => {
    const withEffect = await renderFrames({
      name: 'group-effects',
      project: project([group([solid('#808080')], {
        effects: [{ id: id('fx'), module: 'core.effect.vignette', enabled: true, params: { amount: 1, radius: 0.3, softness: 0.3 } }],
      })]),
      frames: [0],
    });
    const frame = withEffect.frames[0]!;
    expect(at(frame, 80, 45).r).toBeGreaterThan(at(frame, 2, 2).r + 40);
  }, 180_000);

  it('hides a group outside its time range, children included', async () => {
    const scoped = await renderFrames({
      name: 'group-time',
      project: project([group([solid('#ffffff')], { timeRange: { inTicks: 24_000, outTicks: null } })]),
      frames: [0, 40],
    });
    expect(at(scoped.frames[0]!, 80, 45).r).toBeLessThan(8); // before the in point
    expect(at(scoped.frames[1]!, 80, 45).r).toBeGreaterThan(200); // after it
  }, 180_000);

  it('refuses to nest past the depth limit, and says so', async () => {
    let nested: AnyLayerSpec = solid('#ffffff');
    for (let i = 0; i < 10; i += 1) nested = group([nested]);
    const deep = await renderFrames({ name: 'group-deep', project: project([nested]), frames: [0] });
    expect(deep.warnings.some((w) => w.includes('nested more than'))).toBe(true);
  }, 180_000);
});
