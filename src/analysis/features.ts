// Per-frame audio features (PROJECT.md §8.1, data-formats §4).
//
// These are the sources the modulation system has been compiling and reporting as unsupported
// since P2 step 3: `rms`, `peak`, `centroid`, `flux`, `onset`. The evaluator needs no changes —
// it samples whatever tracks the analysis produced — so this file is what turns those bindings
// from "kept and inactive" into working ones.
//
// Everything here is a pure function of the PCM. No state carried between calls, no clock, and
// the same audio in always gives the same tracks out, because these numbers end up in the cache
// and then in every render (data-formats §4.3).
//
// **Normalisation is shared with the band tracks**: levels become sine-equivalent amplitude in
// dBFS, mapped linearly from `floorDb`..0 to 0..1. One scale across every source is what lets a
// modulation amount mean roughly the same thing wherever it is pointed.

/** dBFS → 0..1, the mapping every level-like feature uses. */
export function levelToUnit(amplitude: number, floorDb: number): number {
  if (!(amplitude > 0)) return 0;
  const db = 20 * Math.log10(amplitude);
  return Math.min(1, Math.max(0, (db - floorDb) / -floorDb));
}

/**
 * Power-weighted mean frequency, in 0..1 across a **log** span. Log because brightness is
 * perceived logarithmically: a linear mapping puts every musical signal in the bottom tenth of
 * the range and the source barely moves.
 */
export function spectralCentroid(
  power: ArrayLike<number>,
  binHz: number,
  minHz: number,
  maxHz: number,
): number {
  let weighted = 0;
  let total = 0;
  const first = Math.max(1, Math.floor(minHz / binHz));
  const last = Math.min(power.length - 1, Math.ceil(maxHz / binHz));
  for (let i = first; i <= last; i += 1) {
    const p = power[i] ?? 0;
    weighted += p * i * binHz;
    total += p;
  }
  if (total <= 0) return 0;
  const hz = weighted / total;
  if (hz <= minHz) return 0;
  return Math.min(1, Math.log(hz / minHz) / Math.log(maxHz / minHz));
}

/**
 * Positive spectral flux between two magnitude spectra: how much energy *appeared*. Only rises
 * count — a note ending is not an onset, and counting it would fire the source twice per note.
 */
export function spectralFlux(current: ArrayLike<number>, previous: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 1; i < current.length; i += 1) {
    const rise = (current[i] ?? 0) - (previous[i] ?? 0);
    if (rise > 0) sum += rise;
  }
  return sum;
}

/** Root mean square over a window of `pcm` centred on `centre`. */
export function windowedRms(pcm: Float32Array, centre: number, length: number): number {
  const half = Math.floor(length / 2);
  let sum = 0;
  let counted = 0;
  for (let i = centre - half; i < centre - half + length; i += 1) {
    if (i < 0 || i >= pcm.length) continue;
    const s = pcm[i] ?? 0;
    sum += s * s;
    counted += 1;
  }
  if (counted === 0) return 0;
  // ×√2 so a full-scale sine reads 1.0, matching how the band tracks are scaled.
  return Math.sqrt(sum / counted) * Math.SQRT2;
}

export function windowedPeak(pcm: Float32Array, centre: number, length: number): number {
  const half = Math.floor(length / 2);
  let peak = 0;
  for (let i = centre - half; i < centre - half + length; i += 1) {
    if (i < 0 || i >= pcm.length) continue;
    peak = Math.max(peak, Math.abs(pcm[i] ?? 0));
  }
  return peak;
}

/**
 * Side/mid energy ratio: 0 is mono, 1 is fully decorrelated. Needs both channels, so it is
 * absent — not zero — when only a mono decode is available (data-formats §4.4).
 */
