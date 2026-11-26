// The video frame cache (M39, D4, compositor-spec §8).
//
// A video is the one input whose natural API fights determinism: `HTMLVideoElement` decodes on a
// wall clock and "which frame am I on" has no dependable answer. So decode is decoupled from
// render entirely — on import the video is extracted **once** to a folder of still frames at the
// project's fps, and rendering frame n reads cached frame map(n). Exact, seekable, and identical
// in preview and export.
//
// Layout, keyed so two projects at the same fps and width share one extraction:
//
//   <root>/video/<videoHash>/<fpsNum>-<fpsDen>-<width>/
//       index.json          what this sequence is, and whether it finished
//       frame-000001.jpg …  one still per rendered frame
//
// JPEG rather than PNG: a 4-minute 1080p sequence is a few GB either way, and the disk is the
// stated cost of this design (M33 attributes it). Quality 2 is visually lossless at these sizes
// and decodes fast; the proxy width for preview is a separate entry under the same video hash.
//
// Extraction is **resumable and idempotent**: a complete index means a hit, an incomplete one is
// re-extracted rather than trusted, and a half-written folder never reads as done.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { renameIntoPlace, tempPathFor } from '../node/rename-into-place.ts';
import type { Rational } from '../engine/core/time.ts';

export { VIDEO_EXTENSIONS } from './media-types.ts';

/** Preview runs from a narrower sequence; export always uses the project's own width. */
export const PROXY_WIDTH = 640;

export const INDEX_VERSION = 1;

export interface VideoInfo {
  readonly width: number;
  readonly height: number;
  readonly durationSeconds: number;
  /** Source frame rate, as reported. Informational: the cache is always at the project's fps. */
  readonly sourceFps: number;
}

export interface VideoSequence {
  readonly indexVersion: number;
  readonly videoHash: string;
  readonly fps: { readonly num: number; readonly den: number };
  readonly width: number;
  readonly height: number;
  readonly frameCount: number;
  readonly source: VideoInfo;
  readonly bytes: number;
  readonly extractedAt: string;
  /** False while extracting; a reader treats anything but true as a miss. */
  readonly complete: boolean;
}

export interface ExtractOptions {
  readonly ffmpegExe: string;
  readonly ffprobeExe: string;
  /** Cache root — the same directory the analysis cache uses (M33). */
  readonly root: string;
  readonly path: string;
  readonly videoHash: string;
  readonly fps: Rational;
  /** Output width; height follows the source aspect, rounded to an even number. */
  readonly width: number;
  /** Stop after this many frames — the timeline's length, so a long clip is not extracted whole. */
  readonly maxFrames?: number;
  readonly onProgress?: (frames: number) => void;
  readonly signal?: AbortSignal;
}

export class VideoCacheError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VideoCacheError';
  }
}

export function sequenceDir(root: string, videoHash: string, fps: Rational, width: number): string {
  return join(root, 'video', videoHash, `${fps.num}-${fps.den}-${width}`);
}

export function framePath(dir: string, frameIndex: number): string {
  return join(dir, `frame-${String(frameIndex + 1).padStart(6, '0')}.jpg`);
}

/** The finished sequence in this folder, or null when there is none (a miss, never an error). */
export async function readSequence(dir: string): Promise<VideoSequence | null> {
  let text: string;
  try {
    text = await readFile(join(dir, 'index.json'), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as VideoSequence;
    if (parsed.indexVersion !== INDEX_VERSION || parsed.complete !== true || parsed.frameCount <= 0) return null;
    return parsed;
  } catch {
    return null; // A corrupt index is a miss: the cache is rebuildable.
  }
}

function run(exe: string, args: readonly string[], onLine?: (line: string) => void, signal?: AbortSignal): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let rest = '';
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr = (stderr + text).slice(-8000);
      if (onLine === undefined) return;
      rest += text;
      const lines = rest.split(/\r?\n|\r/);
      rest = lines.pop() ?? '';
      for (const line of lines) onLine(line);
    });
    const abort = () => child.kill();
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', reject);
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort);
      resolve({ code: code ?? -1, stderr });
    });
  });
}

export async function probeVideo(ffprobeExe: string, path: string): Promise<VideoInfo> {
  const { spawnSync } = await import('node:child_process');
  const probe = spawnSync(ffprobeExe, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,avg_frame_rate:format=duration',
    '-of', 'json', path,
  ], { windowsHide: true, encoding: 'utf8' });
  if (probe.status !== 0) throw new VideoCacheError(`FFprobe could not read ${path}: ${probe.stderr?.trim().split('\n').pop() ?? ''}`);
  const parsed = JSON.parse(probe.stdout) as {
    streams?: { width?: number; height?: number; avg_frame_rate?: string }[];
    format?: { duration?: string };
  };
  const stream = parsed.streams?.[0];
  if (stream?.width === undefined || stream.height === undefined) {
    throw new VideoCacheError(`${path} has no video stream FFmpeg can read`);
  }
  const [num, den] = (stream.avg_frame_rate ?? '0/1').split('/').map(Number);
  return {
    width: stream.width,
    height: stream.height,
    durationSeconds: Number(parsed.format?.duration ?? 0),
    sourceFps: den === undefined || den === 0 || num === undefined ? 0 : num / den,
  };
}

