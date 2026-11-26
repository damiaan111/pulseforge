// Stems, end to end (M5, PROJECT.md §8.1, data-formats §4): separate a track with Demucs, analyse
// every stem the way the mix is analysed, and put them in the analysis cache beside it — so the
// preview, the render queue and the CLI all see `drums`, `bass`, `vocals` and `other` the moment
// they are ready, with no new plumbing (a cache hit already returns every ready source).
//
//   1. decode the file to mono 48 kHz — the same decode and hash as the mix, so it is the same
//      cache entry — and make sure the mix is analysed (the stems borrow its beat grid)
//   2. mark each stem pending, so a progress UI and a second window can see it is under way
//   3. decode to stereo 44.1 kHz float, which is what htdemucs takes, and ask the sidecar to
//      separate it (progress and cancellation go through the supervisor)
//   4. for each stem: one FFmpeg pass writes it as FLAC (kept for lyrics alignment and per-stem
//      waveforms later) and as mono 48 kHz float for analysis; analyse; write it to the cache
//
// A stem's `beat` feature is the mix's: the beat grid is a property of the song, not of what one
// instrument happens to be doing, and a binding on "drums · beat" must pulse on the same grid as
// one on "mix · beat" (modulation-spec §2.1: beat follows the grid, not the audio).
//
// Plain Node — no Electron — so it runs from a test or a script as well as from the app.

import { spawn } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { analyzeMix } from '../analysis/analyze.ts';
import { AnalysisCache } from '../analysis/cache.ts';
import { analyzeCached } from '../analysis/cached.ts';
import { decodeMono48k } from '../analysis/decode.ts';
import { analysisOptionsFor, cacheOptionsFor, type ProjectAnalysisSettings } from '../analysis/project-settings.ts';
import type { AnalysisTrack, SourceAnalysis } from '../engine/core/analysis.ts';
import { stemsForModel } from '../analysis/stem-models.ts';
import type { Stem } from '../engine/core/params.ts';

export { DEMUCS_6S_STEMS, DEMUCS_STEMS, stemsForModel } from '../analysis/stem-models.ts';

/** What the stem job needs from the sidecar: one request, with progress and cancellation. */
export interface StemSidecar {
  request(
    command: string,
    params: Readonly<Record<string, unknown>>,
    options: { onProgress?: (p: { fraction?: number; stage?: string }) => void; signal?: AbortSignal },
  ): Promise<Readonly<Record<string, unknown>>>;
}

export interface StemProgress {
  readonly stage: 'decoding' | 'separating' | 'analysing';
  /** Overall 0..1 across every stage. */
  readonly fraction: number;
  readonly detail?: string;
}

export interface SeparateStemsOptions {
  readonly ffmpegExe: string;
  readonly sidecar: StemSidecar;
  readonly cacheRoot: string;
  /** Where stem audio is kept, as `<root>/<audioHash>/<model>/<stem>.flac`. */
  readonly stemsRoot: string;
  /** Large temporary files (the float PCM Demucs reads and writes); removed afterwards. */
  readonly scratchDir: string;
  /** Folder holding the Demucs model yaml and weights (vendor/models/demucs). */
  readonly modelRepo: string;
  readonly audioPath: string;
  readonly settings: ProjectAnalysisSettings;
  readonly onProgress?: (progress: StemProgress) => void;
  readonly signal?: AbortSignal;
}

export interface SeparatedStems {
  readonly audioHash: string;
  readonly stems: readonly Stem[];
  readonly model: string;
  readonly separateSeconds: number;
}

/** Share of the progress bar each stage gets; separation is by far the longest. */
const WEIGHT = { decoding: 0.08, separating: 0.72, analysing: 0.2 } as const;

