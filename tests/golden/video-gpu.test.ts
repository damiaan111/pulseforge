// Video layers end to end on the GPU (M39): a real clip extracted to the frame cache, then
// rendered — the frame on screen is the frame the cache holds, the same one every run.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { RenderProject } from '../../src/engine/core/project.ts';
import { rational } from '../../src/engine/core/time.ts';
import { extractSequence, hashVideoFile, sequenceDir } from '../../src/assets/video-cache.ts';
import { FFMPEG_EXE, FFPROBE_EXE } from '../../setup/lib/paths.ts';
import { bundleElectron } from '../../spike/harness.ts';
import { renderFrames, type RenderedFrame } from '../../spike/lib/frames-run.ts';

const ELECTRON = resolve(import.meta.dirname, '..', '..', 'node_modules', 'electron', 'dist', 'electron.exe');
const available = existsSync(ELECTRON) && existsSync(FFMPEG_EXE);
const ASSET = '0000000000A000000000000001';

let root: string;
let clip: string;
let videos: { hash: string; dir: string; frameCount: number }[] = [];

beforeAll(async () => {
  if (!available) return;
  await bundleElectron();
  root = await mkdtemp(join(tmpdir(), 'pulseforge-video-gpu-'));
  clip = join(root, 'clip.mp4');
  // Three seconds that change colour every second: red, then green, then blue. Which frame is on
  // screen is then readable from the pixels, which is the only way to check frame mapping.
  const made = spawnSync(FFMPEG_EXE, [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=red:s=160x90:d=1',
    '-f', 'lavfi', '-i', 'color=c=lime:s=160x90:d=1',
    '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:d=1',
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0,fps=30',
    '-c:v', 'mpeg4', '-q:v', '2', clip,
  ], { windowsHide: true });
  if (made.status !== 0) throw new Error(`could not create the test clip: ${made.stderr?.toString()}`);

  const hash = await hashVideoFile(clip);
  const sequence = await extractSequence({
    ffmpegExe: FFMPEG_EXE, ffprobeExe: FFPROBE_EXE, root, path: clip, videoHash: hash,
    fps: rational(30), width: 160,
  });
  videos = [{ hash, dir: sequenceDir(root, hash, rational(30), 160), frameCount: sequence.frameCount }];
}, 180_000);

afterAll(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

function project(params: Record<string, unknown>, inTicks = 0): RenderProject {
  return {
    schemaVersion: 0,
    seed: 1,
    durationTicks: 48_000 * 4,
    canvas: { width: 160, height: 90, fps: rational(30), background: '#000000' },
    audio: { leadInTicks: 0, clipInTicks: 0 },
    layers: [{
      id: 'clip', module: 'core.source.video', enabled: true, opacity: 1, blend: 'normal', params,
      timeRange: { inTicks, outTicks: null },
    }],
    assets: { [ASSET]: { kind: 'video' as const, hash: videos[0]?.hash ?? '', name: 'clip.mp4' } },
  };
}

/** Which of the clip's three seconds is on screen, from the centre pixel. */
function colour(frame: RenderedFrame): 'red' | 'green' | 'blue' | 'other' {
  const { r, g, b } = frame.at(80, 45);
  if (r > 120 && g < 80 && b < 80) return 'red';
  if (g > 120 && r < 80 && b < 80) return 'green';
  if (b > 120 && r < 80 && g < 80) return 'blue';
  return 'other';
}

describe.skipIf(!available)('video layer on the GPU', () => {
  it('extracted one still per rendered frame', () => {
    expect(videos[0]?.frameCount).toBeGreaterThanOrEqual(88);
  });

  it('shows the frame the timeline is on, and the same one when rendered out of order', async () => {
    const forwards = await renderFrames({ name: 'video-forward', project: project({ video: ASSET }), frames: [5, 45, 75], videos });
    expect(forwards.frames.map(colour)).toEqual(['red', 'green', 'blue']);

    const scrambled = await renderFrames({ name: 'video-scrambled', project: project({ video: ASSET }), frames: [75, 5, 45], videos });
    const byIndex = (run: { frames: readonly RenderedFrame[] }) => Object.fromEntries(run.frames.map((f) => [f.frameIndex, f.sha256]));
    expect(byIndex(scrambled)).toEqual(byIndex(forwards));
  }, 180_000);

  it('starts when its layer starts, not when the timeline does', async () => {
    // The layer begins at 1 s, so at 1.2 s the clip is 0.2 s in: still red.
    const run = await renderFrames({ name: 'video-in', project: project({ video: ASSET }, 48_000), frames: [36], videos });
    expect(colour(run.frames[0]!)).toBe('red');
  }, 180_000);

  it('trims with startSeconds and speeds up with speed', async () => {
    const trimmed = await renderFrames({ name: 'video-trim', project: project({ video: ASSET, startSeconds: 2 }), frames: [2], videos });
    expect(colour(trimmed.frames[0]!)).toBe('blue');

    // At 2× speed the second second of the clip arrives after half a second.
    const fast = await renderFrames({ name: 'video-speed', project: project({ video: ASSET, speed: 2 }), frames: [18], videos });
    expect(colour(fast.frames[0]!)).toBe('green');
  }, 180_000);

  it('loops, or holds the last frame when looping is off', async () => {
    const looped = await renderFrames({ name: 'video-loop', project: project({ video: ASSET, loop: true }), frames: [95], videos });
    expect(colour(looped.frames[0]!)).toBe('red'); // wrapped back to the start

    const held = await renderFrames({ name: 'video-hold', project: project({ video: ASSET, loop: false }), frames: [200], videos });
    expect(colour(held.frames[0]!)).toBe('blue'); // parked on the last frame
  }, 180_000);

  it('draws the missing-clip checkerboard and warns when nothing is extracted', async () => {
    const run = await renderFrames({ name: 'video-missing', project: project({ video: ASSET }), frames: [0] });
    expect(run.warnings.some((w) => w.includes('no extracted frames'))).toBe(true);
    expect(colour(run.frames[0]!)).toBe('other');
  }, 180_000);
});
