// The performance HUD's numbers on the real GPU (S12): each top-level layer is timed under its id,
// a heavy layer measures heavier than a light one, the output pass is timed — and profiling never
// changes a pixel (the frames are byte-identical with it on and off).

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import type { AnyLayerSpec, RenderProject } from '../../src/engine/core/project.ts';
import { rational } from '../../src/engine/core/time.ts';
import { bundleElectron } from '../../spike/harness.ts';
import { renderFrames } from '../../spike/lib/frames-run.ts';

const ELECTRON = resolve(import.meta.dirname, '..', '..', 'node_modules', 'electron', 'dist', 'electron.exe');
const available = existsSync(ELECTRON);

/** A plain solid, and the same solid under a wide blur run many times over: light and heavy. */
const light: AnyLayerSpec = { id: 'light', module: 'core.source.background', enabled: true, opacity: 1, blend: 'normal', params: { mode: 'solid', colorA: '#203040' } };
const heavy: AnyLayerSpec = {
  id: 'heavy', module: 'core.source.background', enabled: true, opacity: 0.5, blend: 'normal', params: { mode: 'solid', colorA: '#ff8800' },
  effects: Array.from({ length: 6 }, (_, i) => ({ id: `blur${i}`, module: 'core.effect.blur', enabled: true, params: { radius: 0.05 } })),
};

const project: RenderProject = {
  schemaVersion: 0, seed: 1, durationTicks: 48_000,
  canvas: { width: 1920, height: 1080, fps: rational(30), background: '#000000' },
  audio: { leadInTicks: 0, clipInTicks: 0 },
  layers: [light, heavy],
};

describe.skipIf(!available)('GPU time per layer', () => {
  beforeAll(async () => {
    await bundleElectron();
  }, 180_000);

  it('times each layer and the output; the heavy layer costs more; no pixel changes', async () => {
    const frames = [0, 1, 2, 3, 4, 5, 6, 7];
    const [on, off] = await Promise.all([
      renderFrames({ name: 'profile-on', project, frames, profile: true }),
      renderFrames({ name: 'profile-off', project, frames }),
    ]);
    expect(on.warnings).toEqual([]);
    expect(on.frames.map((f) => f.sha256)).toEqual(off.frames.map((f) => f.sha256));
    const gpu = on.gpu!;
    expect(gpu.available).toBe(true);
    expect(gpu.frames).toBe(frames.length);
    expect(gpu.discarded).toBe(0);
    const span = (key: string) => gpu.spans.find((s) => s.key === key);
    expect(span('light')).toBeDefined();
    expect(span('output')).toBeDefined();
    expect(span('heavy')!.meanMs).toBeGreaterThan(span('light')!.meanMs * 3);
    expect(gpu.spans[0]!.key).toBe('heavy');
  }, 180_000);
});
