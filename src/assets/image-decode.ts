// Image file → decoded pixels, through the vendored FFmpeg (never Chromium's decoder).
//
// The preview and the export both decode here, in Node, so they cannot disagree about a pixel —
// the same reason audio analysis runs through FFmpeg rather than Web Audio (ipc.ts). The result is
// what the engine's ImageStore takes: RGBA8, straight alpha, sRGB, top row first.
//
// Known limits, stated rather than discovered: the first frame of an animated file is used; EXIF
// orientation is not applied; embedded ICC profiles are ignored (the pixels are treated as sRGB).

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import type { DecodedImage } from '../engine/core/image.ts';

/** Beyond this an image is scaled down on decode. Far past any 4K canvas, well inside GPU limits. */
export const MAX_IMAGE_SIDE = 8192;

export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff', 'gif'] as const;

export interface ImportedImage extends DecodedImage {
  /** SHA-256 of the file's bytes — the asset hash (data-formats §1.2). */
  readonly sha256: string;
  /** The file's size in bytes. */
  readonly fileSize: number;
  readonly name: string;
  /** The file's own size, before any downscale. */
  readonly sourceWidth: number;
  readonly sourceHeight: number;
}

export class ImageDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageDecodeError';
  }
}

function run(exe: string, args: readonly string[]): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => (stderr = (stderr + c.toString()).slice(-8000)));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout: Buffer.concat(chunks), stderr }));
  });
}

/** The size an image decodes to: unchanged, or scaled so its longer side is `maxSide`. */
export function decodeSize(width: number, height: number, maxSide = MAX_IMAGE_SIDE): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxSide) return { width, height };
  const scale = maxSide / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export async function decodeImageFile(ffmpegExe: string, ffprobeExe: string, path: string, maxSide = MAX_IMAGE_SIDE): Promise<ImportedImage> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    throw new ImageDecodeError(`Could not read the image file ${path}: ${(error as Error).message}`);
  }

  const probe = await run(ffprobeExe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', path]);
  const stream = probe.code === 0 ? (JSON.parse(probe.stdout.toString()) as { streams?: { width?: number; height?: number }[] }).streams?.[0] : undefined;
  if (stream?.width === undefined || stream.height === undefined) {
    throw new ImageDecodeError(`${basename(path)} is not an image FFmpeg can read. ${probe.stderr.trim().split('\n').pop() ?? ''}`.trim());
  }

  const size = decodeSize(stream.width, stream.height, maxSide);
  const scale = size.width !== stream.width || size.height !== stream.height ? ['-vf', `scale=${size.width}:${size.height}:flags=lanczos`] : [];
  const decoded = await run(ffmpegExe, ['-v', 'error', '-nostdin', '-i', path, '-frames:v', '1', ...scale, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1']);
  if (decoded.code !== 0) {
    throw new ImageDecodeError(`FFmpeg could not decode ${basename(path)}: ${decoded.stderr.trim().split('\n').pop() ?? `exit ${decoded.code}`}`);
  }
  const expected = size.width * size.height * 4;
  if (decoded.stdout.length !== expected) {
    throw new ImageDecodeError(`${basename(path)} decoded to ${decoded.stdout.length} bytes, expected ${expected} for ${size.width}×${size.height}`);
  }

  return {
    width: size.width,
    height: size.height,
    // Copied into a fresh buffer: Buffer.concat may hand back a slice of Node's shared pool.
    pixels: new Uint8Array(decoded.stdout),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    fileSize: bytes.length,
    name: basename(path),
    sourceWidth: stream.width,
    sourceHeight: stream.height,
  };
}