export function stereoWidth(left: Float32Array, right: Float32Array, centre: number, length: number): number {
  const half = Math.floor(length / 2);
  let mid = 0;
  let side = 0;
  for (let i = centre - half; i < centre - half + length; i += 1) {
    if (i < 0 || i >= left.length || i >= right.length) continue;
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    mid += ((l + r) / 2) ** 2;
    side += ((l - r) / 2) ** 2;
  }
  const total = mid + side;
  return total <= 0 ? 0 : Math.min(1, Math.sqrt(side / total) * Math.SQRT2);
}

// ---------------------------------------------------------------------------
// Onsets
// ---------------------------------------------------------------------------

export interface OnsetOptions {
  /** Samples per second of the input track (the analysis rate). */
  readonly rate: number;
  /** 0..1. Higher finds more onsets; the default is deliberately conservative. */
  readonly sensitivity: number;
  /** Half-width of the adaptive-threshold window, in seconds. */
  readonly windowSeconds?: number;
  /** Shortest gap between two onsets, in seconds — drums are not machine-gun fire. */
  readonly minIntervalSeconds?: number;
}

export interface OnsetResult {
  /** A decaying impulse per detected onset, 0..1 — the punchy modulation source. */
  readonly strength: Float32Array;
  /** Onset times in seconds. */
  readonly times: readonly number[];
}

/**
 * Peak-picks an onset envelope against an **adaptive** threshold: a local mean plus a margin,
 * rather than one absolute level. A fixed threshold either misses the quiet intro or fires
 * continuously through the loud section, which is why a naive detector feels broken on real,
 * dynamic material.
 */
export function detectOnsets(flux: Float32Array, options: OnsetOptions): OnsetResult {
  const { rate, sensitivity } = options;
  const strength = new Float32Array(flux.length);
  if (flux.length === 0) return { strength, times: [] };

  const half = Math.max(1, Math.round((options.windowSeconds ?? 0.15) * rate));
  const minGap = Math.max(1, Math.round((options.minIntervalSeconds ?? 0.05) * rate));
  // sensitivity 0 → a high bar (only obvious hits); 1 → a low one (everything that rises).
  const margin = 2.2 - 1.9 * Math.min(1, Math.max(0, sensitivity));

  // Normalise the envelope first so `margin` means the same thing on any material.
  let maximum = 0;
  for (const value of flux) maximum = Math.max(maximum, value);
  if (maximum <= 0) return { strength, times: [] };

  const times: number[] = [];
  let lastOnset = -minGap;
  for (let i = 0; i < flux.length; i += 1) {
    const from = Math.max(0, i - half);
    const to = Math.min(flux.length - 1, i + half);
    let sum = 0;
    for (let j = from; j <= to; j += 1) sum += flux[j] ?? 0;
    const local = sum / (to - from + 1);

    const value = flux[i] ?? 0;
    const previous = flux[i - 1] ?? 0;
    const next = flux[i + 1] ?? 0;
    const isPeak = value >= previous && value > next;
    if (isPeak && value > local * margin && value > maximum * 0.02 && i - lastOnset >= minGap) {
      times.push(i / rate);
      lastOnset = i;
    }
  }

  // Each onset becomes a decaying impulse: instant attack, ~120 ms fall. That shape is what
  // makes `onset` the punchiest source in the catalogue (modulation-spec §2.1).
  const decay = Math.exp(-1 / (0.12 * rate));
  let level = 0;
  let next = 0;
  for (let i = 0; i < flux.length; i += 1) {
    if (next < times.length && Math.round((times[next] as number) * rate) === i) {
      level = 1;
      next += 1;
    }
    strength[i] = level;
    level *= decay;
  }

  return { strength, times };
}

// ---------------------------------------------------------------------------
// Tempo and the beat grid
// ---------------------------------------------------------------------------

export interface BeatGrid {
  readonly bpm: number;
  /** Beat times in seconds. */
  readonly beats: readonly number[];
  /** 0..1. How strongly the onset envelope agreed with this tempo. */
  readonly confidence: number;
}

