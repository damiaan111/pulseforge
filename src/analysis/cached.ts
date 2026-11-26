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
import { refineSections, refinementState, withRefinedGrid, type BeatRefinement, type BeatRefinementState } from './beat-refinement.ts';
import { hashAnalysisSettings, hashPcm, type AnalysisCache, type AnalysisKeyInputs } from './cache.ts';
import type { BeatGrid } from './features.ts';
import { detectKey, type MusicalKey } from './key.ts';
import { buildPeakPyramid, type PeakPyramid } from './peaks.ts';
import { detectSections, type Section } from './sections.ts';

export interface CachedAnalyzeOptions extends AnalyzeOptions {
  /** Skip the read and recompute — the "re-analyse" action, and what a bug report should try. */
  readonly force?: boolean;
  /** Which stem model will produce the stems; part of the key even before they exist. */
  readonly stemModel?: string;
  /** Precomputed hash, when the caller already has one (it is not cheap on a long track). */
  readonly audioHash?: string;
  /** The project's refined grid (S16). Laid over the cached result, so never part of the key. */
  readonly beatRefinement?: BeatRefinement | null;
}

export interface CachedAnalyzeResult {
  readonly analysis: AnalysisSet;
  readonly beatGrid: BeatGrid | undefined;
  readonly onsetTimes: readonly number[];
  /** Waveform pyramid for the timeline — built on a miss, read back on a hit. */
  readonly peaks: PeakPyramid;
  /** Structural sections for the arranger; empty when the audio is too short to have any. */
  readonly sections: readonly Section[];
  /** The track's key; null when it has none to speak of. */
  readonly key: MusicalKey | null;
  readonly audioHash: string;
  readonly settingsHash: string;
  readonly fromCache: boolean;
  /** What became of the project's refined grid. */
  readonly beatRefinement: BeatRefinementState;
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
  const result = await detected(pcm, cache, options);
  const state = refinementState(options.beatRefinement, result.audioHash, options.bpmOverride);
  if (state !== 'applied') return { ...result, beatRefinement: state };
  const refinement = options.beatRefinement as BeatRefinement;
  const { analysis, beatGrid } = withRefinedGrid(result.analysis, refinement);
  return { ...result, analysis, beatGrid, sections: refineSections(result.sections, refinement.sections, refinement.beats), beatRefinement: state };
}

/** An entry older than keys is still a hit: it just gains the file. */
async function keyOfEntry(pcm: Float32Array, cache: AnalysisCache, audioHash: string, settingsHash: string): Promise<MusicalKey | null> {
  const stored = await cache.readKey(audioHash, settingsHash);
  if (stored !== undefined) return stored;
  const key = detectKey(pcm);
  await cache.writeKey(audioHash, settingsHash, key).catch(() => undefined);
  return key;
}

async function detected(
  pcm: Float32Array,
  cache: AnalysisCache,
  options: CachedAnalyzeOptions,
): Promise<Omit<CachedAnalyzeResult, 'beatRefinement'>> {
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
      const mixHit = hit.sources.get('mix');
      const sections = (await cache.readSections(audioHash, settingsHash))
        ?? (mixHit === undefined ? [] : detectSections(mixHit, pcm.length / 48_000).sections);
      return {
        analysis: hit,
        beatGrid: hit.beatGrid,
        onsetTimes: await cache.readOnsetTimes(audioHash, settingsHash),
        peaks,
        sections,
        key: await keyOfEntry(pcm, cache, audioHash, settingsHash),
        audioHash,
        settingsHash,
        fromCache: true,
      };
    }
  }

  const computed: AnalyzeResult = analyzeMix(pcm, options);
  const peaks = buildPeakPyramid(pcm, 48_000);
  const mix = computed.analysis.sources.get('mix');
  const sectionAnalysis = mix === undefined ? undefined : detectSections(mix, pcm.length / 48_000);
  const key = detectKey(pcm);
  if (mix !== undefined) {
    try {
      await cache.writeSource(audioHash, settingsHash, 'mix', mix, {
        keyInputs,
        durationSeconds: pcm.length / 48_000,
        ...(computed.analysis.beatGrid === undefined ? {} : { beatGrid: computed.analysis.beatGrid }),
        onsetTimes: computed.onsetTimes,
      });
      await cache.writePeaks(audioHash, settingsHash, peaks);
      if (sectionAnalysis !== undefined) await cache.writeSections(audioHash, settingsHash, sectionAnalysis);
      await cache.writeKey(audioHash, settingsHash, key);
    } catch {
      // Best-effort: a cache that cannot be written still must not break analysis.
    }
  }

  return {
    analysis: computed.analysis,
    beatGrid: computed.analysis.beatGrid,
    onsetTimes: computed.onsetTimes,
    peaks,
    sections: sectionAnalysis?.sections ?? [],
    key,
    audioHash,
    settingsHash,
    fromCache: false,
  };
}
