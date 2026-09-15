// Analysis with the on-disk cache in front of it (M4, data-formats §4.5).
//
// Kept apart from `analyze.ts` on purpose: that file is pure and bundles into any environment,
// while this one touches the filesystem. The split is the same one `src/project/` makes against
// `src/shell/project-io.ts`.
//
// "Analysis runs once per track, ever" is the promise (PROJECT.md §8.1). It holds only if the key
// captures everything that changes the numbers — see `analysisKeyInputs` — and if the things that
// *don't* change them stay out of it. Trim, fades and lead-in are timeline mappings applied on
// read (PROJECT.md §8.10), so re-trimming a song must not re-analyse it; neither must resolution,
// fps, or any project edit.

import type { AnalysisSet } from '../engine/core/analysis.ts';
import { analyzeMix, type AnalyzeOptions, type AnalyzeResult } from './analyze.ts';
import { hashAnalysisSettings, hashPcm, type AnalysisCache, type AnalysisKeyInputs } from './cache.ts';
import type { BeatGrid } from './features.ts';
import { buildPeakPyramid, type PeakPyramid } from './peaks.ts';

export interface CachedAnalyzeOptions extends AnalyzeOptions {
  /** Skip the read and recompute — the "re-analyse" action, and what a bug report should try. */
  readonly force?: boolean;
  /** Which stem model will produce the stems; part of the key even before they exist. */
  readonly stemModel?: string;
  /** Precomputed hash, when the caller already has one (it is not cheap on a long track). */
  readonly audioHash?: string;
}

export interface CachedAnalyzeResult {
  readonly analysis: AnalysisSet;
  readonly beatGrid: BeatGrid | undefined;
  readonly onsetTimes: readonly number[];
  /** Waveform pyramid for the timeline — built on a miss, read back on a hit. */
  readonly peaks: PeakPyramid;
  readonly audioHash: string;
  readonly settingsHash: string;
  readonly fromCache: boolean;
}

/**
 * Analyse `pcm`, or return the cached result for the same audio and settings.
 *
 * A miss computes, writes and returns; a hit skips straight to the numbers. Failing to *write*
 * is not failing to analyse — a full or read-only cache disk costs speed, never correctness, so
 * the write is best-effort and the result is returned either way.
 */
export async function analyzeCached(
  pcm: Float32Array,
  cache: AnalysisCache,
  options: CachedAnalyzeOptions = {},
): Promise<CachedAnalyzeResult> {
  const audioHash = options.audioHash ?? hashPcm(pcm);
  const keyInputs: AnalysisKeyInputs = {
    ...(options.settings === undefined ? {} : { settings: options.settings }),
    ...(options.onsetSensitivity === undefined ? {} : { onsetSensitivity: options.onsetSensitivity }),
    ...(options.bpmOverride === undefined ? {} : { bpmOverride: options.bpmOverride }),
    ...(options.stemModel === undefined ? {} : { stemModel: options.stemModel }),
  };
  const settingsHash = hashAnalysisSettings(keyInputs);

  if (options.force !== true) {
    const hit = await cache.readSet(audioHash, settingsHash);
    if (hit !== null) {
      // Peaks are cheap to rebuild, so a missing peaks file is not a reason to miss the whole
      // entry — it just costs one pass over the PCM we already have in hand.
      const peaks = (await cache.readPeaks(audioHash, settingsHash)) ?? buildPeakPyramid(pcm, 48_000);
      return {
        analysis: hit,
        beatGrid: hit.beatGrid,
        onsetTimes: await cache.readOnsetTimes(audioHash, settingsHash),
        peaks,
        audioHash,
        settingsHash,
        fromCache: true,
      };
    }
  }

  const computed: AnalyzeResult = analyzeMix(pcm, options);
  const peaks = buildPeakPyramid(pcm, 48_000);
  const mix = computed.analysis.sources.get('mix');
  if (mix !== undefined) {
    try {
      await cache.writeSource(audioHash, settingsHash, 'mix', mix, {
        keyInputs,
        durationSeconds: pcm.length / 48_000,
        ...(computed.analysis.beatGrid === undefined ? {} : { beatGrid: computed.analysis.beatGrid }),
        onsetTimes: computed.onsetTimes,
      });
      await cache.writePeaks(audioHash, settingsHash, peaks);
    } catch {
      // Best-effort: a cache that cannot be written still must not break analysis.
    }
  }

  return {
    analysis: computed.analysis,
    beatGrid: computed.analysis.beatGrid,
    onsetTimes: computed.onsetTimes,
    peaks,
    audioHash,
    settingsHash,
    fromCache: false,
  };
}
