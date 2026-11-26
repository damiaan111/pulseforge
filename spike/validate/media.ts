// FFmpeg helpers for measuring exported files: decode frames, planes and audio to raw buffers.

import { spawn } from 'node:child_process';
import { FFMPEG_EXE } from '../../setup/lib/paths.ts';

export function runFfmpeg(args: readonly string[]): Promise<{ code: number; stdout: Buffer; stderr: string; ms: number }> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_EXE, ['-hide_banner', '-nostdin', ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => (stderr = (stderr + c.toString()).slice(-16_000)));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout: Buffer.concat(chunks), stderr, ms: performance.now() - started }));
  });
}

async function mustRun(args: readonly string[], what: string): Promise<Buffer> {
  const result = await runFfmpeg(args);
  if (result.code !== 0) throw new Error(`${what} failed (exit ${result.code}): ${result.stderr.trim().split('\n').pop() ?? ''}`);
  return result.stdout;
}

/**
 * Decodes one frame to full-range RGB with an explicit BT.709 limited-range interpretation, so the
 * measurement does not depend on how the file is tagged. 8-bit → rgb24, 10-bit → rgb48le.
 */
export function decodeFrameRgb(path: string, frameIndex: number, deep: boolean): Promise<Buffer> {
  return mustRun(
    ['-loglevel', 'error', '-i', path, '-vf', `select='eq(n\\,${frameIndex})',scale=in_color_matrix=bt709:in_range=tv:out_range=pc:flags=accurate_rnd+full_chroma_int,format=${deep ? 'rgb48le' : 'rgb24'}`, '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'],
    `decoding frame ${frameIndex} of ${path}`,
  );
}

/** Raw luma plane of one frame (gray for 8-bit, gray10le for 10-bit). */
export function decodeFrameLuma(path: string, frameIndex: number, deep: boolean): Promise<Buffer> {
  return mustRun(
    ['-loglevel', 'error', '-i', path, '-vf', `select='eq(n\\,${frameIndex})',extractplanes=y,format=${deep ? 'gray10le' : 'gray'}`, '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'],
    `extracting luma of frame ${frameIndex} of ${path}`,
  );
}

/** Mean luma per frame of a downscaled video (fast), for flash detection. */
export async function decodeMeanLuma(path: string): Promise<number[]> {
  const w = 32;
  const h = 18;
  const bytes = await mustRun(['-loglevel', 'error', '-i', path, '-vf', `scale=${w}:${h}:flags=area,format=gray`, '-f', 'rawvideo', 'pipe:1'], `decoding luma of ${path}`);
  const frames = Math.floor(bytes.length / (w * h));
  const means: number[] = [];
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = 0; i < w * h; i++) sum += bytes[f * w * h + i] ?? 0;
    means.push(sum / (w * h));
  }
  return means;
}

/** The file's first audio stream as mono 48 kHz float (AAC priming handled by FFmpeg's edit-list support). */
export async function decodeAudioMono(path: string): Promise<Float32Array> {
  const bytes = await mustRun(['-loglevel', 'error', '-i', path, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1'], `decoding audio of ${path}`);
  const out = new Float32Array(Math.floor(bytes.length / 4));
  for (let i = 0; i < out.length; i++) out[i] = bytes.readFloatLE(i * 4);
  return out;
}

/** Writes interleaved float PCM at `rate` from a 48 kHz WAV via FFmpeg's resampler (for Demucs at 44.1 kHz). */
export function resampleToRawFloat(input: string, output: string, rate: number, channels: number): Promise<Buffer> {
  return mustRun(['-loglevel', 'error', '-y', '-i', input, '-ac', String(channels), '-ar', String(rate), '-f', 'f32le', output], `resampling ${input}`);
}
