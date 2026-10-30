// MilkDrop on the real GPU: Butterchurn through the engine draws, and holds the determinism contract
// though each frame is built on the last, so a frame must come out the same however it was reached.
// An export gets its engine by another road than these frames, so it is tried on its own: that road
// once went without a host, and every video came out empty beside a preview that looked right.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import type { RenderProject } from '../../src/engine/core/project.ts';
import { rational } from '../../src/engine/core/time.ts';
import { MILKDROP_JS_DIR } from '../../setup/lib/paths.ts';
import { encodeWavFloat32 } from '../../src/export/audio.ts';
import { defaultEncodeSettings } from '../../src/export/ffmpeg-args.ts';
import { SPIKE_OUT, bundleElectron } from '../../spike/harness.ts';
import { runExportSpike } from '../../spike/lib/export-run.ts';
import { renderFrames, type RenderedFrame } from '../../spike/lib/frames-run.ts';
import { synthesizeTestTrack } from '../../spike/test-signal.ts';

const ELECTRON = resolve(import.meta.dirname, '..', '..', 'node_modules', 'electron', 'dist', 'electron.exe');
const INDEX = join(MILKDROP_JS_DIR, 'index.json');
const available = existsSync(ELECTRON) && existsSync(INDEX);
const names = available ? (JSON.parse(readFileSync(INDEX, 'utf8')) as { name: string }[]).map((p) => p.name) : [];
const pick = (fraction: number) => names[Math.floor(names.length * fraction)] as string;

function project(preset: string, params: Record<string, unknown> = {}): RenderProject {
  return {
    schemaVersion: 0,
    seed: 3,
    durationTicks: 48_000 * 6,
    canvas: { width: 320, height: 180, fps: rational(60), background: '#000000' },
    audio: { leadInTicks: 0, clipInTicks: 0 },
    layers: [{ id: 'm', module: 'core.visualizer.milkdrop', enabled: true, opacity: 1, blend: 'normal', params: { preset, ...params } }],
  };
}

function ink(frame: RenderedFrame): number {
  let sum = 0;
  for (let y = 0; y < frame.height; y += 4) for (let x = 0; x < frame.width; x += 4) sum += frame.at(x, y).r + frame.at(x, y).g + frame.at(x, y).b;
  return sum;
}

const byIndex = (run: { frames: readonly RenderedFrame[] }) => Object.fromEntries(run.frames.map((f) => [f.frameIndex, f.sha256]));

describe.skipIf(!available)('MilkDrop on the GPU', () => {
  beforeAll(async () => {
    await bundleElectron();
  }, 180_000);

  it('draws a preset, and a different preset differently', async () => {
    const [a, b] = await Promise.all([
      renderFrames({ name: 'md-a', project: project(pick(0.3)), frames: [120] }),
      renderFrames({ name: 'md-b', project: project(pick(0.7)), frames: [120] }),
    ]);
    expect(a.warnings).toEqual([]);
    expect(b.warnings).toEqual([]);
    expect(ink(a.frames[0] as RenderedFrame) + ink(b.frames[0] as RenderedFrame)).toBeGreaterThan(0);
    expect((a.frames[0] as RenderedFrame).sha256).not.toBe((b.frames[0] as RenderedFrame).sha256);
  }, 180_000);

  it('gives the same frame however it was reached', async () => {
    const preset = pick(0.3);
    const [forward, backward, again] = await Promise.all([
      renderFrames({ name: 'md-forward', project: project(preset), frames: [10, 40, 90] }),
      renderFrames({ name: 'md-backward', project: project(preset), frames: [90, 40, 10] }),
      renderFrames({ name: 'md-again', project: project(preset), frames: [40, 90, 10] }),
    ]);
    expect(byIndex(backward)).toEqual(byIndex(forward));
    expect(byIndex(again)).toEqual(byIndex(forward));
  }, 240_000);

  it('grows differently from another seed', async () => {
    const preset = pick(0.3);
    const [one, two] = await Promise.all([
      renderFrames({ name: 'md-seed-1', project: project(preset, { seed: 1 }), frames: [90] }),
      renderFrames({ name: 'md-seed-2', project: project(preset, { seed: 2 }), frames: [90] }),
    ]);
    expect((one.frames[0] as RenderedFrame).sha256).not.toBe((two.frames[0] as RenderedFrame).sha256);
  }, 180_000);

  it('says so when the preset is not installed, or none is chosen', async () => {
    const [missing, none] = await Promise.all([
      renderFrames({ name: 'md-missing', project: project('No such preset'), frames: [5] }),
      renderFrames({ name: 'md-none', project: project(''), frames: [5] }),
    ]);
    expect(missing.warnings.join(' ')).toContain('is not installed');
    expect(none.warnings.join(' ')).toContain('no preset chosen');
  }, 180_000);

  it('reaches an exported file', async (test) => {
    const pcm = synthesizeTestTrack(1);
    const audioPath = join(SPIKE_OUT, 'md-export.wav');
    writeFileSync(audioPath, encodeWavFloat32([pcm, pcm], 48_000));
    const summary = await runExportSpike({
      workDir: join(SPIKE_OUT, 'md-export'),
      name: 'md-export',
      project: { ...project(pick(0.3)), durationTicks: pcm.length },
      analysisPcm: pcm,
      audioPath,
      audioLabel: 'synthetic',
      durationTicks: pcm.length,
      settings: { ...defaultEncodeSettings('h264'), conversion: 'swscale' },
      readbackMode: 'sync',
      readbackDepth: 1,
      hashFrames: true,
      dither: false,
      runs: 1,
      milkdropDir: MILKDROP_JS_DIR,
    }).catch((error: Error) => {
      // An old driver stops the encoder, not the picture; nothing here can be judged then.
      if (error.message.includes('driver is too old')) test.skip();
      throw error;
    });
    expect(summary.first.report.warnings).toEqual([]);
    expect(new Set(summary.first.frameHashes).size).toBeGreaterThan(1);
  }, 180_000);
});
