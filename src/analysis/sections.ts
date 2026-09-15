// Section detection (PROJECT.md §8.1, auto-director-spec §2 `structure.sections`).
//
// The auto-director's arranger leans on this: sections are where layers enter and leave, where
// the palette shifts, where intensity changes (auto-director-spec §6). Without them a generated
// video is one static look for four minutes, which is the single most reliable way for this kind
// of tool to be boring.
//
// The method is Foote's: build a self-similarity matrix over timbre, correlate a checkerboard
// kernel along its diagonal, and peak-pick the resulting novelty curve. A boundary is where the
// music before sounds unlike the music after — which is what a section change *is*, and is why
// this beats thresholding loudness (a quiet chorus and a loud verse are not distinguishable by
// level, but their timbre differs).
//
// Deliberately lightweight and deliberately approximate. It is good on electronic and
// beat-driven material and weaker on dynamic acoustic playing (auto-director-spec §13.2, D28).
// Approximate boundaries still beat none, and every boundary it produces lands in the timeline
// as an ordinary marker the user can drag.

import { ANALYSIS_RATE, type SourceAnalysis } from '../engine/core/analysis.ts';

export const SECTIONS_FORMAT_VERSION = 1;

/** Structure frames per second. Sections are tens of seconds long; 240 Hz is pointless here. */
const STRUCTURE_RATE = 4;

/** Half-width of the checkerboard kernel, in structure frames — 4 s of context on each side. */
const KERNEL_HALF = 16;

/** Anti-chaos (auto-director-spec §6): scene changes closer than this read as strobing. */
export const MIN_SECTION_SECONDS = 8;

/**
 * Below this, the novelty curve is numerically flat and any "peak" in it is float noise.
 * Cosine similarities live in 0..1, so a real corner is orders of magnitude above this.
 */
const NOVELTY_FLOOR = 1e-4;

export type SectionLabel = 'intro' | 'build' | 'main' | 'breakdown' | 'outro';

export interface Section {
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly label: SectionLabel;
  /** Mean loudness over the section, 0..1 on the same scale as the `rms` feature. */
  readonly energy: number;
}

export interface SectionAnalysis {
  readonly formatVersion: number;
  readonly sections: readonly Section[];
  /** The novelty curve, at `STRUCTURE_RATE` — kept so a boundary can be explained, not just asserted. */
  readonly novelty: Float32Array;
  readonly noveltyRate: number;
}

export interface DetectSectionsOptions {
  /** 0..1; higher finds more boundaries. Default 0.5. */
  readonly sensitivity?: number;
  readonly minSectionSeconds?: number;
}

/**
 * Sections for one analysed source. `durationSeconds` is the audio's length, not the timeline's:
 * sections describe the music, and the timeline mapping is applied on read (PROJECT.md §8.10).
 */
export function detectSections(
  source: SourceAnalysis,
  durationSeconds: number,
  options: DetectSectionsOptions = {},
): SectionAnalysis {
  const minSection = options.minSectionSeconds ?? MIN_SECTION_SECONDS;
  const sensitivity = clamp01(options.sensitivity ?? 0.5);

  const features = structureFrames(source);
  const energy = structureEnergy(source, features.length);

  // Too short to have structure: one section is the honest answer, not a guess.
  if (features.length < KERNEL_HALF * 2 + 2 || durationSeconds < minSection * 2) {
    return {
      formatVersion: SECTIONS_FORMAT_VERSION,
      sections: [{ startSeconds: 0, endSeconds: durationSeconds, label: 'main', energy: mean(energy) }],
      novelty: new Float32Array(features.length),
      noveltyRate: STRUCTURE_RATE,
    };
  }

  const novelty = noveltyCurve(features);
  const boundaries = pickBoundaries(novelty, sensitivity, minSection * STRUCTURE_RATE);
  const sections = buildSections(boundaries, novelty.length, durationSeconds, energy);

  return { formatVersion: SECTIONS_FORMAT_VERSION, sections, novelty, noveltyRate: STRUCTURE_RATE };
}

/**
 * Spectrum frames downsampled to `STRUCTURE_RATE` and normalised per frame.
 *
 * Per-frame normalisation is what makes this about *timbre* rather than *level*: a quiet passage
 * and a loud one with the same spectral shape should look similar, because they are the same
 * section played at different volumes.
 */
function structureFrames(source: SourceAnalysis): Float32Array[] {
  const { spectrum } = source;
  const bins = spectrum.channels;
  const totalFrames = bins === 0 ? 0 : spectrum.data.length / bins;
  const step = Math.max(1, Math.round(spectrum.rate / STRUCTURE_RATE));
  const frames: Float32Array[] = [];

  for (let start = 0; start + step <= totalFrames; start += step) {
    const frame = new Float32Array(bins);
    for (let f = start; f < start + step; f += 1) {
      for (let bin = 0; bin < bins; bin += 1) {
        frame[bin] = (frame[bin] as number) + (spectrum.data[f * bins + bin] as number);
      }
    }
    let sum = 0;
    for (let bin = 0; bin < bins; bin += 1) sum += frame[bin] as number;
    if (sum > 0) for (let bin = 0; bin < bins; bin += 1) frame[bin] = (frame[bin] as number) / sum;
    frames.push(frame);
  }
  return frames;
}

function structureEnergy(source: SourceAnalysis, frameCount: number): Float32Array {
  const rms = source.features.get('rms');
  const energy = new Float32Array(frameCount);
  if (rms === undefined || frameCount === 0) return energy;
  const step = Math.max(1, Math.round(ANALYSIS_RATE / STRUCTURE_RATE));
  for (let frame = 0; frame < frameCount; frame += 1) {
    let sum = 0;
    let count = 0;
    for (let i = frame * step; i < (frame + 1) * step && i < rms.data.length; i += 1) {
      sum += rms.data[i] as number;
      count += 1;
    }
    energy[frame] = count === 0 ? 0 : sum / count;
  }
  return energy;
}

