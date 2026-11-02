// TrackDigest and StyleVector (auto-director-spec §2–3, M21).
//
// The auto-director's first two steps: summarise what the analysis *measured* (the digest), then
// classify what kind of track it is (the style vector). Everything downstream — which template
// suits it, how modulation amounts are calibrated, where sections change — reads these.
//
// Two rules the spec is emphatic about, both easy to get subtly wrong:
//
//  1. **Percentile normalisation against music in general, not against this track.** Normalising
//     within the track would rate a quiet ambient piece's loudest moment as maximum energy, and
//     the director would then dress it like a festival banger. The reference ranges below are
//     hand-tuned constants (D27) — deliberately not learned from the user's library, because
//     that would make the same track classify differently on two machines and quietly break
//     reproducibility.
//  2. **Every axis is an explicit, documented rule.** No model, nothing opaque. When a result
//     looks wrong you have to be able to read *why* it chose what it chose, which is the same
//     reason the director keeps a decision log (auto-director-spec §8).
//
// Stems are not produced yet. Axes that need them say so in `unmeasured` rather than guessing —
// a director that knows it is guessing can choose a template that does not depend on the guess.

import type { AnalysisSet, BeatGrid, SourceAnalysis } from '../engine/core/analysis.ts';
import type { MusicalKey } from '../analysis/key.ts';
import type { Section } from '../analysis/sections.ts';

export interface EnergyDigest {
  readonly mean: number;
  readonly peak: number;
  /** p90 − p10 of the loudness envelope: how much the track moves, not how loud it is. */
  readonly dynamicRange: number;
  /** peak ÷ mean. High means spiky and percussive; near 1 means squashed. */
  readonly crestFactor: number;
}

export interface SpectrumDigest {
  readonly centroidMean: number;
  /** Energy in the top sixth of the spectrum — "air". */
  readonly airWeight: number;
  /** Energy in the bottom third. */
  readonly bassWeight: number;
}

export interface TransientDigest {
  /** Onsets per second. */
  readonly density: number;
  /** Onsets per bar, when there is a grid to count against. */
  readonly perBar: number | null;
  /**
   * How closely onsets land on the beat grid: 1 = machine-perfect, 0 = unrelated. The measure
   * that separates a quantised production from a band playing.
   */
  readonly regularity: number | null;
}

export interface StemsDigest {
  readonly available: boolean;
  readonly drumsPresence: number | null;
  readonly bassPresence: number | null;
  readonly vocalPresence: number | null;
  /** Fraction of the track with vocal activity — where text may go (auto-director §5.4). */
  readonly vocalCoverage: number | null;
}

export interface StructureDigest {
  readonly sections: readonly Section[];
  /** Section boundaries where energy jumps hardest — candidate drops. */
  readonly drops: readonly number[];
  readonly loudestSection: number | null;
  readonly quietestSection: number | null;
}

export interface TrackDigest {
  readonly durationSeconds: number;
  readonly bpm: number;
  readonly bpmConfidence: number;
  readonly energy: EnergyDigest;
  readonly spectrum: SpectrumDigest;
  readonly transients: TransientDigest;
  readonly stereoWidth: number | null;
  readonly stems: StemsDigest;
  readonly structure: StructureDigest;
  /** Not a style axis: it is a colour choice a template may ask for, not a reason to match one. */
  readonly key: MusicalKey | null;
}

export interface DigestInput {
  readonly analysis: AnalysisSet;
  readonly durationSeconds: number;
  readonly onsetTimes: readonly number[];
  readonly sections: readonly Section[];
  readonly key?: MusicalKey | null;
}

export function buildTrackDigest(input: DigestInput): TrackDigest {
  const mix = input.analysis.sources.get('mix');
  const grid = input.analysis.beatGrid;
  const duration = Math.max(0, input.durationSeconds);

  return {
    durationSeconds: duration,
    bpm: grid?.bpm ?? 0,
    bpmConfidence: grid?.confidence ?? 0,
    energy: energyDigest(mix, duration),
    spectrum: spectrumDigest(mix),
    transients: transientDigest(input.onsetTimes, grid, duration),
    stereoWidth: mix === undefined ? null : meanOf(mix.features.get('stereoWidth')?.data),
    stems: stemsDigest(input.analysis),
    structure: structureDigest(input.sections),
    key: input.key ?? null,
  };
}

function energyDigest(mix: SourceAnalysis | undefined, duration: number): EnergyDigest {
  const rms = mix?.features.get('rms')?.data;
  if (rms === undefined || rms.length === 0 || duration === 0) {
    return { mean: 0, peak: 0, dynamicRange: 0, crestFactor: 1 };
  }
  const sorted = Float32Array.from(rms).sort();
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))] as number;
  const mean = meanOf(rms) ?? 0;
  const peak = at(1);
  return {
    mean,
    peak,
    // p90 − p10 rather than max − min: one clipped sample or one silent gap should not define
    // how dynamic a track is.
    dynamicRange: Math.max(0, at(0.9) - at(0.1)),
    crestFactor: mean > 0 ? peak / mean : 1,
  };
}

