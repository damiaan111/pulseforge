// A/B render (C10): what makes the two sides comparable, and a real side-by-side from two real
// files through the vendored FFmpeg. The sides themselves are `renderDocument`, tested elsewhere.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FFMPEG_EXE, FFPROBE_EXE } from '../../setup/lib/paths.ts';
import { comparisonDocument, comparisonTicks, renderComparison, type ComparisonSide } from '../../src/export/comparison.ts';
import { buildSideBySideArgs, defaultEncodeSettings, sideBySideSize } from '../../src/export/ffmpeg-args.ts';
import { RenderQueue } from '../../src/export/queue.ts';
import { createDocument } from '../../src/project/create.ts';
import { rational } from '../../src/engine/core/time.ts';

const left = createDocument({ id: 'a', name: 'A', timestamp: 't', canvas: { width: 1280, height: 720, fps: rational(30) }, audio: { path: 'a.wav', durationTicks: 96_000 } });
const right = createDocument({ id: 'b', name: 'B', timestamp: 't', canvas: { width: 640, height: 640, fps: rational(60), background: '#112233' }, audio: { path: 'b.wav', durationTicks: 48_000 } });

describe('comparing two projects', () => {
  it('puts the right side on the left side\'s canvas, keeping the rest of it', () => {
    const aligned = comparisonDocument(left, right);
    expect(aligned.canvas).toMatchObject({ width: 1280, height: 720, fps: { num: 30, den: 1 }, background: '#112233' });
    expect(aligned.audio.path).toBe('b.wav');
    expect(aligned.name).toBe('B');
  });

  it('is as long as the shorter timeline, whichever side that is', () => {
    expect(comparisonTicks(left, right)).toBe(48_000);
    expect(comparisonTicks(right, left)).toBe(48_000);
  });

  it('refuses a side with no length', () => {
    expect(() => comparisonTicks(left, createDocument({ id: 'c', timestamp: 't' }))).toThrow(/no length/);
  });
});

describe('side-by-side arguments', () => {
  const settings = defaultEncodeSettings('h264');

  it('doubles the width, and comes down evenly past what the codec takes', () => {
    expect(sideBySideSize(1920, 1080, 'h264')).toEqual({ width: 3840, height: 1080 });
    expect(sideBySideSize(3840, 2160, 'h264')).toEqual({ width: 4096, height: 1152 });
    expect(sideBySideSize(3840, 2160, 'hevc')).toEqual({ width: 7680, height: 2160 });
  });

  it('stacks left then right, keeps the left sound unencoded, and stamps the colour tags', () => {
    const args = buildSideBySideArgs({ left: 'l.mp4', right: 'r.mp4', width: 1920, height: 1080, fps: rational(60), settings, outputPath: 'out.mp4' });
    expect(args.slice(args.indexOf('-i'), args.indexOf('-i') + 4)).toEqual(['-i', 'l.mp4', '-i', 'r.mp4']);
    const graph = args[args.indexOf('-filter_complex') + 1] as string;
    expect(graph).toContain('[0:v][1:v]hstack=inputs=2:shortest=1');
    expect(graph).not.toContain('scale=');
    expect(args.join(' ')).toContain('-map [v] -map 0:a:0');
    expect(args.join(' ')).toContain('-c:a copy');
  });

  it('scales only when it has to', () => {
    const args = buildSideBySideArgs({ left: 'l.mp4', right: 'r.mp4', width: 3840, height: 2160, fps: rational(60), settings, outputPath: 'out.mp4' });
    expect(args[args.indexOf('-filter_complex') + 1]).toContain('scale=4096:1152');
  });
});

