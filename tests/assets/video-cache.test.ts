// The video frame cache (M39): extraction at the project's fps, reuse, and honest misses.
// Uses the vendored FFmpeg on a short generated clip, so it exercises the real decode path.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  PROXY_WIDTH, extractSequence, framePath, hashVideoFile, probeVideo, readSequence, sequenceDir,
  targetSize, videoCacheSize, VideoCacheError,
} from '../../src/assets/video-cache.ts';
import { rational } from '../../src/engine/core/time.ts';
import { FFMPEG_EXE, FFPROBE_EXE } from '../../setup/lib/paths.ts';

const available = existsSync(FFMPEG_EXE) && existsSync(FFPROBE_EXE);
let root: string;
let clip: string;

beforeAll(() => {
  if (!available) return;
  // Two seconds of moving colour bars at 25 fps, 320×180. Encoded with the built-in `mpeg4`:
  // the vendored FFmpeg is an LGPL build, so libx264 is not in it.
  const dir = tmpdir();
  clip = join(dir, 'pulseforge-test-clip.mp4');
  if (!existsSync(clip)) {
    const made = spawnSync(FFMPEG_EXE, [
      '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=2',
      '-c:v', 'mpeg4', '-q:v', '4', '-pix_fmt', 'yuv420p', clip,
    ], { windowsHide: true });
    if (made.status !== 0) throw new Error(`could not create the test clip: ${made.stderr?.toString()}`);
  }
}, 60_000);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pulseforge-video-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe.skipIf(!available)('video frame cache', () => {
  it('probes the clip', async () => {
    const info = await probeVideo(FFPROBE_EXE, clip);
    expect([info.width, info.height]).toEqual([320, 180]);
    expect(info.durationSeconds).toBeCloseTo(2, 1);
    expect(info.sourceFps).toBeCloseTo(25, 1);
  }, 60_000);

  it('extracts one frame per rendered frame at the project fps', async () => {
    const hash = await hashVideoFile(clip);
    const progress: number[] = [];
    const sequence = await extractSequence({
      ffmpegExe: FFMPEG_EXE, ffprobeExe: FFPROBE_EXE, root, path: clip, videoHash: hash,
      fps: rational(30), width: 320, onProgress: (n) => progress.push(n),
    });
    // 2 s at 30 fps; FFmpeg's fps filter may land one either side of the boundary.
    expect(sequence.frameCount).toBeGreaterThanOrEqual(59);
    expect(sequence.frameCount).toBeLessThanOrEqual(61);
    expect(sequence.width).toBe(320);
    expect(sequence.height).toBe(180);
    expect(sequence.complete).toBe(true);
    expect(sequence.bytes).toBeGreaterThan(0);
    expect(progress.at(-1)).toBeGreaterThan(0);

    const dir = sequenceDir(root, hash, rational(30), 320);
    expect(existsSync(framePath(dir, 0))).toBe(true);
    expect(existsSync(framePath(dir, sequence.frameCount - 1))).toBe(true);
    expect(await videoCacheSize(root)).toBe(sequence.bytes + (await readFile(join(dir, 'index.json'))).length);
  }, 120_000);

  it('reuses a finished sequence instead of extracting again', async () => {
    const hash = await hashVideoFile(clip);
    const options = {
      ffmpegExe: FFMPEG_EXE, ffprobeExe: FFPROBE_EXE, root, path: clip, videoHash: hash,
      fps: rational(10), width: 160,
    };
    const first = await extractSequence(options);
    const second = await extractSequence(options);
    expect(second.extractedAt).toBe(first.extractedAt); // the same index, not a re-run
  }, 120_000);

  it('treats an incomplete or corrupt index as a miss', async () => {
    const hash = await hashVideoFile(clip);
    const fps = rational(10);
    await extractSequence({ ffmpegExe: FFMPEG_EXE, ffprobeExe: FFPROBE_EXE, root, path: clip, videoHash: hash, fps, width: 160 });
    const dir = sequenceDir(root, hash, fps, 160);
    const index = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')) as Record<string, unknown>;

    await writeFile(join(dir, 'index.json'), JSON.stringify({ ...index, complete: false }));
    expect(await readSequence(dir)).toBeNull();
    await writeFile(join(dir, 'index.json'), 'not json');
    expect(await readSequence(dir)).toBeNull();
    expect(await readSequence(join(root, 'video', 'nothing-here'))).toBeNull();
  }, 120_000);

  it('stops at maxFrames, so a long clip is not extracted whole', async () => {
    const hash = await hashVideoFile(clip);
    const sequence = await extractSequence({
      ffmpegExe: FFMPEG_EXE, ffprobeExe: FFPROBE_EXE, root, path: clip, videoHash: hash,
      fps: rational(30), width: 160, maxFrames: 12,
    });
    expect(sequence.frameCount).toBe(12);
  }, 120_000);

  it('names a missing file rather than failing obscurely', async () => {
    await expect(extractSequence({
      ffmpegExe: FFMPEG_EXE, ffprobeExe: FFPROBE_EXE, root, path: join(root, 'nope.mp4'),
      videoHash: 'x', fps: rational(30), width: 320,
    })).rejects.toThrow(VideoCacheError);
  }, 60_000);
});

describe('targetSize', () => {
  const info = { width: 1920, height: 1080, durationSeconds: 1, sourceFps: 30 };

  it('keeps the aspect, stays even, and never upscales', () => {
    expect(targetSize(info, PROXY_WIDTH)).toEqual({ width: 640, height: 360 });
    expect(targetSize(info, 4000)).toEqual({ width: 1920, height: 1080 });
    expect(targetSize({ ...info, width: 321, height: 181 }, 321)).toEqual({ width: 320, height: 180 });
  });
});
