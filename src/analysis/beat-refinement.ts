// The refined beat grid (S16, D28): what librosa found, and what it changes.
//
// The result is stored **in the project**, not the analysis cache. The cache is rebuildable and a
// render must not need Python, so a project carries its own grid: the preview, the CLI and an export
// on another machine then all react to the same beats, and refining is one undoable edit.
//
// It belongs to one audio file, by hash. Applied to anything else it would be a confident wrong
// grid, so it is left out and reported instead.

import { ANALYSIS_RATE, type AnalysisSet } from '../engine/core/analysis.ts';
import { beatPulse, type BeatGrid } from './features.ts';
import type { Section } from './sections.ts';

export interface BeatRefinement {
  /** The audio this was tracked on (the PCM hash the analysis cache keys on). */
  readonly audioHash: string;
  readonly tool: string;
  readonly bpm: number;
  /** Seconds of audio, ascending. */
  readonly beats: readonly number[];
  readonly confidence: number;
  /** Where the track's parts change, seconds of audio, ascending. */
  readonly sections: readonly number[];
}

/** 'none': nothing stored. 'applied': in use. 'stale': for other audio, or under a tempo override. */
export type BeatRefinementState = 'none' | 'applied' | 'stale' | 'overridden';

/** Far enough that a section boundary moved to a structural one is still the same boundary. */
const MAX_SECTION_MOVE_SECONDS = 4;
/** A section never comes out shorter than this. */
const MIN_SECTION_SECONDS = 2;

function times(raw: unknown, what: string): number[] {
  if (!Array.isArray(raw) || raw.length > 100_000) throw new Error(`${what} is not a list of times`);
  let last = -Infinity;
  return raw.map((value: unknown) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value < last) throw new Error(`${what} are not ascending times`);
    last = value;
    return value;
  });
}

/** Checks a refinement from a file or over IPC. Throws a sentence; null stays null. */
export function parseBeatRefinement(raw: unknown): BeatRefinement | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object') throw new Error('the beat refinement is not an object');
  const value = raw as Record<string, unknown>;
  const { audioHash, tool, bpm, confidence } = value;
  if (typeof audioHash !== 'string' || !/^[0-9a-f]{16,128}$/.test(audioHash)) throw new Error('the beat refinement has no audio hash');
  if (typeof tool !== 'string' || tool === '') throw new Error('the beat refinement names no tool');
  if (typeof bpm !== 'number' || !(bpm > 0 && bpm < 1000)) throw new Error('the beat refinement has no tempo');
  if (typeof confidence !== 'number' || !(confidence >= 0 && confidence <= 1)) throw new Error('the beat refinement has no confidence');
  return { audioHash, tool, bpm, confidence, beats: times(value['beats'], 'its beats'), sections: times(value['sections'], 'its sections') };
}

/** What a stored refinement does for this audio and these settings. */
export function refinementState(refinement: BeatRefinement | null | undefined, audioHash: string, bpmOverride: number | null | undefined): BeatRefinementState {
  if (refinement === null || refinement === undefined) return 'none';
  if (refinement.audioHash !== audioHash) return 'stale';
  return bpmOverride === null || bpmOverride === undefined ? 'applied' : 'overridden';
}

function nearest(values: readonly number[], to: number): number | undefined {
  let best: number | undefined;
  for (const value of values) if (best === undefined || Math.abs(value - to) < Math.abs(best - to)) best = value;
  return best;
}

/**
 * The detected sections, each boundary moved to a structural change when one is close, and to the
 * nearest beat in any case, since a change of section falls on a beat. Labels and energy stay: they
 * describe the part, and the part is the same one a moment earlier or later.
 */
export function refineSections(sections: readonly Section[], boundaries: readonly number[], beats: readonly number[]): Section[] {
  const moved = sections.slice(1).map((section) => {
    const start = section.startSeconds;
    const structural = nearest(boundaries, start);
    const near = structural !== undefined && Math.abs(structural - start) <= MAX_SECTION_MOVE_SECONDS ? structural : start;
    return nearest(beats, near) ?? near;
  });
  let previous = sections[0]?.startSeconds ?? 0;
  const edges = moved.map((edge, i) => {
    const next = sections[i + 2]?.startSeconds ?? sections[i + 1]?.endSeconds ?? edge;
    // A move that would crush a neighbour is not made.
    const start = edge - previous < MIN_SECTION_SECONDS || next - edge < MIN_SECTION_SECONDS ? (sections[i + 1] as Section).startSeconds : edge;
    previous = start;
    return start;
  });
  return sections.map((section, i) => ({
    ...section,
    startSeconds: i === 0 ? section.startSeconds : edges[i - 1] as number,
    endSeconds: i === sections.length - 1 ? section.endSeconds : edges[i] as number,
  }));
}

/** The analysis with the refined grid in place of the detected one, and its `beat` track redrawn. */
export function withRefinedGrid(analysis: AnalysisSet, refinement: BeatRefinement): { analysis: AnalysisSet; beatGrid: BeatGrid } {
  const beatGrid: BeatGrid = { bpm: refinement.bpm, beats: refinement.beats, confidence: refinement.confidence };
  const sources = new Map(analysis.sources);
  const mix = sources.get('mix');
  const beat = mix?.features.get('beat');
  if (mix !== undefined && beat !== undefined) {
    const features = new Map(mix.features);
    features.set('beat', { ...beat, data: beatPulse(beatGrid, ANALYSIS_RATE, beat.data.length) });
    sources.set('mix', { ...mix, features });
  }
  return { analysis: { sources, beatGrid }, beatGrid };
}