/**
 * Even, and never upscaled past the source: a proxy of a 320-wide clip is still 320 wide.
 * Rounded **down** to even, so clamping to an odd source width cannot round back above it.
 */
export function targetSize(info: VideoInfo, width: number): { width: number; height: number } {
  const w = Math.max(2, Math.floor(Math.min(width, info.width) / 2) * 2);
  const h = Math.max(2, Math.floor((w * info.height) / info.width / 2) * 2);
  return { width: w, height: h };
}

/**
 * Extracts (or reuses) the frame sequence for one video at one fps and width.
 *
 * FFmpeg's `fps` filter decides which source frame lands on each output frame, and it does so the
 * same way every run — that determinism is the whole point of extracting rather than seeking.
 */
export async function extractSequence(options: ExtractOptions): Promise<VideoSequence> {
  const { ffmpegExe, ffprobeExe, root, path, videoHash, fps, width } = options;
  if (!existsSync(path)) throw new VideoCacheError(`Video not found: ${path}`);
  const dir = sequenceDir(root, videoHash, fps, width);

  const existing = await readSequence(dir);
  if (existing !== null && (options.maxFrames === undefined || existing.frameCount >= options.maxFrames)) {
    options.onProgress?.(existing.frameCount);
    return existing;
  }

  const info = await probeVideo(ffprobeExe, path);
  const size = targetSize(info, width);
  // A half-finished folder from an interrupted run must not be mixed with this one's frames.
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  const args = [
    '-v', 'error', '-nostdin', '-i', path,
    '-vf', `fps=${fps.num}/${fps.den},scale=${size.width}:${size.height}:flags=bicubic`,
    '-fps_mode', 'passthrough',
    ...(options.maxFrames === undefined ? [] : ['-frames:v', String(options.maxFrames)]),
    '-q:v', '2',
    '-progress', 'pipe:2', '-stats_period', '0.2',
    join(dir, 'frame-%06d.jpg'),
  ];
  const result = await run(ffmpegExe, args, (line) => {
    const match = /^frame=(\d+)/.exec(line.trim());
    if (match?.[1] !== undefined) options.onProgress?.(Number(match[1]));
  }, options.signal);
  if (options.signal?.aborted === true) {
    await rm(dir, { recursive: true, force: true });
    throw new VideoCacheError('Video extraction was cancelled');
  }
  if (result.code !== 0) {
    await rm(dir, { recursive: true, force: true });
    throw new VideoCacheError(`FFmpeg could not extract frames from ${path}: ${result.stderr.trim().split('\n').pop() ?? `exit ${result.code}`}`);
  }

  const files = (await readdir(dir)).filter((name) => name.endsWith('.jpg'));
  if (files.length === 0) {
    await rm(dir, { recursive: true, force: true });
    throw new VideoCacheError(`${path} produced no frames at ${fps.num}/${fps.den} fps`);
  }
  let bytes = 0;
  for (const file of files) bytes += (await stat(join(dir, file))).size;

  const sequence: VideoSequence = {
    indexVersion: INDEX_VERSION,
    videoHash,
    fps: { num: fps.num, den: fps.den },
    width: size.width,
    height: size.height,
    frameCount: files.length,
    source: info,
    bytes,
    extractedAt: new Date().toISOString(),
    complete: true,
  };
  // Written last and atomically: the index is what makes the folder a hit, so it must never
  // appear before the frames it describes.
  const indexPath = join(dir, 'index.json');
  const temp = tempPathFor(indexPath);
  await writeFile(temp, `${JSON.stringify(sequence, null, 2)}\n`, 'utf8');
  await renameIntoPlace(temp, indexPath);
  return sequence;
}

/** Total bytes of extracted video sequences, for the cache breakdown (M33). */
export async function videoCacheSize(root: string): Promise<number> {
  const base = join(root, 'video');
  let total = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else total += (await stat(full)).size;
    }
  };
  await walk(base);
  return total;
}

/** The content hash a video asset is keyed by: SHA-256 of the file's bytes. */
export async function hashVideoFile(path: string): Promise<string> {
  const { createReadStream } = await import('node:fs');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
