// Decode any audio file to mono 48 kHz float PCM via the vendored FFmpeg (PROJECT.md §8.1).
// The FFmpeg path is passed in: callers resolve it from vendor/, never from PATH.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { ANALYSIS_SAMPLE_RATE } from './spectrum.ts';

export interface DecodedAudio {
  readonly pcm: Float32Array;
  readonly sampleRate: number;
  /** SHA-256 of the decoded PCM, not the file: a re-encode of the same audio hits the same cache (data-formats §4.3). */
  readonly pcmSha256: string;
}

export class DecodeError extends Error {
  readonly stderr: string;
  constructor(message: string, stderr: string) {
    super(message);
    this.name = 'DecodeError';
    this.stderr = stderr;
  }
}

export function decodeMono48k(ffmpegExe: string, inputPath: string): Promise<DecodedAudio> {
  const args = [
    '-nostdin', '-hide_banner', '-loglevel', 'error',
    '-i', inputPath,
    '-map', '0:a:0',
    '-ac', '1',
    '-ar', String(ANALYSIS_SAMPLE_RATE),
    '-c:a', 'pcm_f32le', '-f', 'f32le',
    'pipe:1',
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegExe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-16_000);
    });
    child.on('error', (error) => reject(new DecodeError(`could not start ${ffmpegExe}: ${error.message}`, stderr)));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new DecodeError(`ffmpeg could not decode ${inputPath} (exit ${code}): ${stderr.trim().split('\n').pop() ?? ''}`, stderr));
        return;
      }
      const bytes = Buffer.concat(chunks);
      const usable = bytes.length - (bytes.length % 4);
      // Copy into a fresh, aligned ArrayBuffer: Buffer.concat may return a pooled slice.
      const aligned = new ArrayBuffer(usable);
      new Uint8Array(aligned).set(bytes.subarray(0, usable));
      resolve({
        pcm: new Float32Array(aligned),
        sampleRate: ANALYSIS_SAMPLE_RATE,
        pcmSha256: createHash('sha256').update(new Uint8Array(aligned)).digest('hex'),
      });
    });
  });
}
