// 3D scene layers on the real GPU (M37, compositor-spec §7): Three.js drawing into the engine's
// own context, deterministically, without leaking its GL state into the 2D layers around it.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import type { AnyLayerSpec, RenderProject } from '../../src/engine/core/project.ts';
import { rational } from '../../src/engine/core/time.ts';
import { bundleElectron } from '../../spike/harness.ts';
import { renderFrames, type RenderedFrame } from '../../spike/lib/frames-run.ts';

const ELECTRON = resolve(import.meta.dirname, '..', '..', 'node_modules', 'electron', 'dist', 'electron.exe');
const available = existsSync(ELECTRON);

function layer(id: string, module: string, params: Record<string, unknown> = {}): AnyLayerSpec {
  return { id, module, enabled: true, opacity: 1, blend: 'normal', params };
}

function project(layers: AnyLayerSpec[], width = 320, height = 180): RenderProject {
  return {
    schemaVersion: 0,
    seed: 11,
    durationTicks: 48_000 * 2,
    canvas: { width, height, fps: rational(60), background: '#000000' },
    audio: { leadInTicks: 0, clipInTicks: 0 },
    layers,
  };
}

/** Fraction of pixels brighter than black. */
function lit(frame: RenderedFrame): number {
  let count = 0;
  for (let i = 0; i < frame.pixels.length; i += 4) {
    if ((frame.pixels[i] ?? 0) + (frame.pixels[i + 1] ?? 0) + (frame.pixels[i + 2] ?? 0) > 24) count += 1;
  }
  return count / (frame.width * frame.height);
}

/** Sum of horizontal luma differences: high for a sharp image, lower once it is blurred. */
function edgeEnergy(frame: RenderedFrame): number {
  let sum = 0;
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 1; x < frame.width; x += 1) {
      const i = (y * frame.width + x) * 4;
      sum += Math.abs((frame.pixels[i + 1] ?? 0) - (frame.pixels[i - 3] ?? 0));
    }
  }
  return sum;
}

function hashes(run: { frames: readonly RenderedFrame[] }): Record<number, string> {
  return Object.fromEntries(run.frames.map((f) => [f.frameIndex, f.sha256]));
}

