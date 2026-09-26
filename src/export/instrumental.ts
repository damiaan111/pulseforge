// Karaoke export (PROJECT.md S15, export-spec §7): "a karaoke variant substitutes the instrumental
// stem sum; everything else is identical". The stems Demucs already wrote for the track (M5) —
// every one but the vocals — are summed into one 48 kHz stereo WAV, which then goes through the
// export's audio path exactly as the song would: lead-in, trim, gain and fades, video-length
// reconciliation. Stems are the same length as the song they came from, so every placement in
// source samples means the same moment in the sum.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { stemsForModel } from '../analysis/stem-models.ts';
import type { Stem } from '../engine/core/params.ts';

/** What the instrumental is made of, for a model: every stem it separates except the vocals. */
export function instrumentalStems(model: string): readonly Stem[] {
  return stemsForModel(model).filter((stem) => stem !== 'vocals');
}

export class InstrumentalError extends Error {
  readonly fixes: readonly string[];
  constructor(message: string, fixes: readonly string[]) {
    super(message);
    this.name = 'InstrumentalError';
    this.fixes = fixes;
  }
}

export interface BuildInstrumentalOptions {
  readonly ffmpegExe: string;
  /** `<stemsRoot>/<audioHash>/<model>`: where separation wrote the stems' FLACs. */
  readonly stemDir: string;
  readonly model: string;
  readonly outPath: string;
  readonly signal?: AbortSignal;
}

/**
 * Sums the instrumental stems into `outPath` (48 kHz stereo float WAV). Refuses, naming what is
 * missing and how to get it, when the track's stems have not been separated with this model —
 * a karaoke render without its instrumental would otherwise quietly ship the vocals.
 */
export async function buildInstrumental(options: BuildInstrumentalOptions): Promise<{ readonly path: string; readonly stems: readonly Stem[] }> {
  const stems = instrumentalStems(options.model);
  const files = stems.map((stem) => join(options.stemDir, `${stem}.flac`));
  const missing = stems.filter((_, i) => !existsSync(files[i] as string));
  if (missing.length > 0) {
    throw new InstrumentalError(
      `A karaoke render needs the track's stems (${options.model}), and ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not separated yet.`,
      ['Separate stems in the Audio panel (or `npm run batch -- … --stems`), then render again', 'Or render with the full mix'],
    );
  }
  await mkdir(dirname(options.outPath), { recursive: true });
  // amix averages unless told not to; normalize=0 makes it the plain sum Demucs' stems add up to.
  const args = [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    ...files.flatMap((file) => ['-i', file]),
    '-filter_complex', `amix=inputs=${files.length}:normalize=0:duration=longest`,
    '-ac', '2', '-ar', '48000', '-c:a', 'pcm_f32le', options.outPath,
  ];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(options.ffmpegExe, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    const onAbort = () => child.kill();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', reject);
    child.on('close', (code) => {
      options.signal?.removeEventListener('abort', onAbort);
      if (options.signal?.aborted === true) reject(new Error('cancelled'));
      else if (code === 0) resolve();
      else reject(new Error(`FFmpeg could not mix the stems (exit ${code}): ${stderr.trim().split('\n').pop() ?? ''}`));
    });
  });
  return { path: options.outPath, stems };
}
