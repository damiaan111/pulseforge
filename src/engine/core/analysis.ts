// The engine's view of the AnalysisCache (data-formats §4.4).
//
// Audio data reaches the engine only as precomputed tracks, never from a live node
// (CLAUDE.md constraint 1). Reads are linear interpolation between fixed-rate samples,
// clamped at the ends, so the same t yields the same value in preview and export.

import type { Stem } from './params.ts';

export const ANALYSIS_RATE = 240;

export interface AnalysisTrack {
  /** Samples per second (240 — D11). */
  readonly rate: number;
  /** Values per sample: 1 for a band, the bin count for a spectrum. */
  readonly channels: number;
  /** frames × channels, interleaved. */
  readonly data: Float32Array;
}

/**
 * Scalar feature tracks, by name (PROJECT.md §7). A feature that was not computed — stereo
 * width from a mono decode, say — is **absent** rather than a track of zeros, so a binding on
 * it is reported as unavailable instead of looking like silence (data-formats §4.4).
 */
export const FEATURE_NAMES = ['rms', 'peak', 'onset', 'beat', 'centroid', 'flux', 'stereoWidth'] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];

export interface SourceAnalysis {
  /** Log-spaced magnitude bins, normalised to 0..1. */
  readonly spectrum: AnalysisTrack;
  /** Named band energies, normalised to 0..1. */
  readonly bands: ReadonlyMap<string, AnalysisTrack>;
  /** Named scalar features, normalised to 0..1. */
  readonly features: ReadonlyMap<string, AnalysisTrack>;
}

/**
 * The beat grid (modulation-spec §6.1). A **list of beat times**, not a BPM and an offset, so
 * tempo drift is representable: live playing slides, and a single BPM walks out of phase.
 */
export interface BeatGrid {
  readonly bpm: number;
  /** Seconds, ascending. */
  readonly beats: readonly number[];
  /** 0..1 — how strongly the material agreed with this tempo. */
  readonly confidence: number;
}

export interface AnalysisSet {
  /** Per source. A missing stem is explicitly absent, never silently zero (data-formats §4.4). */
  readonly sources: ReadonlyMap<Stem, SourceAnalysis>;
  /**
   * One grid for the project, detected on the drum stem where there is one — dramatically more
   * reliable than on a full mix (PROJECT.md §8.1). Absent when tempo was never detected.
   */
  readonly beatGrid?: BeatGrid;
}

/** Beats per second, for quantisation and synced LFO rates. Zero when there is no grid. */
export function beatsPerSecond(grid: BeatGrid | undefined): number {
  return grid === undefined || grid.bpm <= 0 ? 0 : grid.bpm / 60;
}

export function trackFrames(track: AnalysisTrack): number {
  return track.data.length / track.channels;
}

function position(track: AnalysisTrack, seconds: number): { i0: number; i1: number; f: number } {
  const last = trackFrames(track) - 1;
  if (last <= 0 || !(seconds > 0)) return { i0: 0, i1: 0, f: 0 };
  const x = seconds * track.rate;
  if (x >= last) return { i0: last, i1: last, f: 0 };
  const i0 = Math.floor(x);
  return { i0, i1: i0 + 1, f: x - i0 };
}

export function sampleTrack(track: AnalysisTrack, seconds: number, channel = 0): number {
  if (track.data.length === 0) return 0;
  const { i0, i1, f } = position(track, seconds);
  const a = track.data[i0 * track.channels + channel] ?? 0;
  const b = track.data[i1 * track.channels + channel] ?? 0;
  return a + (b - a) * f;
}

/** Fills `out` with every channel at `seconds`. No allocation — safe per frame. */
export function sampleTrackInto(track: AnalysisTrack, seconds: number, out: Float32Array): void {
  if (track.data.length === 0) {
    out.fill(0);
    return;
  }
  const { i0, i1, f } = position(track, seconds);
  const n = Math.min(out.length, track.channels);
  for (let c = 0; c < n; c++) {
    const a = track.data[i0 * track.channels + c] ?? 0;
    const b = track.data[i1 * track.channels + c] ?? 0;
    out[c] = a + (b - a) * f;
  }
}