/**
 * Foote novelty: slide a checkerboard kernel down the diagonal of the self-similarity matrix.
 * The kernel rewards "similar to itself on each side, different across" — a corner in the
 * similarity structure — which peaks exactly at a section boundary.
 *
 * The matrix is never materialised: only the 2·KERNEL_HALF-square window around each diagonal
 * position is needed, so this is O(n · k²) and a few megabytes rather than O(n²) storage.
 */
function noveltyCurve(frames: readonly Float32Array[]): Float32Array {
  const novelty = new Float32Array(frames.length);
  for (let centre = KERNEL_HALF; centre < frames.length - KERNEL_HALF; centre += 1) {
    let past = 0;
    let future = 0;
    let across = 0;
    for (let i = 1; i <= KERNEL_HALF; i += 1) {
      for (let j = 1; j <= KERNEL_HALF; j += 1) {
        past += similarity(frames[centre - i] as Float32Array, frames[centre - j] as Float32Array);
        future += similarity(frames[centre + i - 1] as Float32Array, frames[centre + j - 1] as Float32Array);
        across += similarity(frames[centre - i] as Float32Array, frames[centre + j - 1] as Float32Array);
      }
    }
    const within = (past + future) / 2;
    novelty[centre] = Math.max(0, (within - across) / (KERNEL_HALF * KERNEL_HALF));
  }
  return novelty;
}

/** Cosine similarity — magnitude-free, so it compares shape rather than level. */
function similarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    aa += x * x;
    bb += y * y;
  }
  return aa === 0 || bb === 0 ? 0 : dot / Math.sqrt(aa * bb);
}

/**
 * Peak-pick against an adaptive threshold, then enforce a minimum spacing.
 *
 * Adaptive because a fixed threshold either misses the quiet half of a dynamic track or fires
 * continuously through the loud half — the same reason onset detection uses one (§4.4).
 */
function pickBoundaries(novelty: Float32Array, sensitivity: number, minSpacingFrames: number): number[] {
  const peak = Math.max(...novelty);
  // An absolute floor, not just a relative threshold. On material with no structural change the
  // curve is float noise around zero, and a purely relative threshold will happily find a "peak"
  // in it — the same trap the tempo detector avoids by reporting no grid for silence rather than
  // a confident wrong answer.
  if (peak <= NOVELTY_FLOOR) return [];
  // sensitivity 0 → only the very strongest corners; 1 → almost any local maximum.
  const threshold = peak * (0.5 - sensitivity * 0.45);

  const candidates: { frame: number; strength: number }[] = [];
  // Keep the ends clear too: a boundary 6 s from the start makes a 6 s section, which the
  // minimum spacing between boundaries alone would never catch.
  for (let i = Math.max(1, Math.ceil(minSpacingFrames)); i < novelty.length - 1 - minSpacingFrames; i += 1) {
    const value = novelty[i] as number;
    if (value >= threshold && value > (novelty[i - 1] as number) && value >= (novelty[i + 1] as number)) {
      candidates.push({ frame: i, strength: value });
    }
  }

  // Strongest first, so when two boundaries are too close the weaker one yields — keeping the
  // clearer musical change rather than whichever happened to come first.
  candidates.sort((a, b) => b.strength - a.strength);
  const chosen: number[] = [];
  for (const candidate of candidates) {
    if (chosen.every((frame) => Math.abs(frame - candidate.frame) >= minSpacingFrames)) chosen.push(candidate.frame);
  }
  return chosen.sort((a, b) => a - b);
}

/**
 * Boundaries → labelled sections.
 *
 * Labels are a coarse heuristic and are named as such: the loudest sections are `main`, quieter
 * middles are `breakdown`, a rising one before a main section is a `build`, and the first and
 * last are `intro` and `outro` when they are quieter than the track's average. The auto-director
 * uses these as hints, not as ground truth (auto-director-spec §5.4).
 */
function buildSections(
  boundaries: readonly number[],
  frameCount: number,
  durationSeconds: number,
  energy: Float32Array,
): Section[] {
  const edges = [0, ...boundaries, frameCount];
  const secondsPerFrame = durationSeconds / frameCount;

  const spans = edges.slice(0, -1).map((start, i) => {
    const end = edges[i + 1] as number;
    return { start, end, energy: mean(energy.subarray(start, end)) };
  });

  const loudest = Math.max(...spans.map((span) => span.energy));
  const average = mean(Float32Array.from(spans.map((span) => span.energy)));

  return spans.map((span, i) => {
    const isFirst = i === 0;
    const isLast = i === spans.length - 1;
    const next = spans[i + 1];
    const label: SectionLabel =
      span.energy >= loudest * 0.85 ? 'main'
      : isFirst && span.energy < average ? 'intro'
      : isLast && span.energy < average ? 'outro'
      : next !== undefined && next.energy > span.energy * 1.15 ? 'build'
      : 'breakdown';

    return {
      startSeconds: span.start * secondsPerFrame,
      endSeconds: Math.min(span.end * secondsPerFrame, durationSeconds),
      label,
      energy: span.energy,
    };
  });
}

function mean(values: Float32Array): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

/** For `sections.json` — the curve is dropped, being large and reconstructible. */
export function sectionsToJson(analysis: SectionAnalysis): string {
  return `${JSON.stringify({ formatVersion: analysis.formatVersion, sections: analysis.sections }, null, 2)}\n`;
}
