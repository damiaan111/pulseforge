// Every visualizer in the catalogue, on the real GPU.
//
// A shader that compiles on one vendor can fail on another (PROJECT.md §14), and an unverified
// shader is worse than none. So each module here is actually rendered: it must compile, draw
// something, and draw the *same* something twice. That last one is the determinism contract at
// module level (module-spec §11 check 1) — the check that keeps export reproducible.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { BUILTIN_MODULES } from '../../src/engine/engine.ts';
import type { RenderProject } from '../../src/engine/core/project.ts';
import { rational } from '../../src/engine/core/time.ts';
import { bundleElectron } from '../../spike/harness.ts';
import { renderFrames, type RenderedFrame } from '../../spike/lib/frames-run.ts';

const ELECTRON = resolve(import.meta.dirname, '..', '..', 'node_modules', 'electron', 'dist', 'electron.exe');
const available = existsSync(ELECTRON);

const VISUALIZERS = BUILTIN_MODULES
  .filter((m) => m.manifest.kind === 'visualizer')
  .map((m) => m.manifest.id);

function projectFor(moduleId: string): RenderProject {
  return {
    schemaVersion: 0,
    seed: 4242,
    durationTicks: 48_000 * 2,
    canvas: { width: 320, height: 180, fps: rational(60), background: '#000000' },
    audio: { leadInTicks: 0, clipInTicks: 0 },
    layers: [{ id: 'v', module: moduleId, enabled: true, opacity: 1, blend: 'normal', params: {} }],
  };
}

const lit = (frame: RenderedFrame): number => {
  let count = 0;
  for (let i = 0; i < frame.pixels.length; i += 4) {
    if ((frame.pixels[i] ?? 0) + (frame.pixels[i + 1] ?? 0) + (frame.pixels[i + 2] ?? 0) > 24) count += 1;
  }
  return count / (frame.width * frame.height);
};

describe.skipIf(!available)('every visualizer renders on the GPU', () => {
  beforeAll(async () => {
    await bundleElectron();
  }, 180_000);

  it('has the modules the catalogue claims', () => {
    // M11 asks for ten. Asserted here so removing one is a test failure, not a quiet regression.
    expect(VISUALIZERS.length).toBeGreaterThanOrEqual(10);
  });

  it.each(VISUALIZERS)('%s compiles and draws', async (moduleId) => {
    const run = await renderFrames({ name: `mod-${moduleId.replace(/\W+/g, '-')}`, project: projectFor(moduleId), frames: [40] });
    const frame = run.frames[0] as RenderedFrame;
    // A shader that compiles but draws nothing is the failure mode a smoke test misses.
    expect(lit(frame)).toBeGreaterThan(0.005);
    expect(run.warnings.filter((w) => w.includes('no analysis'))).toEqual([]);
  }, 180_000);

  it.each(VISUALIZERS)('%s is deterministic', async (moduleId) => {
    const name = moduleId.replace(/\W+/g, '-');
    const [a, b] = await Promise.all([
      renderFrames({ name: `det-a-${name}`, project: projectFor(moduleId), frames: [12, 40] }),
      renderFrames({ name: `det-b-${name}`, project: projectFor(moduleId), frames: [40, 12] }),
    ]);
    const byIndex = (run: { frames: readonly RenderedFrame[] }) =>
      Object.fromEntries(run.frames.map((f) => [f.frameIndex, f.sha256]));
    expect(byIndex(b)).toEqual(byIndex(a));
  }, 180_000);
});
