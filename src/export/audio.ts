// Export-ready audio (export-spec §7, PROJECT.md §8.10).
//
// Decode → trim to the clip → lead-in silence → pad or cut to exactly the video's length.
// Done in sample arithmetic here rather than with FFmpeg filters, so the placement is exact,
// testable, and the adjustment can be reported. The result is a float WAV that the encoder
// muxes as AAC. Video length is authoritative; `-shortest` is never used.

import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { frameCount, type Rational } from '../engine/core/time.ts';

export const EXPORT_SAMPLE_RATE = 48_000;

export type AudioSource =
  | { readonly kind: 'file'; readonly path: string; readonly ffmpegExe: string }
  | { readonly kind: 'pcm'; readonly channels: readonly Float32Array[]; readonly sampleRate: 48_000 };

export interface AudioPlacement {
  /** Silence before the audio on the timeline. */
  readonly leadInSamples: number;
  /** First source sample used. */
  readonly clipInSamples: number;
  /** One past the last source sample used; undefined = to the end. */
  readonly clipOutSamples: number | undefined;
}

export interface PreparedAudio {
  readonly path: string;
  readonly channels: number;
  readonly totalSamples: number;
  /** Source samples placed after trimming. */
  readonly sourceSamples: number;
  /** >0: silence appended to reach the video length; <0: samples cut off the end. */
  readonly adjustmentSamples: number;
}

/** Samples covering exactly N frames: N · 48000 · den / num, rounded to the nearest sample. */
export function samplesForFrames(frames: number, fps: Rational): number {
  const numerator = BigInt(frames) * BigInt(EXPORT_SAMPLE_RATE) * BigInt(fps.den);
  const denominator = BigInt(fps.num);
  return Number((numerator * 2n + denominator) / (2n * denominator));
}

/** Frames needed to show `samples` of timeline (48 kHz ticks == samples, D10). */
export function framesForSamples(samples: number, fps: Rational): number {
  return frameCount(samples, fps);
}

export function placeAudio(source: readonly Float32Array[], placement: AudioPlacement, totalSamples: number): { channels: Float32Array[]; sourceSamples: number; adjustmentSamples: number } {
  const channelCount = Math.max(1, source.length);
  const available = source[0]?.length ?? 0;
  const clipIn = Math.min(Math.max(0, placement.clipInSamples), available);
  const clipOut = Math.min(available, placement.clipOutSamples ?? available);
  const sourceSamples = Math.max(0, clipOut - clipIn);
  const leadIn = Math.max(0, placement.leadInSamples);
  const channels = Array.from({ length: channelCount }, (_, c) => {
    const out = new Float32Array(totalSamples);
    const input = source[c] ?? source[0];
    if (input !== undefined && leadIn < totalSamples) {
      const copy = Math.min(sourceSamples, totalSamples - leadIn);
      out.set(input.subarray(clipIn, clipIn + copy), leadIn);
    }
    return out;
  });
  return { channels, sourceSamples, adjustmentSamples: totalSamples - (leadIn + sourceSamples) };
}

/** 32-bit float WAV (WAVE_FORMAT_IEEE_FLOAT), interleaved. */
export function encodeWavFloat32(channels: readonly Float32Array[], sampleRate: number): Uint8Array {
  const channelCount = channels.length;
  const frames = channels[0]?.length ?? 0;
  const dataBytes = frames * channelCount * 4;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => [...text].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true); // IEEE float
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * 4, true);
  view.setUint16(32, channelCount * 4, true);
  view.setUint16(34, 32, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channelCount; c++) {
      view.setFloat32(offset, channels[c]?.[i] ?? 0, true);
      offset += 4;
    }
  }
  return bytes;
}

/** Decodes a file to 48 kHz stereo float, keeping the source's channel layout (mono is duplicated). */
export function decodeStereo48k(ffmpegExe: string, path: string): Promise<Float32Array[]> {
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', path, '-map', '0:a:0', '-ac', '2', '-ar', String(EXPORT_SAMPLE_RATE), '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1'];
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegExe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => (stderr = (stderr + c.toString()).slice(-8000)));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`could not decode audio ${path} (exit ${code}): ${stderr.trim().split('\n').pop() ?? ''}`));
        return;
      }
      const bytes = Buffer.concat(chunks);
      const frames = Math.floor(bytes.length / 8);
      const left = new Float32Array(frames);
      const right = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        left[i] = bytes.readFloatLE(i * 8);
        right[i] = bytes.readFloatLE(i * 8 + 4);
      }
      resolve([left, right]);
    });
  });
}

export async function prepareExportAudio(source: AudioSource, placement: AudioPlacement, totalSamples: number, outPath: string): Promise<PreparedAudio> {
  const decoded = source.kind === 'file' ? await decodeStereo48k(source.ffmpegExe, source.path) : [...source.channels];
  const placed = placeAudio(decoded, placement, totalSamples);
  await writeFile(outPath, encodeWavFloat32(placed.channels, EXPORT_SAMPLE_RATE));
  return {
    path: outPath,
    channels: placed.channels.length,
    totalSamples,
    sourceSamples: placed.sourceSamples,
    adjustmentSamples: placed.adjustmentSamples,
  };
}