export async function separateStems(options: SeparateStemsOptions): Promise<SeparatedStems> {
  const { ffmpegExe, settings, signal } = options;
  const report = (stage: StemProgress['stage'], within: number, detail?: string) => {
    const before = stage === 'decoding' ? 0 : stage === 'separating' ? WEIGHT.decoding : WEIGHT.decoding + WEIGHT.separating;
    options.onProgress?.({ stage, fraction: before + WEIGHT[stage] * Math.min(1, Math.max(0, within)), ...(detail === undefined ? {} : { detail }) });
  };
  const checkCancelled = () => {
    if (signal?.aborted === true) throw new StemsCancelledError();
  };

  // 1. The mix first: same decode, same hash, same entry; and its beat grid.
  report('decoding', 0);
  const decoded = await decodeMono48k(ffmpegExe, options.audioPath);
  const cache = new AnalysisCache({ root: options.cacheRoot });
  const mix = await analyzeCached(decoded.pcm, cache, { ...cacheOptionsFor(settings), audioHash: decoded.pcmSha256 });
  const { audioHash, settingsHash } = mix;
  const mixBeat = mix.analysis.sources.get('mix')?.features.get('beat');
  checkCancelled();

  // 2. Under way, visibly. The model decides which stems there are (S6: six on htdemucs_6s).
  const expected = stemsForModel(settings.stemModel);
  for (const stem of expected) await cache.markSource(audioHash, settingsHash, stem, 'pending');

  const work = join(options.scratchDir, `stems-${audioHash.slice(0, 16)}`);
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  const stemDir = join(options.stemsRoot, audioHash, settings.stemModel);
  await mkdir(stemDir, { recursive: true });
  try {
    // 3. Stereo float at the model's rate, then separation.
    const input = join(work, 'input.f32');
    await runFfmpeg(ffmpegExe, ['-i', options.audioPath, '-map', '0:a:0', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_f32le', '-f', 'f32le', input], signal);
    report('decoding', 1);
    checkCancelled();

    const result = await options.sidecar.request('separate', {
      input,
      channels: 2,
      sampleRate: 44_100,
      model: settings.stemModel,
      repo: options.modelRepo,
      outDir: join(work, 'out'),
    }, {
      onProgress: (p) => report('separating', p.fraction ?? 0),
      ...(signal === undefined ? {} : { signal }),
    });
    const produced = Array.isArray(result['sources']) ? (result['sources'] as unknown[]).filter((s): s is string => typeof s === 'string') : [];
    const stems = expected.filter((stem) => produced.includes(stem));
    const missing = expected.filter((stem) => !produced.includes(stem));
    for (const stem of missing) {
      await cache.markSource(audioHash, settingsHash, stem, 'failed', `${settings.stemModel} did not produce a "${stem}" stem`);
    }
    report('separating', 1);

    // 4. Each stem: keep it, analyse it, cache it.
    for (const [index, stem] of stems.entries()) {
      checkCancelled();
      report('analysing', index / stems.length, stem);
      const pcm = await stemToAnalysisPcm(ffmpegExe, join(work, 'out', `${stem}.f32`), join(stemDir, `${stem}.flac`), signal);
      const analysed = analyzeMix(pcm, analysisOptionsFor(settings)).analysis.sources.get('mix');
      if (analysed === undefined) throw new Error(`the analyser produced nothing for the ${stem} stem`);
      await cache.writeSource(audioHash, settingsHash, stem, withBeat(analysed, mixBeat), {
        ...(mix.beatGrid === undefined ? {} : { beatGrid: mix.beatGrid }),
      });
    }
    report('analysing', 1);
    return {
      audioHash,
      stems,
      model: settings.stemModel,
      separateSeconds: typeof result['separateSeconds'] === 'number' ? result['separateSeconds'] : 0,
    };
  } catch (error) {
    // Whatever did not finish is marked, with why — never left "pending" for ever.
    const readiness = await cache.readiness(audioHash, settingsHash);
    const reason = error instanceof StemsCancelledError || isCancel(error) ? 'cancelled' : error instanceof Error ? error.message : String(error);
    for (const stem of expected) {
      if (readiness[stem]?.state !== 'ready') await cache.markSource(audioHash, settingsHash, stem, 'failed', reason);
    }
    throw error;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export class StemsCancelledError extends Error {
  constructor() {
    super('Stem separation was cancelled.');
    this.name = 'StemsCancelledError';
  }
}

function isCancel(error: unknown): boolean {
  return error instanceof Error && /cancel/i.test(error.name);
}

/** The stem with the mix's beat pulse in place of its own (see the header). */
function withBeat(stem: SourceAnalysis, mixBeat: AnalysisTrack | undefined): SourceAnalysis {
  if (mixBeat === undefined) return stem;
  const features = new Map(stem.features);
  features.set('beat', mixBeat);
  return { ...stem, features };
}

/**
 * One FFmpeg pass: the stem's float PCM (44.1 kHz stereo, as Demucs wrote it) out as FLAC to keep,
 * and as mono 48 kHz float for the analyser — the rate and channel count the mix is analysed at.
 */
async function stemToAnalysisPcm(ffmpegExe: string, rawPath: string, flacPath: string, signal?: AbortSignal): Promise<Float32Array> {
  const monoPath = `${rawPath}.mono48k`;
  await runFfmpeg(ffmpegExe, [
    '-f', 'f32le', '-ar', '44100', '-ac', '2', '-i', rawPath,
    '-map', '0:a', '-c:a', 'flac', flacPath,
    '-map', '0:a', '-ac', '1', '-ar', '48000', '-c:a', 'pcm_f32le', '-f', 'f32le', monoPath,
  ], signal);
  const bytes = await readFile(monoPath);
  await rm(monoPath, { force: true });
  return new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4)).slice();
}

function runFfmpeg(ffmpegExe: string, args: readonly string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegExe, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    const onAbort = () => child.kill();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', reject);
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted === true) reject(new StemsCancelledError());
      else if (code === 0) resolve();
      else reject(new Error(`FFmpeg failed (exit ${code}): ${stderr.trim().split('\n').pop() ?? ''}`));
    });
  });
}
