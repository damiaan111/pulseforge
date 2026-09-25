// The modulation system (modulation-spec §2–§9) — step 4 of the value resolution pipeline.
//
// The determinism trap, and why this file is shaped the way it is:
//
// The obvious way to smooth a signal is a one-pole filter updated per frame, `y += (x-y)*k`.
// It is stateful, so the value at t=90 s depends on every frame before it — meaning a seek
// and a playthrough disagree, and the preview and the export disagree with them both, on some
// frames only. That is the most expensive kind of bug this project can have.
//
// So **envelopes are precomputed, not accumulated**. `compileModulation` walks the whole track
// once at the analysis rate, builds each binding's smoothed signal as a derived track, and
// render time is a sample-and-interpolate: a pure function of t, identical however it is
// reached. Identical settings share one track (D22), so ten bindings on the same kick cost one.
//
// Everything else follows the same rule: sources are closed-form or precomputed, randomness is
// `hash(seed, bindingId, eventIndex)` keyed on the musical event and never on a counter, and
// nothing anywhere reads a clock or a frame counter.

import { ANALYSIS_RATE, sampleTrack, type AnalysisSet, type AnalysisTrack } from './analysis.ts';
import { isSungRole, lyricSignals, type RenderLyrics } from './lyrics.ts';
import { random01 } from './prng.ts';

// ---------------------------------------------------------------------------
// The binding, as the engine sees it
// ---------------------------------------------------------------------------

export type ModulationMode = 'add' | 'multiply' | 'replace';
export type EnvelopeMode = 'peak' | 'linear';

export interface ModulationRange {
  readonly min: number;
  readonly max: number;
}

/**
 * What drives a binding. `type` picks the family; the rest are the union of what the families
 * need. Flat rather than a discriminated union so a source from a newer build round-trips
 * through the document untouched instead of being reset (modulation-spec §2).
 */
export interface ModulationSource {
  readonly type: string;
  /** mix | drums | bass | vocals | other (+ guitar | piano on the 6-stem model). */
  readonly stem: string;
  /** Named band for `band`. */
  readonly band?: string | null;
  /** `lfo`: sine | triangle | saw | square | noise | sample-hold. */
  readonly shape?: string;
  readonly rateHz?: number;
  readonly phase?: number;
  /** `lfo`: beats per cycle when locked to the grid instead of to `rateHz`. */
  readonly syncDivision?: number | null;
  /** `noise`: cycles per second of the underlying value noise, and how many octaves. */
  readonly noiseScale?: number;
  readonly octaves?: number;
  /** `ramp`: the value at t=0 and at the end of the track. */
  readonly from?: number;
  readonly to?: number;
}

export interface CurveSpec {
  readonly type: string;
  readonly amount: number;
}

export interface EnvelopeSpec {
  readonly attackMs: number;
  readonly releaseMs: number;
  readonly mode: EnvelopeMode;
}

export interface QuantiseSpec {
  readonly division: number;
  readonly mode: 'trigger' | 'hold';
  readonly swing: number;
  readonly humanise: number;
}

export interface ModulationBinding {
  readonly id: string;
  readonly enabled: boolean;
  readonly source: ModulationSource;
  /** `layers.<id>.params.<key>` (module-spec §4). */
  readonly target: string;
  readonly inputRange: ModulationRange | 'auto';
  readonly curve: CurveSpec;
  readonly envelope: EnvelopeSpec;
  readonly quantise: QuantiseSpec | null;
  /**
   * Sampling offset, applied as `source(t + lookAheadMs)` (modulation-spec §4 step 1).
   * **Positive looks ahead** — the binding sees the event before it happens, which is what
   * compensates detection and envelope lag so hits land on the beat instead of behind it.
   * Negative delays the reaction.
   *
   * The convention is settled by D51: D23's "−30 ms lag compensation" describes the lag being
   * cancelled, not the stored value. Read literally against §4's formula a negative offset
   * would sample earlier audio and make the lag worse, so the default is +30.
   */
  readonly lookAheadMs: number;
  readonly amount: number;
  readonly offset: number;
  readonly invert: boolean;
  readonly mode: ModulationMode;
  readonly order: number;
  readonly clampOutput: ModulationRange | null;
}

// ---------------------------------------------------------------------------
// Curves (modulation-spec §4.2)
// ---------------------------------------------------------------------------

/**
 * Reshapes 0..1 → 0..1. `amount` means something different per curve, which is why each is
 * spelled out: these mappings are part of every project's appearance, and
 * tests/engine/modulation.test.ts pins them.
 */