describe.skipIf(!available)('3D scene layers on the GPU', () => {
  beforeAll(async () => {
    await bundleElectron();
  }, 180_000);

  it('draws a reactive shape, and draws the same frames in any order', async () => {
    const scene = project([layer('shape', 'core.scene3d.shapes')]);
    const [a, b] = await Promise.all([
      renderFrames({ name: 'scene-shapes-a', project: scene, frames: [10, 45, 90] }),
      renderFrames({ name: 'scene-shapes-b', project: scene, frames: [90, 10, 45] }),
    ]);
    expect(a.warnings).toEqual([]);
    for (const frame of a.frames) expect(lit(frame)).toBeGreaterThan(0.03);
    expect(hashes(a)).toEqual(hashes(b));
    // It moves: the orbit, the spin and the audio all change the picture.
    expect(new Set(Object.values(hashes(a))).size).toBe(3);
  }, 180_000);

  it('keeps the subject in frame on a vertical canvas', async () => {
    const wide = await renderFrames({ name: 'scene-shapes-wide', project: project([layer('shape', 'core.scene3d.shapes')]), frames: [30] });
    const tall = await renderFrames({ name: 'scene-shapes-tall', project: project([layer('shape', 'core.scene3d.shapes')], 180, 320), frames: [30] });
    // The field of view applies to the short side, so the shape covers a similar share of that side.
    const share = (f: RenderedFrame) => lit(f) * f.width * f.height / Math.min(f.width, f.height) ** 2;
    const ratio = share(tall.frames[0]!) / share(wide.frames[0]!);
    expect(ratio).toBeGreaterThan(0.6);
    expect(ratio).toBeLessThan(1.6);
  }, 180_000);

  it('draws the terrain and the city, deterministically, at every aspect', async () => {
    for (const module of ['core.scene3d.terrain', 'core.scene3d.city']) {
      for (const [w, h] of [[320, 180], [180, 320]] as const) {
        const scene = project([layer('s', module)], w, h);
        const slug = `${module.split('.').pop()}-${w}x${h}`;
        const [a, b] = await Promise.all([
          renderFrames({ name: `scene-${slug}-a`, project: scene, frames: [15, 60] }),
          renderFrames({ name: `scene-${slug}-b`, project: scene, frames: [60, 15] }),
        ]);
        expect(a.warnings).toEqual([]);
        for (const frame of a.frames) expect(lit(frame), `${slug} frame ${frame.frameIndex}`).toBeGreaterThan(0.05);
        expect(hashes(a)).toEqual(hashes(b));
      }
    }
  }, 300_000);

  it('the city history layout scrolls with time rather than jumping', async () => {
    const scene = project([layer('s', 'core.scene3d.city', { layout: 'history', rig: 'static', kick: 0 })]);
    const run = await renderFrames({ name: 'scene-city-history', project: scene, frames: [30, 31] });
    // Consecutive frames differ (it moves) but only a little (it slides; it does not re-deal).
    const [f0, f1] = run.frames;
    let changed = 0;
    for (let i = 0; i < f0!.pixels.length; i += 4) if (Math.abs(f0!.pixels[i]! - f1!.pixels[i]!) > 24) changed += 1;
    const share = changed / (f0!.width * f0!.height);
    expect(share).toBeGreaterThan(0);
    expect(share).toBeLessThan(0.35);
  }, 180_000);

  it('depth of field blurs a scene by its depth, and is refused on a 2D layer', async () => {
    const dof = { id: 'dof', module: 'core.effect.dof', enabled: true, params: { focus: 2, range: 0, amount: 1 } };
    const sharp = await renderFrames({ name: 'scene-dof-off', project: project([layer('s', 'core.scene3d.city')]), frames: [40] });
    const soft = await renderFrames({ name: 'scene-dof-on', project: project([{ ...layer('s', 'core.scene3d.city'), effects: [dof] }]), frames: [40] });
    expect(soft.warnings).toEqual([]);
    expect(edgeEnergy(soft.frames[0]!)).toBeLessThan(edgeEnergy(sharp.frames[0]!) * 0.6);

    // Focused on the city itself it stays much sharper than focused far in front of it.
    const focused = await renderFrames({
      name: 'scene-dof-focused',
      project: project([{ ...layer('s', 'core.scene3d.city'), effects: [{ ...dof, params: { focus: 26, range: 6, amount: 1 } }] }]),
      frames: [40],
    });
    expect(edgeEnergy(focused.frames[0]!)).toBeGreaterThan(edgeEnergy(soft.frames[0]!) * 1.3);

    const flat = await renderFrames({ name: 'scene-dof-2d', project: project([{ ...layer('b', 'core.visualizer.bars'), effects: [dof] }]), frames: [40] });
    const flatAlone = await renderFrames({ name: 'scene-dof-2d-alone', project: project([layer('b', 'core.visualizer.bars')]), frames: [40] });
    expect(flat.warnings.some((w) => w.includes('needs depth'))).toBe(true);
    expect(flat.frames[0]!.sha256).toBe(flatAlone.frames[0]!.sha256);
  }, 300_000);

  it('leaves no GL state behind: 2D layers around a scene draw exactly as they do alone', async () => {
    // Opaque full-frame pattern over the scene: the scene must be completely hidden.
    const [over, alone] = await Promise.all([
      renderFrames({ name: 'scene-hygiene-over', project: project([layer('shape', 'core.scene3d.shapes'), layer('p', 'core.test.pattern')]), frames: [20] }),
      renderFrames({ name: 'scene-hygiene-alone', project: project([layer('p', 'core.test.pattern')]), frames: [20] }),
    ]);
    expect(over.frames[0]!.sha256).toBe(alone.frames[0]!.sha256);

    // Scene over the pattern: where the scene is empty, the pattern shows through untouched.
    const under = await renderFrames({ name: 'scene-hygiene-under', project: project([layer('p', 'core.test.pattern'), layer('shape', 'core.scene3d.shapes')]), frames: [20] });
    const corner = (f: RenderedFrame) => [f.at(4, 4), f.at(315, 4), f.at(4, 175), f.at(315, 175)];
    expect(corner(under.frames[0]!)).toEqual(corner(alone.frames[0]!));
  }, 180_000);
});