export interface TempoOptions {
  readonly rate: number;
  readonly minBpm?: number;
  readonly maxBpm?: number;
  /** Overrides detection; the grid is then laid out at this tempo (analysisSettings.bpmOverride). */
  readonly bpmOverride?: number | null;
}

/**
 * Tempo by autocorrelation of the onset envelope, then phase by trying every offset within one
 * beat and keeping the one the onsets line up with best.
 *
 * The grid is a **list of beat times**, not a BPM plus an offset, because modulation-spec §6.1
 * wants tempo drift to be representable — live playing slides, and a single BPM slowly walks
 * out of phase with the track. This implementation lays out a constant tempo; the format is
 * already what a drift-aware detector (S16, `librosa`/`madmom`) would fill in.
 */
export function detectTempo(onsetStrength: Float32Array, durationSeconds: number, options: TempoOptions): BeatGrid {
  const { rate } = options;
  const minBpm = options.minBpm ?? 70;
  const maxBpm = options.maxBpm ?? 180;

  if (options.bpmOverride != null && options.bpmOverride > 0) {
    return { bpm: options.bpmOverride, beats: layOutBeats(options.bpmOverride, 0, durationSeconds), confidence: 1 };
  }
  if (onsetStrength.length < rate) return { bpm: 0, beats: [], confidence: 0 };

  const minLag = Math.floor((60 / maxBpm) * rate);
  const maxLag = Math.ceil((60 / minBpm) * rate);
  let bestLag = 0;
  let bestScore = 0;
  let total = 0;

  for (let lag = minLag; lag <= maxLag && lag < onsetStrength.length; lag += 1) {
    let score = 0;
    for (let i = 0; i + lag < onsetStrength.length; i += 1) {
      score += (onsetStrength[i] ?? 0) * (onsetStrength[i + lag] ?? 0);
    }
    // Longer lags correlate over fewer samples; normalise or the search always picks the slowest.
    score /= onsetStrength.length - lag;
    total += score;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  if (bestLag === 0 || bestScore <= 0) return { bpm: 0, beats: [], confidence: 0 };

  const bpm = (60 * rate) / bestLag;
  // How much the winning lag stands out from the average — a flat correlation means the
  // material has no steady pulse, and saying so beats reporting a confident wrong tempo.
  const mean = total / (maxLag - minLag + 1);
  const confidence = mean > 0 ? Math.min(1, Math.max(0, 1 - mean / bestScore)) : 0;

  let bestPhase = 0;
  let bestPhaseScore = -1;
  for (let phase = 0; phase < bestLag; phase += 1) {
    let score = 0;
    for (let i = phase; i < onsetStrength.length; i += bestLag) score += onsetStrength[i] ?? 0;
    if (score > bestPhaseScore) {
      bestPhaseScore = score;
      bestPhase = phase;
    }
  }

  return { bpm, beats: layOutBeats(bpm, bestPhase / rate, durationSeconds), confidence };
}

function layOutBeats(bpm: number, offsetSeconds: number, durationSeconds: number): number[] {
  const period = 60 / bpm;
  const beats: number[] = [];
  for (let t = offsetSeconds; t <= durationSeconds; t += period) beats.push(t);
  return beats;
}

/**
 * A 0..1 pulse that peaks on each beat and falls away between them — the `beat` source
 * (modulation-spec §2.1). Machine-perfect by construction, which is the point: it is the
 * reliable counterpart to `onset`, which follows what actually happened.
 */
export function beatPulse(grid: BeatGrid, rate: number, frames: number): Float32Array {
  const pulse = new Float32Array(frames);
  if (grid.beats.length === 0) return pulse;
  const decay = Math.exp(-1 / (0.1 * rate));
  let level = 0;
  let next = 0;
  for (let i = 0; i < frames; i += 1) {
    while (next < grid.beats.length && Math.round((grid.beats[next] as number) * rate) <= i) {
      level = 1;
      next += 1;
    }
    pulse[i] = level;
    level *= decay;
  }
  return pulse;
}
