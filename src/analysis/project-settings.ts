// A project's analysis settings, as analyser options (data-formats §1 `analysisSettings`, M4).
//
// The one mapping from what a document says — its bands, onset sensitivity and tempo override — to
// what the analyser computes. The studio's preview and the exporter both go through it, so they
// always analyse a track the same way, and a binding on a band a project defines reads the band the
// analyser actually computed under that name. Part of the cache key, like every analyser setting.

import { DEFAULT_SPECTRUM_SETTINGS } from './spectrum.ts';
import type { AnalyzeOptions } from './analyze.ts';
import type { CachedAnalyzeOptions } from './cached.ts';

/** The fields of a document's `analysisSettings` the analyser reads. Structural, so this file stays free of the document model. */
export interface ProjectAnalysisSettings {
  readonly bands: readonly { readonly id: string; readonly minHz: number; readonly maxHz: number }[];
  readonly onsetSensitivity: number;
  readonly bpmOverride: number | null;
  /** Which Demucs model makes the stems (D8). Part of the cache key, so a model change re-separates. */
  readonly stemModel: string;
}

/**
 * The same, plus the cache-key inputs the analyser itself does not read — the stem model. Every
 * caller that reads or writes the analysis cache uses this, so the mix and the stems of one project
 * land in one cache entry.
 */
export function cacheOptionsFor(settings: ProjectAnalysisSettings): CachedAnalyzeOptions {
  return { ...analysisOptionsFor(settings), stemModel: settings.stemModel };
}

export function analysisOptionsFor(settings: ProjectAnalysisSettings): AnalyzeOptions {
  return {
    settings: {
      ...DEFAULT_SPECTRUM_SETTINGS,
      bands: settings.bands.map((band) => ({ name: band.id, minHz: band.minHz, maxHz: band.maxHz })),
    },
    onsetSensitivity: settings.onsetSensitivity,
    ...(settings.bpmOverride === null ? {} : { bpmOverride: settings.bpmOverride }),
  };
}

/**
 * Checks settings that arrived over IPC before they reach the analyser: plain numbers, a sane Hz
 * range, a band id that can be a map key. Anything else is a caller bug, said as a sentence.
 */
export function parseProjectAnalysisSettings(raw: unknown): ProjectAnalysisSettings {
  const fail = (why: string): never => {
    throw new Error(`Analysis settings rejected: ${why}`);
  };
  if (typeof raw !== 'object' || raw === null) return fail('not an object');
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value['bands'])) return fail('bands is not a list');
  const bands = value['bands'].map((item: unknown) => {
    const band = item as Record<string, unknown>;
    const { id, minHz, maxHz } = band;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(id)) return fail(`band id ${JSON.stringify(id)}`);
    if (typeof minHz !== 'number' || typeof maxHz !== 'number' || !(minHz >= 0) || !(maxHz > minHz) || maxHz > 48_000) {
      return fail(`band "${id}" range ${String(minHz)}–${String(maxHz)} Hz`);
    }
    return { id, minHz, maxHz };
  });
  const sensitivity = value['onsetSensitivity'];
  if (typeof sensitivity !== 'number' || !(sensitivity >= 0 && sensitivity <= 1)) return fail('onsetSensitivity');
  const bpm = value['bpmOverride'];
  if (bpm !== null && (typeof bpm !== 'number' || !(bpm > 0 && bpm < 400))) return fail('bpmOverride');
  const model = value['stemModel'];
  // A model name becomes a path under vendor/models/demucs: letters, digits, dashes, underscores.
  if (typeof model !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(model)) return fail('stemModel');
  return { bands, onsetSensitivity: sensitivity, bpmOverride: bpm as number | null, stemModel: model };
}