function spectrumDigest(mix: SourceAnalysis | undefined): SpectrumDigest {
  if (mix === undefined) return { centroidMean: 0, airWeight: 0, bassWeight: 0 };
  const centroidMean = meanOf(mix.features.get('centroid')?.data) ?? 0;

  const { spectrum } = mix;
  const bins = spectrum.channels;
  const frames = bins === 0 ? 0 : spectrum.data.length / bins;
  if (frames === 0) return { centroidMean, airWeight: 0, bassWeight: 0 };

  // Bins are log-spaced (spectrum.ts), so a fixed fraction of the bin range is a fixed fraction
  // of the *octave* range — which is what "bass" and "air" mean to a listener.
  const bassEnd = Math.max(1, Math.round(bins / 3));
  const airStart = Math.max(bassEnd, bins - Math.round(bins / 6));
  let bass = 0;
  let air = 0;
  let total = 0;
  // Sampled rather than exhaustive: this is a summary, and 512 frames across a track is plenty
  // to characterise its balance.
  const step = Math.max(1, Math.floor(frames / 512));
  for (let frame = 0; frame < frames; frame += step) {
    for (let bin = 0; bin < bins; bin += 1) {
      const value = spectrum.data[frame * bins + bin] as number;
      total += value;
      if (bin < bassEnd) bass += value;
      else if (bin >= airStart) air += value;
    }
  }
  return {
    centroidMean,
    airWeight: total > 0 ? air / total : 0,
    bassWeight: total > 0 ? bass / total : 0,
  };
}

function transientDigest(
  onsetTimes: readonly number[],
  grid: BeatGrid | undefined,
  duration: number,
): TransientDigest {
  const density = duration > 0 ? onsetTimes.length / duration : 0;
  if (grid === undefined || grid.bpm <= 0 || grid.beats.length < 2 || onsetTimes.length === 0) {
    return { density, perBar: null, regularity: null };
  }
  const beatSeconds = 60 / grid.bpm;
  const perBar = density * beatSeconds * 4;

  /**
   * Regularity: how far each onset sits from its nearest beat, as a fraction of half a beat.
   * A quantised track scores near 1; onsets scattered uniformly between beats average a quarter
   * beat away and score near 0.5; nothing to do with the grid scores lower still.
   */
  let deviation = 0;
  for (const onset of onsetTimes) {
    const nearest = Math.round((onset - (grid.beats[0] as number)) / beatSeconds);
    const expected = (grid.beats[0] as number) + nearest * beatSeconds;
    deviation += Math.min(1, Math.abs(onset - expected) / (beatSeconds / 2));
  }
  return { density, perBar, regularity: Math.max(0, 1 - deviation / onsetTimes.length) };
}

function stemsDigest(analysis: AnalysisSet): StemsDigest {
  const presence = (name: 'drums' | 'bass' | 'vocals') => {
    const source = analysis.sources.get(name);
    return source === undefined ? null : (meanOf(source.features.get('rms')?.data) ?? 0);
  };
  const vocals = analysis.sources.get('vocals');
  const available = analysis.sources.has('drums') || analysis.sources.has('vocals');
  return {
    available,
    drumsPresence: presence('drums'),
    bassPresence: presence('bass'),
    vocalPresence: presence('vocals'),
    // Coverage, not level: a quiet vocal that runs throughout is still a vocal-led track, and
    // that is what decides whether text has room (auto-director §5.4).
    vocalCoverage: vocals === undefined ? null : fractionAbove(vocals.features.get('rms')?.data, 0.05),
  };
}

function structureDigest(sections: readonly Section[]): StructureDigest {
  if (sections.length === 0) {
    return { sections, drops: [], loudestSection: null, quietestSection: null };
  }
  let loudest = 0;
  let quietest = 0;
  sections.forEach((section, i) => {
    if (section.energy > (sections[loudest] as Section).energy) loudest = i;
    if (section.energy < (sections[quietest] as Section).energy) quietest = i;
  });

  // A drop is a boundary into a much louder section — the thing worth putting an impulse on.
  const drops: number[] = [];
  for (let i = 1; i < sections.length; i += 1) {
    const before = (sections[i - 1] as Section).energy;
    const after = (sections[i] as Section).energy;
    if (before > 0 && after > before * 1.4) drops.push((sections[i] as Section).startSeconds);
  }
  return { sections, drops, loudestSection: loudest, quietestSection: quietest };
}

// ---------------------------------------------------------------------------
// StyleVector (auto-director-spec §3)
// ---------------------------------------------------------------------------

export interface StyleVector {
  readonly tempo: number;
  readonly energy: number;
  readonly brightness: number;
  readonly density: number;
  /** 0 = quantised and electronic, 1 = played and breathing. */
  readonly organic: number;
  readonly vocalWeight: number;
  readonly dynamics: number;
  readonly darkness: number;
  /** Axes that fell back to a neutral 0.5 because the input to measure them was missing. */
  readonly unmeasured: readonly string[];
}

/**
 * Reference ranges: where "0" and "1" sit for music in general (D27).
 *
 * These are hand-tuned constants and are meant to be. Learning them from the user's own library
 * would make the same track classify differently on two machines, which breaks the promise that
 * a seed and a track reproduce a project.
 */