export function applyCurve(v: number, curve: CurveSpec): number {
  const a = Math.min(1, Math.max(0, curve.amount));
  switch (curve.type) {
    case 'linear':
      return v;
    // Emphasise the top: only the loudest hits register. amount 0 → linear, 1 → v⁴.
    case 'exp':
    case 'pow':
      return Math.pow(v, 1 + a * 3);
    // Emphasise the bottom: quiet detail becomes visible.
    case 'log':
      return Math.pow(v, 1 / (1 + a * 3));
    // Soft ends, steep middle: punchier without clipping. amount blends toward full smoothstep.
    case 's-curve':
      return v + (v * v * (3 - 2 * v) - v) * a;
    // A gate. `amount` is the edge; the soft knee is a tenth of the range, so it is a
    // trigger rather than a hard step that flickers on noise.
    case 'threshold': {
      const soft = 0.05;
      const lo = a - soft;
      const hi = a + soft;
      if (v <= lo) return 0;
      if (v >= hi) return 1;
      const x = (v - lo) / (hi - lo);
      return x * x * (3 - 2 * x);
    }
    // Chunky, digital motion: 2 steps at amount 0, 16 at amount 1.
    case 'stepped': {
      const steps = Math.round(2 + a * 14);
      return Math.min(steps - 1, Math.floor(v * steps)) / (steps - 1);
    }
    default:
      // An unknown curve behaves as linear. The compiler reports it rather than the
      // renderer silently choosing a shape.
      return v;
  }
}

export const KNOWN_CURVES: readonly string[] = ['linear', 'exp', 'pow', 'log', 's-curve', 'threshold', 'stepped'];

// ---------------------------------------------------------------------------
// Closed-form generators (modulation-spec §2.2)
// ---------------------------------------------------------------------------

function smoothstep(x: number): number {
  return x * x * (3 - 2 * x);
}

