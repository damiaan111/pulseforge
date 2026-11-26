// Beat refinement (S16): one run of `python -m pulseforge_ml beats` (python/pulseforge_ml/beats.py).
//
// A plain child process rather than a sidecar request: librosa runs on the CPU, so it needs neither
// the sidecar's loaded models nor its place in the GPU queue, and a process that exits gives its
// memory back. It is the only caller of librosa, and nothing that renders calls it.

import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { parseBeatRefinement, type BeatRefinement } from '../analysis/beat-refinement.ts';

export const BEAT_TOOL = 'librosa';

export class BeatTrackingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BeatTrackingError';
  }
}

export interface RefineBeatsOptions {
  readonly pythonExe: string;
  /** The folder holding the `pulseforge_ml` package. */
  readonly packageDir: string;
  readonly env: NodeJS.ProcessEnv;
  /** Mono, 48 kHz: the song, or its drum stem when it has one worth following. */
  readonly pcm: Float32Array;
  /** The hash of the track, which is not `pcm`'s when that is a stem. */
  readonly audioHash: string;
  readonly workDir: string;
  readonly signal?: AbortSignal;
}

export async function refineBeats(options: RefineBeatsOptions): Promise<BeatRefinement> {
  // Absolute: the child runs in the package folder.
  await mkdir(options.workDir, { recursive: true });
  const input = resolve(options.workDir, `beats-${options.audioHash.slice(0, 16)}.f32`);
  await writeFile(input, new Uint8Array(options.pcm.buffer, options.pcm.byteOffset, options.pcm.byteLength));
  try {
    const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const child = spawn(options.pythonExe, ['-m', 'pulseforge_ml', 'beats', '--input', input, '--sample-rate', '48000'], {
        cwd: options.packageDir, env: options.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
      child.stderr.on('data', (chunk: Buffer) => (stderr = (stderr + chunk.toString('utf8')).slice(-4000)));
      child.on('error', (error) => reject(error.name === 'AbortError' ? new BeatTrackingError('Beat refinement was cancelled.') : error));
      child.on('close', (code) => {
        const events = stdout.split(/\r?\n/).filter((line) => line.startsWith('{')).map((line) => JSON.parse(line) as Record<string, unknown>);
        const done = events.find((event) => event['event'] === 'beats');
        if (code === 0 && done !== undefined) return resolve(done);
        if (/No module named '?librosa/.test(stderr + stdout)) {
          return reject(new BeatTrackingError('Beat refinement is not installed. Add it in Settings → Components.'));
        }
        const failure = events.find((event) => event['event'] === 'error');
        reject(new BeatTrackingError(`Beat tracking failed: ${String(failure?.['message'] ?? (stderr.trim().split(/\r?\n/).pop() || `exit ${code}`))}`));
      });
    });
    if (!Array.isArray(result['beats']) || result['beats'].length < 2) throw new BeatTrackingError('No steady pulse was found in this audio.');
    return parseBeatRefinement({ ...result, audioHash: options.audioHash, tool: BEAT_TOOL }) as BeatRefinement;
  } finally {
    await rm(input, { force: true });
  }
}

/** The drum stem carries the beat when there is enough of it to follow (PROJECT.md §8.1). */
export function worthFollowing(drums: Float32Array, mix: Float32Array): boolean {
  const energy = (pcm: Float32Array) => {
    let sum = 0;
    for (let i = 0; i < pcm.length; i += 16) sum += (pcm[i] as number) ** 2;
    return sum;
  };
  return energy(drums) >= 0.1 * energy(mix);
}
