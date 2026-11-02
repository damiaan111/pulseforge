// Draft mode on the GPU (S18): the heaviest case measured — a 3D scene under depth of field — renders
// cheaper in draft, and is recognisably the same frame (module-spec §7 rule 5: lower fidelity, same
// composition). A final render is untouched (golden frames guard that); draft is repeatable too.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import type { RenderProject } from '../../src/engine/core/project.ts';
import { rational } from '../../src/engine/core/time.ts';
import { bundleElectron } from '../../spike/harness.ts';
import { renderFrames, type RenderedFrame } from '../../spike/lib/frames-run.ts';

const ELECTRON = resolve(import.meta.dirname, '..', '..', 'node_modules', 'electron', 'dist', 'electron.exe');
const available = existsSync(ELECTRON);

const project: RenderProject = {
  schemaVersion: 0, seed: 7, durationTicks: 48_000 * 2,
  canvas: { width: 1920, height: 1080, fps: rational(60), background: '#000000' },
  audio: { leadInTicks: 0, clipInTicks: 0 },
  layers: [{
    id: 'city', module: 'core.scene3d.city', enabled: true, opacity: 1, blend: 'normal', params: {},
    effects: [{ id: 'dof', module: 'core.effect.dof', enabled: true, params: { focus: 4, range: 0.5, amount: 1 } }],
  }],
};

/** Mean colour of each cell of a coarse grid: where things are and how bright, not the fine detail. */
function layout(frame: RenderedFrame, cols = 16, rows = 9): number[] {
  const out: number[] = [];
  for (let cy = 0; cy < rows; cy += 1) for (let cx = 0; cx < cols; cx += 1) {
    let sum = 0;
    let n = 0;
    for (let y = Math.floor((cy * frame.height) / rows); y < Math.floor(((cy + 1) * frame.height) / rows); y += 4) {
      for (let x = Math.floor((cx * frame.width) / cols); x < Math.floor(((cx + 1) * frame.width) / cols); x += 4) {
        const p = frame.at(x, y);
        sum += (p.r + p.g + p.b) / 3;
        n += 1;
      }
    }
    out.push(sum / n);
  }
  return out;
}

describe.skipIf(!available)('draft mode on the GPU', () => {
  beforeAll(async () => {
    await bundleElectron();
  }, 180_000);

  // Retried because the GPU is shared with other test files: a timing can lose to them by chance,
  // while a draft that really costs as much as a final fails every time.
  it('costs less and shows the same picture', { retry: 3, timeout: 180_000 }, async () => {
    const frames = [30, 31, 32, 33, 34, 35];
    // One at a time: side by side they would be timing each other.
    const final = await renderFrames({ name: 'draft-final', project, frames, profile: true });
    const draft = await renderFrames({ name: 'draft-draft', project, frames, profile: true, quality: 'draft' });
    const draftAgain = await renderFrames({ name: 'draft-again', project, frames: [30], quality: 'draft' });
    expect(final.warnings).toEqual([]);
    expect(draft.warnings).toEqual([]);
    const cost = (run: typeof final) => run.gpu!.spans.find((s) => s.key === 'city')!.meanMs;
    // The measured cost falls: fewer DOF taps and no MSAA on the scene.
    expect(cost(draft)).toBeLessThan(cost(final) * 0.7);
    // Same composition: the coarse layout matches within a few levels everywhere.
    const a = layout(final.frames[0]!);
    const b = layout(draft.frames[0]!);
    const worst = Math.max(...a.map((v, i) => Math.abs(v - (b[i] as number))));
    expect(worst).toBeLessThan(12);
    // But it is a draft: the pixels are not the final ones.
    expect(draft.frames[0]!.sha256).not.toBe(final.frames[0]!.sha256);
    expect(draftAgain.frames[0]!.sha256).toBe(draft.frames[0]!.sha256);
    console.log(`city+dof at 1080p: final ${cost(final).toFixed(2)} ms, draft ${cost(draft).toFixed(2)} ms; worst layout difference ${worst.toFixed(1)}`);
  });
});