const REFERENCE = {
  /** Perceptually: the 90–140 range carries most of the distinction, so it gets most of the axis. */
  tempo: [{ bpm: 60, at: 0 }, { bpm: 90, at: 0.25 }, { bpm: 140, at: 0.75 }, { bpm: 200, at: 1 }],
  energyMean: { low: 0.04, high: 0.35 },
  crest: { low: 1.5, high: 6 },
  centroid: { low: 0.2, high: 0.7 },
  air: { low: 0.02, high: 0.2 },
  bass: { low: 0.15, high: 0.55 },
  onsetsPerBar: { low: 1, high: 12 },
  onsetDensity: { low: 0.5, high: 8 },
  regularity: { low: 0.55, high: 0.95 },
  dynamicRange: { low: 0.02, high: 0.25 },
  vocalCoverage: { low: 0.05, high: 0.6 },
} as const;

export function styleVector(digest: TrackDigest): StyleVector {
  const unmeasured: string[] = [];

  const tempo = digest.bpm > 0 ? piecewise(digest.bpm, REFERENCE.tempo) : note('tempo', unmeasured);
  const energy = clamp01(
    0.65 * scale(digest.energy.mean, REFERENCE.energyMean) + 0.35 * scale(digest.transients.density, REFERENCE.onsetDensity),
  );
  const brightness = clamp01(0.6 * scale(digest.spectrum.centroidMean, REFERENCE.centroid) + 0.4 * scale(digest.spectrum.airWeight, REFERENCE.air));
  const density = digest.transients.perBar === null
    ? scale(digest.transients.density, REFERENCE.onsetDensity)
    : scale(digest.transients.perBar, REFERENCE.onsetsPerBar);

  // Organic is the inverse of "machine": onsets that land on the grid and a confident tempo mean
  // quantised. A weak grid on its own is not evidence of live playing, so confidence only tempers.
  const organic = digest.transients.regularity === null
    ? note('organic', unmeasured)
    : clamp01(1 - (0.75 * scale(digest.transients.regularity, REFERENCE.regularity) + 0.25 * clamp01(digest.bpmConfidence)));

  const vocalWeight = digest.stems.vocalCoverage === null
    ? note('vocalWeight', unmeasured)
    : scale(digest.stems.vocalCoverage, REFERENCE.vocalCoverage);

  const dynamics = clamp01(0.7 * scale(digest.energy.dynamicRange, REFERENCE.dynamicRange) + 0.3 * scale(digest.energy.crestFactor, REFERENCE.crest));
  const darkness = clamp01(0.5 * scale(digest.spectrum.bassWeight, REFERENCE.bass) + 0.5 * (1 - brightness));

  return { tempo, energy, brightness, density, organic, vocalWeight, dynamics, darkness, unmeasured };
}

/** A one-line, human-readable reading of the vector — the decision log's first entry. */
export function describeStyle(style: StyleVector): string {
  const words: string[] = [];
  words.push(style.tempo > 0.66 ? 'fast' : style.tempo < 0.33 ? 'slow' : 'mid-tempo');
  words.push(style.energy > 0.66 ? 'high-energy' : style.energy < 0.33 ? 'quiet' : 'moderate');
  if (style.brightness > 0.6) words.push('bright');
  if (style.darkness > 0.6) words.push('dark');
  if (style.density > 0.6) words.push('busy');
  if (style.density < 0.3) words.push('sparse');
  words.push(style.organic > 0.55 ? 'played' : 'electronic');
  if (!style.unmeasured.includes('vocalWeight')) words.push(style.vocalWeight > 0.5 ? 'vocal-led' : 'instrumental');
  const caveat = style.unmeasured.length === 0 ? '' : ` (${style.unmeasured.join(', ')} not measured)`;
  return `${words.join(', ')}${caveat}`;
}

function note(axis: string, unmeasured: string[]): number {
  unmeasured.push(axis);
  return 0.5;
}

function scale(value: number, range: { readonly low: number; readonly high: number }): number {
  return clamp01((value - range.low) / (range.high - range.low));
}

/** Linear interpolation through named points — for axes where the useful detail is not uniform. */
function piecewise(bpm: number, points: readonly { readonly bpm: number; readonly at: number }[]): number {
  if (bpm <= (points[0] as { bpm: number }).bpm) return (points[0] as { at: number }).at;
  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1] as { bpm: number; at: number };
    const current = points[i] as { bpm: number; at: number };
    if (bpm <= current.bpm) {
      const f = (bpm - previous.bpm) / (current.bpm - previous.bpm);
      return clamp01(previous.at + (current.at - previous.at) * f);
    }
  }
  return (points[points.length - 1] as { at: number }).at;
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function meanOf(data: Float32Array | undefined): number | null {
  if (data === undefined || data.length === 0) return null;
  let sum = 0;
  for (const value of data) sum += value;
  return sum / data.length;
}

function fractionAbove(data: Float32Array | undefined, threshold: number): number | null {
  if (data === undefined || data.length === 0) return null;
  let above = 0;
  for (const value of data) if (value > threshold) above += 1;
  return above / data.length;
}