describe('the queue with an A/B job', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pulseforge-ab-queue-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('snapshots both sides, hands both to the runner, and removes both', async () => {
    const seen: { document: string; compare: string | undefined }[] = [];
    let id = 0;
    const queue = new RenderQueue({
      root,
      newId: () => `job${(id += 1)}`,
      now: () => 'now',
      run: async ({ documentJson, compareJson }) => {
        seen.push({ document: documentJson, compare: compareJson });
        return {};
      },
    });
    const job = await queue.enqueue({
      document: left, aspect: '16:9', presetName: 'p', outputPath: 'o.mp4',
      compare: { document: right, projectPath: 'C:/b.pvproj', label: 'b.pvproj' },
    });
    expect(job.compare).toMatchObject({ projectPath: 'C:/b.pvproj', label: 'b.pvproj' });
    await queue.drain();
    expect(JSON.parse(seen[0]?.document ?? '{}')).toMatchObject({ name: 'A' });
    expect(JSON.parse(seen[0]?.compare ?? '{}')).toMatchObject({ name: 'B' });

    const path = job.compare?.snapshotPath as string;
    expect(existsSync(path)).toBe(true);
    await queue.remove(job.id);
    expect(existsSync(path)).toBe(false);
  });

  it('gives an ordinary job no second document', async () => {
    const run = vi.fn(async () => ({}));
    const queue = new RenderQueue({ root, newId: () => 'one', now: () => 'now', run });
    const job = await queue.enqueue({ document: left, aspect: '16:9', presetName: 'p', outputPath: 'o.mp4' });
    expect('compare' in job).toBe(false);
    await queue.drain();
    expect('compareJson' in (run.mock.calls as unknown as [[object]])[0][0]).toBe(false);
  });
});

describe.skipIf(!existsSync(FFMPEG_EXE))('renderComparison, with the vendored FFmpeg', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pulseforge-ab-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const settings = { ...defaultEncodeSettings('h264'), encoder: 'software' as const };
  const ok = { frames: 10, report: { verification: { ok: true, issues: [] } } };
  const COLOURS: Readonly<Record<ComparisonSide, string>> = { left: 'red', right: 'blue' };

  /** Stands in for renderDocument: a one-second clip of one colour, with a tone only on the left. */
  function clip(side: ComparisonSide, path: string): void {
    const result = spawnSync(FFMPEG_EXE, [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', `color=c=${COLOURS[side]}:s=320x180:r=10:d=1`,
      '-f', 'lavfi', '-i', `sine=f=${side === 'left' ? 440 : 880}:d=1`,
      '-c:v', 'libopenh264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path,
    ]);
    expect(result.status, result.stderr.toString()).toBe(0);
  }

  it('makes one verified file, left beside right, with a report that says how', async () => {
    const outputPath = join(root, 'ab.mp4');
    const order: ComparisonSide[] = [];
    const result = await renderComparison({
      ffmpegExe: FFMPEG_EXE, ffprobeExe: FFPROBE_EXE, settings, outputPath, workDir: join(root, 'work'),
      labels: { left: 'This', right: 'That' },
      renderSide: async (side, path) => {
        order.push(side);
        clip(side, path);
        return ok;
      },
    });
    expect(order).toEqual(['left', 'right']);
    expect(result.verification.ok).toBe(true);
    expect(result.frames).toBe(10);

    // One frame's pixels: red on the left half, blue on the right.
    const frame = spawnSync(FFMPEG_EXE, ['-v', 'error', '-i', outputPath, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 1 << 24 }).stdout;
    expect(frame.length).toBe(640 * 180 * 3);
    const at = (x: number) => [...frame.subarray((90 * 640 + x) * 3, (90 * 640 + x) * 3 + 3)];
    const [red, , blueOnLeft] = at(160) as [number, number, number];
    const [redOnRight, , blue] = at(480) as [number, number, number];
    expect(red).toBeGreaterThan(200);
    expect(blueOnLeft).toBeLessThan(60);
    expect(redOnRight).toBeLessThan(60);
    expect(blue).toBeGreaterThan(200);

    const report = JSON.parse(await readFile(result.reportPath, 'utf8')) as { comparison: unknown };
    expect(report.comparison).toEqual({ left: 'This', right: 'That', length: 'the shorter timeline', sound: 'left' });
  });

  it('stops at a side that fails verification, and writes nothing', async () => {
    const outputPath = join(root, 'ab.mp4');
    await expect(renderComparison({
      ffmpegExe: FFMPEG_EXE, ffprobeExe: FFPROBE_EXE, settings, outputPath, workDir: join(root, 'work'),
      labels: { left: 'This', right: 'That' },
      renderSide: async (side, path) => {
        clip(side, path);
        return side === 'right' ? { frames: 10, report: { verification: { ok: false, issues: ['frame count'] } } } : ok;
      },
    })).rejects.toThrow('The right render failed verification: frame count');
    expect(existsSync(outputPath)).toBe(false);
  });
});