/** Smooth 1D value noise in 0..1, seeded. Closed-form in t, so seeking is free. */
export function valueNoise(seed: number, key: string, x: number, octaves = 1): number {
  let total = 0;
  let amplitude = 1;
  let sum = 0;
  let frequency = 1;
  for (let o = 0; o < Math.max(1, Math.min(8, Math.round(octaves))); o += 1) {
    const p = x * frequency;
    const i = Math.floor(p);
    const f = smoothstep(p - i);
    const a = random01(seed, key, 'noise', i);
    const b = random01(seed, key, 'noise', i + 1);
    total += (a + (b - a) * f) * amplitude;
    sum += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return sum === 0 ? 0 : total / sum;
}

function lfo(source: ModulationSource, seed: number, bindingId: string, t: number): number {
  const rate = source.rateHz ?? 1;
  const p = t * rate + (source.phase ?? 0);
  const frac = p - Math.floor(p);
  switch (source.shape ?? 'sine') {
    case 'sine':
      return 0.5 + 0.5 * Math.sin(2 * Math.PI * p);
    case 'triangle':
      return 1 - Math.abs(2 * frac - 1);
    case 'saw':
      return frac;
    case 'square':
      return frac < 0.5 ? 1 : 0;
    case 'noise':
      return valueNoise(seed, bindingId, p, source.octaves ?? 1);
    case 'sample-hold':
      // Keyed on the cycle index, not a counter: bar 64 always holds bar 64's value.
      return random01(seed, bindingId, 'sh', Math.floor(p));
    default:
      return 0.5 + 0.5 * Math.sin(2 * Math.PI * p);
  }
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

export type ModulationProblem =
  | 'unknown-source'
  | 'missing-stem'
  | 'missing-band'
  | 'unknown-curve'
  | 'unsupported'
  | 'broken-target';

export interface ModulationIssue {
  readonly bindingId: string;
  readonly target: string;
  readonly problem: ModulationProblem;
  readonly detail: string;
}

export interface CompileOptions {
  readonly bindings: readonly ModulationBinding[];
  readonly analysis: AnalysisSet;
  /** Timeline length in seconds — the domain envelopes and `progress` are computed over. */
  readonly durationSeconds: number;
  readonly seed: number;
  /** Samples per second for derived tracks. Defaults to the analysis rate (D11). */
  readonly rate?: number;
  /** The project's timed lyrics, for the lyric sources (modulation-spec §2.4). */
  readonly lyrics?: RenderLyrics;
}

interface CompiledBinding {
  readonly binding: ModulationBinding;
  /** The signal after look-ahead, normalisation, curve and envelope: a pure function of t. */
  readonly signal: (t: number) => number;
}

export interface ModulationProgram {
  /** Target path → bindings in evaluation order. */
  readonly targets: ReadonlyMap<string, readonly CompiledBinding[]>;
  readonly issues: readonly ModulationIssue[];
}

/** Generators are already 0..1 by construction; auto-calibrating one would be meaningless. */
const GENERATORS = new Set(['lfo', 'ramp', 'progress', 'noise']);

/** Sources that are 0..1 by definition, so `inputRange: 'auto'` leaves them alone. */
const FIXED_RANGE = new Set([...GENERATORS, 'lyricActive', 'lineProgress', 'wordActive']);

/** Built once per compile and shared by every lyric binding: the signals scan the lines. */
const lyricSignalCache = new WeakMap<RenderLyrics, ReturnType<typeof lyricSignals>>();

type TrackLookup = AnalysisTrack | { error: ModulationProblem; detail: string };

function sourceFor(analysis: AnalysisSet, stem: string): { spectrumOwner: NonNullable<ReturnType<AnalysisSet['sources']['get']>> } | { error: ModulationProblem; detail: string } {
  const found = analysis.sources.get(stem as never);
  if (found === undefined) {
    const available = [...analysis.sources.keys()].join(', ') || 'none';
    return { error: 'missing-stem', detail: `stem "${stem}" has not been analysed (available: ${available}); the binding is inactive` };
  }
  return { spectrumOwner: found };
}

function bandTrack(analysis: AnalysisSet, source: ModulationSource): TrackLookup {
  const stem = sourceFor(analysis, source.stem);
  if ('error' in stem) return stem;
  const name = source.band ?? '';
  const track = stem.spectrumOwner.bands.get(name);
  if (track === undefined) {
    const available = [...stem.spectrumOwner.bands.keys()].join(', ') || 'none';
    return { error: 'missing-band', detail: `band "${name}" is not in the analysis for "${source.stem}" (available: ${available}); the binding is inactive` };
  }
  return track;
}

/**
 * A named scalar feature (`rms`, `onset`, `beat`, …). A feature that was not computed is
 * **absent**, so a binding on it is reported rather than reading as a track of zeros — which
 * would look exactly like silence and get debugged as one (data-formats §4.4).
 */
function featureTrack(analysis: AnalysisSet, source: ModulationSource, feature: string): TrackLookup {
  const stem = sourceFor(analysis, source.stem);
  if ('error' in stem) return stem;
  const track = stem.spectrumOwner.features.get(feature);
  if (track === undefined) {
    const available = [...stem.spectrumOwner.features.keys()].join(', ') || 'none';
    return {
      error: 'unsupported',
      detail: `"${feature}" was not computed for "${source.stem}" (available: ${available}); the binding is kept and inactive`,
    };
  }
  return track;
}

/** The raw source before any shaping: `(t) => number`, pure, unnormalised. */
function rawSampler(
  binding: ModulationBinding,
  options: CompileOptions,
): ((t: number) => number) | { error: ModulationProblem; detail: string } {
  const { source } = binding;
  const { seed, durationSeconds } = options;
  switch (source.type) {
    case 'band': {
      const track = bandTrack(options.analysis, source);
      if ('error' in track) return track;
      return (t) => sampleTrack(track, t);
    }
    case 'progress':
      return (t) => (durationSeconds > 0 ? Math.min(1, Math.max(0, t / durationSeconds)) : 0);
    case 'ramp': {
      const from = source.from ?? 0;
      const to = source.to ?? 1;
      return (t) => {
        const p = durationSeconds > 0 ? Math.min(1, Math.max(0, t / durationSeconds)) : 0;
        return from + (to - from) * p;
      };
    }
    case 'lfo':
      if (source.syncDivision != null) {
        return { error: 'unsupported', detail: 'beat-synced LFO rates need the beat grid, which the analysis pipeline does not produce yet; the binding is inactive' };
      }
      return (t) => lfo(source, seed, binding.id, t);
    case 'noise':
      return (t) => valueNoise(seed, binding.id, t * (source.noiseScale ?? 1), source.octaves ?? 1);
    case 'rms':
    case 'peak':
    case 'onset':
    case 'beat':
    case 'centroid':
    case 'flux':
    case 'stereoWidth': {
      const track = featureTrack(options.analysis, source, source.type);
      if ('error' in track) return track;
      return (t) => sampleTrack(track, t);
    }
    case 'sectionIndex':
    case 'sectionProgress':
    case 'energyEnvelope':
    case 'isDrop':
    case 'isBuild':
      return { error: 'unsupported', detail: `structural source "${source.type}" needs section detection (auto-director-spec); the binding is kept and inactive` };
    case 'lyricActive':
    case 'lineProgress':
    case 'wordActive': {
      const lyrics = options.lyrics;
      // Said, not silently zero: a flat 0 would look exactly like a binding that is broken.
      if (lyrics === undefined || !lyrics.lines.some((line) => isSungRole(line.role))) {
        return { error: 'unsupported', detail: `"${source.type}" follows the lyrics, and the project has no timed sung lines yet; the binding is kept and inactive` };
      }
      let signals = lyricSignalCache.get(lyrics);
      if (signals === undefined) {
        signals = lyricSignals(lyrics);
        lyricSignalCache.set(lyrics, signals);
      }
      return signals[source.type];
    }
    case 'parameter':
      return { error: 'unsupported', detail: 'parameter chaining needs the dependency graph (modulation-spec §9.3); the binding is kept and inactive' };
    default:
      return { error: 'unknown-source', detail: `"${source.type}" is not a modulation source this build knows; the binding is kept and inactive` };
  }
}

/**
 * Percentile calibration (modulation-spec §7): p10 → 0, p90 → 1. A compressed master's bass
 * band may only ever occupy 0.55–0.85 of its nominal range; mapped linearly the modulation
 * barely moves, and every binding then needs hand-tuning.
 */
function autoRange(sample: (t: number) => number, durationSeconds: number, rate: number): ModulationRange {
  const count = Math.max(2, Math.ceil(durationSeconds * rate));
  const values = new Float64Array(count);
  for (let i = 0; i < count; i += 1) values[i] = sample(i / rate);
  values.sort();
  const at = (p: number) => values[Math.min(count - 1, Math.max(0, Math.round(p * (count - 1))))] as number;
  const min = at(0.1);
  const max = at(0.9);
  // A flat source would map everything to 0/0; leave it unscaled rather than dividing by zero.
  return max - min > 1e-9 ? { min, max } : { min: 0, max: 1 };
}

function normalise(v: number, range: ModulationRange): number {
  const span = range.max - range.min;
  if (Math.abs(span) < 1e-12) return 0;
  return Math.min(1, Math.max(0, (v - range.min) / span));
}

/**
 * One-pole envelope over a whole track, computed once (modulation-spec §5).
 * `peak` never falls faster than `release` — the musical default. `linear` smooths
 * symmetrically, using the mean of the two times so switching modes does not jump.
 */
export function smoothEnvelope(input: Float32Array, rate: number, envelope: EnvelopeSpec): Float32Array {
  const coefficient = (ms: number) => (ms <= 0 ? 0 : Math.exp(-1 / ((ms / 1000) * rate)));
  const symmetric = coefficient((envelope.attackMs + envelope.releaseMs) / 2);
  const rise = envelope.mode === 'linear' ? symmetric : coefficient(envelope.attackMs);
  const fall = envelope.mode === 'linear' ? symmetric : coefficient(envelope.releaseMs);

  const out = new Float32Array(input.length);
  if (input.length === 0) return out;
  let y = input[0] as number;
  for (let i = 0; i < input.length; i += 1) {
    const x = input[i] as number;
    const a = x > y ? rise : fall;
    y = x + (y - x) * a;
    out[i] = y;
  }
  return out;
}

const hasEnvelope = (e: EnvelopeSpec) => e.attackMs > 0 || e.releaseMs > 0;

function derivedKey(binding: ModulationBinding, range: ModulationRange): string {
  const s = binding.source;
  return JSON.stringify([
    s.type, s.stem, s.band ?? null, s.shape ?? null, s.rateHz ?? null, s.phase ?? null,
    s.noiseScale ?? null, s.octaves ?? null, s.from ?? null, s.to ?? null,
    range.min, range.max, binding.curve.type, binding.curve.amount,
    binding.envelope.attackMs, binding.envelope.releaseMs, binding.envelope.mode,
    binding.lookAheadMs,
    // The generators and `noise` are seeded per binding, so they can never share a track.
    GENERATORS.has(s.type) ? binding.id : '',
  ]);
}

export function compileModulation(options: CompileOptions): ModulationProgram {
  const rate = options.rate ?? ANALYSIS_RATE;
  const issues: ModulationIssue[] = [];
  const byTarget = new Map<string, CompiledBinding[]>();
  const derived = new Map<string, AnalysisTrack>();

  for (const binding of options.bindings) {
    if (!binding.enabled) continue;
    if (binding.target === '') {
      issues.push({ bindingId: binding.id, target: binding.target, problem: 'broken-target', detail: 'the binding has no target path' });
      continue;
    }
    if (!KNOWN_CURVES.includes(binding.curve.type)) {
      issues.push({ bindingId: binding.id, target: binding.target, problem: 'unknown-curve', detail: `curve "${binding.curve.type}" is not implemented; the binding behaves as linear` });
    }
    if (binding.quantise !== null) {
      issues.push({ bindingId: binding.id, target: binding.target, problem: 'unsupported', detail: 'quantisation needs the beat grid, which the analysis pipeline does not produce yet; the setting is stored but not applied' });
    }

    const raw = rawSampler(binding, options);
    if (typeof raw !== 'function') {
      issues.push({ bindingId: binding.id, target: binding.target, problem: raw.error, detail: raw.detail });
      continue;
    }

    const lookAhead = binding.lookAheadMs / 1000;
    const shifted = (t: number) => raw(t + lookAhead);
    const range = binding.inputRange === 'auto'
      ? (FIXED_RANGE.has(binding.source.type) ? { min: 0, max: 1 } : autoRange(shifted, options.durationSeconds, rate))
      : binding.inputRange;

    const shaped = (t: number) => applyCurve(normalise(shifted(t), range), binding.curve);

    let signal: (t: number) => number;
    if (hasEnvelope(binding.envelope)) {
      // Precomputed once across the whole track, then shared by every identical binding (D22).
      const key = derivedKey(binding, range);
      let track = derived.get(key);
      if (track === undefined) {
        const count = Math.max(2, Math.ceil(options.durationSeconds * rate) + 1);
        const input = new Float32Array(count);
        for (let i = 0; i < count; i += 1) input[i] = shaped(i / rate);
        track = { rate, channels: 1, data: smoothEnvelope(input, rate, binding.envelope) };
        derived.set(key, track);
      }
      const resolved = track;
      signal = (t) => sampleTrack(resolved, t);
    } else {
      signal = shaped;
    }

    const list = byTarget.get(binding.target) ?? [];
    list.push({ binding, signal });
    byTarget.set(binding.target, list);
  }

  // Explicit order, with the id as the tie-break so two bindings at the same order never
  // depend on the document's array order (modulation-spec §9.2).
  for (const list of byTarget.values()) {
    list.sort((a, b) => a.binding.order - b.binding.order || (a.binding.id < b.binding.id ? -1 : a.binding.id > b.binding.id ? 1 : 0));
  }

  return { targets: byTarget, issues };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * The accumulated value for one target at time t (modulation-spec §4 steps 6–8, §9.1).
 * `base` is the value after the aspect override and automation; the result is **not** clamped
 * to the parameter's range — that happens once, at the end, in params.ts (module-spec §5).
 */
/**
 * Each enabled binding's shaped signal at time t — after look-ahead, normalisation, curve and
 * envelope, before invert and amount — so the studio can show whether a source is doing anything
 * here (modulation-spec §10 "source monitor"). 0..1 for well-calibrated sources.
 */
export function bindingLevels(program: ModulationProgram, t: number): Map<string, number> {
  const levels = new Map<string, number>();
  for (const list of program.targets.values()) {
    for (const { binding, signal } of list) levels.set(binding.id, signal(t));
  }
  return levels;
}

export function modulateValue(program: ModulationProgram, target: string, base: number, t: number): number {
  const bindings = program.targets.get(target);
  if (bindings === undefined) return base;

  let accumulator = base;
  for (const { binding, signal } of bindings) {
    const shaped = signal(t);
    const inverted = binding.invert ? 1 - shaped : shaped;
    let out = inverted * binding.amount + binding.offset;
    if (binding.clampOutput !== null) {
      out = Math.min(binding.clampOutput.max, Math.max(binding.clampOutput.min, out));
    }
    switch (binding.mode) {
      case 'add':
        accumulator += out;
        break;
      // `acc *= (1 + out)` so that 0 means "no change" (D21). A plain multiply by a source
      // that reaches 0 would collapse the parameter to nothing, which is almost never wanted.
      case 'multiply':
        accumulator *= 1 + out;
        break;
      // Ends the chain: everything before it is discarded.
      case 'replace':
        accumulator = out;
        break;
    }
  }
  return accumulator;
}
