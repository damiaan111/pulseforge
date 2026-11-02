// The modulation system (modulation-spec §4–§9).
//
// The test that matters most is "seeking and playing agree": envelopes are precomputed
// precisely so that the value at t never depends on how t was reached. A stateful filter
// would pass every other test here and fail that one.

import { describe, expect, it } from 'vitest';

import { ANALYSIS_RATE, type AnalysisSet, type AnalysisTrack } from '../../src/engine/core/analysis.ts';
import {
  applyCurve, bindingLevels, compileModulation, markerProgress, markerPulse, modulateValue, sampleCurve, smoothEnvelope, valueNoise,
  type ModulationBinding, type ModulationSource,
} from '../../src/engine/core/modulation.ts';
import { resolveParams, type ParamSpec } from '../../src/engine/core/params.ts';

const DURATION = 4;
const TARGET = 'layers.K1.params.glow';

function track(values: readonly number[], rate = ANALYSIS_RATE): AnalysisTrack {
  return { rate, channels: 1, data: Float32Array.from(values) };
}

/** An analysis set with one band on the mix, sampled at the analysis rate. */
function analysisWith(bandValues: readonly number[], name = 'bass', stem: 'mix' | 'drums' = 'mix'): AnalysisSet {
  return {
    sources: new Map([[stem, {
      spectrum: track([]),
      bands: new Map([[name, track(bandValues)]]),
      features: new Map(),
    }]]),
  };
}

const EMPTY_ANALYSIS: AnalysisSet = { sources: new Map() };

const source = (overrides: Partial<ModulationSource> = {}): ModulationSource => ({
  type: 'band',
  stem: 'mix',
  band: 'bass',
  ...overrides,
});

function binding(overrides: Partial<ModulationBinding> = {}): ModulationBinding {
  return {
    id: 'B1',
    enabled: true,
    source: source(),
    target: TARGET,
    inputRange: { min: 0, max: 1 },
    curve: { type: 'linear', amount: 0 },
    envelope: { attackMs: 0, releaseMs: 0, mode: 'peak' },
    quantise: null,
    lookAheadMs: 0,
    amount: 1,
    offset: 0,
    invert: false,
    mode: 'add',
    order: 0,
    clampOutput: null,
    ...overrides,
  };
}

const compile = (bindings: readonly ModulationBinding[], analysis: AnalysisSet = analysisWith([0, 1])) =>
  compileModulation({ bindings, analysis, durationSeconds: DURATION, seed: 7 });

describe('curves', () => {
  it('leaves the ends alone and only reshapes between them', () => {
    for (const type of ['linear', 'exp', 'log', 's-curve', 'stepped']) {
      expect(applyCurve(0, { type, amount: 0.5 })).toBeCloseTo(0, 9);
      expect(applyCurve(1, { type, amount: 0.5 })).toBeCloseTo(1, 9);
    }
  });

  it('exp emphasises the top and log the bottom', () => {
    expect(applyCurve(0.5, { type: 'exp', amount: 1 })).toBeLessThan(0.5);
    expect(applyCurve(0.5, { type: 'log', amount: 1 })).toBeGreaterThan(0.5);
    expect(applyCurve(0.5, { type: 'exp', amount: 0 })).toBeCloseTo(0.5, 9);
  });

  it('threshold gates: below the edge nothing, above it everything', () => {
    const curve = { type: 'threshold', amount: 0.7 };
    expect(applyCurve(0.5, curve)).toBe(0);
    expect(applyCurve(0.7, curve)).toBeCloseTo(0.5, 6);
    expect(applyCurve(0.9, curve)).toBe(1);
  });

  it('stepped quantises the value', () => {
    const curve = { type: 'stepped', amount: 0 }; // two steps
    expect(applyCurve(0.2, curve)).toBe(0);
    expect(applyCurve(0.8, curve)).toBe(1);
  });

  it('falls back to linear for a curve it does not know', () => {
    expect(applyCurve(0.42, { type: 'wobble', amount: 1 })).toBe(0.42);
  });
});

describe('envelopes — the determinism property', () => {
  it('is a pure function of t: any evaluation order gives the same values', () => {
    // A one-pole filter stepped per frame would make these differ, and only on some frames.
    const program = compile([binding({ envelope: { attackMs: 5, releaseMs: 250, mode: 'peak' } })],
      analysisWith(Array.from({ length: 240 * DURATION }, (_, i) => (i % 60 === 0 ? 1 : 0))));

    const times = Array.from({ length: 60 }, (_, i) => i / 20);
    const forwards = times.map((t) => modulateValue(program, TARGET, 0, t));
    const backwards = [...times].reverse().map((t) => modulateValue(program, TARGET, 0, t)).reverse();
    const jumped = [times[37] as number, times[4] as number, times[50] as number].map((t) => modulateValue(program, TARGET, 0, t));

    expect(backwards).toEqual(forwards);
    expect(jumped).toEqual([forwards[37], forwards[4], forwards[50]]);
  });

  it('rises fast and falls slowly in peak mode', () => {
    const input = Float32Array.from([0, 1, 1, 0, 0, 0, 0, 0, 0, 0]);
    const out = smoothEnvelope(input, 100, { attackMs: 1, releaseMs: 200, mode: 'peak' });
    expect(out[1]).toBeGreaterThan(0.9); // attack is nearly instant
    expect(out[4]).toBeGreaterThan(0.8); // release holds the value up
    expect(out[9]).toBeLessThan(out[4] as number);
  });

  it('smooths symmetrically in linear mode', () => {
    const rise = smoothEnvelope(Float32Array.from([0, 1, 1, 1]), 100, { attackMs: 1, releaseMs: 500, mode: 'linear' });
    const fall = smoothEnvelope(Float32Array.from([1, 0, 0, 0]), 100, { attackMs: 1, releaseMs: 500, mode: 'linear' });
    // The same time constant both ways: the rise toward 1 mirrors the fall toward 0.
    // Float32 storage, so 6 places rather than 9.
    expect(rise[2] as number).toBeCloseTo(1 - (fall[2] as number), 6);
  });

  it('leaves the signal untouched when both times are zero', () => {
    const program = compile([binding()], analysisWith([0, 0.5, 1]));
    expect(modulateValue(program, TARGET, 0, 1 / ANALYSIS_RATE)).toBeCloseTo(0.5, 5);
  });
});

describe('the signal chain', () => {
  it('normalises the input range before the curve', () => {
    const program = compile([binding({ inputRange: { min: 0.5, max: 1 } })], analysisWith([0.5, 0.75, 1]));
    expect(modulateValue(program, TARGET, 0, 0)).toBeCloseTo(0, 6);
    expect(modulateValue(program, TARGET, 0, 2 / ANALYSIS_RATE)).toBeCloseTo(1, 6);
  });

  it('auto-calibrates to what the track actually uses (§7)', () => {
    // A compressed master's band only occupying 0.55–0.85 barely moves when mapped linearly.
    const values = Array.from({ length: ANALYSIS_RATE * DURATION }, (_, i) => 0.55 + 0.3 * ((i % 100) / 99));
    const fixed = compile([binding({ id: 'F', inputRange: { min: 0, max: 1 } })], analysisWith(values));
    const auto = compile([binding({ id: 'A', inputRange: 'auto' })], analysisWith(values));

    const spread = (program: ReturnType<typeof compile>) => {
      const samples = Array.from({ length: 200 }, (_, i) => modulateValue(program, TARGET, 0, i / 100));
      return Math.max(...samples) - Math.min(...samples);
    };
    expect(spread(fixed)).toBeLessThan(0.35);
    expect(spread(auto)).toBeGreaterThan(0.9);
  });

  it('does not auto-calibrate a generator, which is already 0..1', () => {
    const program = compile([binding({ source: source({ type: 'lfo', shape: 'saw', rateHz: 1 }), inputRange: 'auto' })], EMPTY_ANALYSIS);
    expect(modulateValue(program, TARGET, 0, 0)).toBeCloseTo(0, 6);
    expect(modulateValue(program, TARGET, 0, 0.5)).toBeCloseTo(0.5, 6);
  });

  it('sees the event early when look-ahead is positive (§6.3, D23)', () => {
    // A hit at t = 1 s. Looking 100 ms ahead, the binding reacts at t = 0.9 s — which is how
    // detection and envelope lag get cancelled so the visual lands on the beat.
    const values = new Array(ANALYSIS_RATE * DURATION).fill(0);
    values[ANALYSIS_RATE] = 1;
    const early = compile([binding({ lookAheadMs: 100 })], analysisWith(values));
    expect(modulateValue(early, TARGET, 0, 0.9)).toBeCloseTo(1, 5);
    expect(modulateValue(early, TARGET, 0, 1)).toBeCloseTo(0, 5);

    // Negative delays it instead, which is the same mechanism pointed the other way.
    const late = compile([binding({ lookAheadMs: -100 })], analysisWith(values));
    expect(modulateValue(late, TARGET, 0, 1.1)).toBeCloseTo(1, 5);
  });

  it('inverts, scales, offsets and clamps in that order', () => {
    const program = compile([binding({ invert: true, amount: 2, offset: 0.5, clampOutput: { min: 0, max: 1 } })], analysisWith([0]));
    // source 0 → invert → 1 → ×2 + 0.5 = 2.5 → clamped to 1
    expect(modulateValue(program, TARGET, 0, 0)).toBe(1);
  });
});

describe('accumulation (§9)', () => {
  const at = (bindings: readonly ModulationBinding[], base: number) =>
    modulateValue(compile(bindings, analysisWith([1])), TARGET, base, 0);

  it('adds', () => {
    expect(at([binding({ amount: 0.25 })], 1)).toBeCloseTo(1.25, 9);
  });

  it('multiplies as acc *= (1 + out), so 0 means no change (D21)', () => {
    expect(at([binding({ mode: 'multiply', amount: 1 })], 2)).toBeCloseTo(4, 9);
    expect(at([binding({ mode: 'multiply', amount: 0 })], 2)).toBeCloseTo(2, 9);
  });

  it('replace discards everything before it in the order', () => {
    const value = at([
      binding({ id: 'A', order: 0, amount: 5 }),
      binding({ id: 'B', order: 1, mode: 'replace', amount: 0.5 }),
    ], 1);
    expect(value).toBeCloseTo(0.5, 9);
  });

  it('applies bindings in explicit order, because add-then-multiply differs', () => {
    const addThenMultiply = at([
      binding({ id: 'A', order: 0, mode: 'add', amount: 1 }),
      binding({ id: 'B', order: 1, mode: 'multiply', amount: 1 }),
    ], 1);
    const multiplyThenAdd = at([
      binding({ id: 'A', order: 1, mode: 'add', amount: 1 }),
      binding({ id: 'B', order: 0, mode: 'multiply', amount: 1 }),
    ], 1);
    expect(addThenMultiply).toBeCloseTo(4, 9); // (1+1) * 2
    expect(multiplyThenAdd).toBeCloseTo(3, 9); // (1*2) + 1
  });

  it('breaks ties on id, never on the order the document happened to list them', () => {
    const forwards = compile([binding({ id: 'B', mode: 'replace', amount: 2 }), binding({ id: 'A', mode: 'replace', amount: 1 })], analysisWith([1]));
    const backwards = compile([binding({ id: 'A', mode: 'replace', amount: 1 }), binding({ id: 'B', mode: 'replace', amount: 2 })], analysisWith([1]));
    expect(modulateValue(forwards, TARGET, 0, 0)).toBe(modulateValue(backwards, TARGET, 0, 0));
  });

  it('leaves an untargeted parameter exactly as it was', () => {
    const program = compile([binding()], analysisWith([1]));
    expect(modulateValue(program, 'layers.K1.params.other', 0.3, 0)).toBe(0.3);
  });

  it('ignores a disabled binding', () => {
    expect(at([binding({ enabled: false, amount: 5 })], 1)).toBe(1);
  });
});

describe('what the compiler refuses to guess at', () => {
  const issuesFor = (b: ModulationBinding, analysis: AnalysisSet = analysisWith([1])) => compile([b], analysis).issues;

  it('reports an unknown source and keeps the binding inactive', () => {
    const issues = issuesFor(binding({ source: source({ type: 'telepathy' }) }));
    expect(issues[0]?.problem).toBe('unknown-source');
    expect(issues[0]?.detail).toContain('kept and inactive');
  });

  it('names the stems that were analysed when one is missing', () => {
    const issues = issuesFor(binding({ source: source({ stem: 'vocals' }) }));
    expect(issues[0]?.problem).toBe('missing-stem');
    expect(issues[0]?.detail).toContain('available: mix');
  });

  it('names the bands that exist when one is missing', () => {
    const issues = issuesFor(binding({ source: source({ band: 'brilliance' }) }));
    expect(issues[0]?.problem).toBe('missing-band');
    expect(issues[0]?.detail).toContain('available: bass');
  });

  it('reports a feature that was not computed, naming what is available', () => {
    // `analysisWith` produces bands but no features, which is exactly the "mono decode, so no
    // stereoWidth" case: absent must be reported, never read as a track of zeros.
    const issues = issuesFor(binding({ source: source({ type: 'stereoWidth' }) }));
    expect(issues[0]?.problem).toBe('unsupported');
    expect(issues[0]?.detail).toContain('was not computed');
  });

  it('reports sources that need work beyond analysis', () => {
    for (const type of ['sectionIndex', 'lyricActive', 'parameter']) {
      expect(issuesFor(binding({ source: source({ type }) }))[0]?.problem).toBe('unsupported');
    }
  });

  it('reports quantisation as stored but not applied', () => {
    const issues = issuesFor(binding({ quantise: { division: 1, mode: 'trigger', swing: 0, humanise: 0 } }));
    expect(issues.some((i) => i.detail.includes('stored but not applied'))).toBe(true);
  });

  it('reports an unknown curve and behaves as linear', () => {
    const program = compile([binding({ curve: { type: 'wobble', amount: 1 } })], analysisWith([0.5]));
    expect(program.issues[0]?.problem).toBe('unknown-curve');
    expect(modulateValue(program, TARGET, 0, 0)).toBeCloseTo(0.5, 5);
  });

  it('reports a binding with no target', () => {
    expect(issuesFor(binding({ target: '' }))[0]?.problem).toBe('broken-target');
  });
});

describe('feature sources (M4)', () => {
  /** An analysis set with named feature tracks, as `analyzeMix` now produces. */
  const withFeatures = (features: Record<string, readonly number[]>): AnalysisSet => ({
    sources: new Map([['mix', {
      spectrum: track([]),
      bands: new Map(),
      features: new Map(Object.entries(features).map(([name, values]) => [name, track(values)])),
    }]]),
  });

  it('reads every feature the catalogue names through the same path as bands', () => {
    for (const type of ['rms', 'peak', 'onset', 'beat', 'centroid', 'flux', 'stereoWidth']) {
      const program = compile([binding({ source: source({ type }) })], withFeatures({ [type]: [0, 1] }));
      expect(program.issues).toEqual([]);
      expect(modulateValue(program, TARGET, 0, 1 / ANALYSIS_RATE)).toBeCloseTo(1, 5);
    }
  });

  it('shapes a feature exactly as it shapes a band', () => {
    const impulse = new Array(ANALYSIS_RATE * DURATION).fill(0);
    impulse[ANALYSIS_RATE] = 1;
    const program = compile(
      [binding({ source: source({ type: 'onset' }), envelope: { attackMs: 0, releaseMs: 200, mode: 'peak' } })],
      withFeatures({ onset: impulse }),
    );
    expect(modulateValue(program, TARGET, 0, 1)).toBeCloseTo(1, 3);
    // The envelope holds it up afterwards rather than snapping back.
    expect(modulateValue(program, TARGET, 0, 1.1)).toBeGreaterThan(0.4);
  });
});

describe('generators are closed-form and seeded', () => {
  it('produces the same LFO value for the same t, always', () => {
    const program = compile([binding({ source: source({ type: 'lfo', shape: 'sine', rateHz: 2 }) })], EMPTY_ANALYSIS);
    expect(modulateValue(program, TARGET, 0, 0.125)).toBeCloseTo(1, 6);
    expect(modulateValue(program, TARGET, 0, 0.375)).toBeCloseTo(0, 6);
  });

  it('holds a sample-and-hold value across its whole cycle', () => {
    const program = compile([binding({ source: source({ type: 'sample-hold' as string, shape: 'sample-hold' }) })], EMPTY_ANALYSIS);
    // `sample-hold` is an LFO shape, not a source type — the source is reported instead.
    expect(program.issues[0]?.problem).toBe('unknown-source');

    const lfoProgram = compile([binding({ source: source({ type: 'lfo', shape: 'sample-hold', rateHz: 1 }) })], EMPTY_ANALYSIS);
    expect(modulateValue(lfoProgram, TARGET, 0, 0.1)).toBe(modulateValue(lfoProgram, TARGET, 0, 0.9));
    expect(modulateValue(lfoProgram, TARGET, 0, 1.1)).not.toBe(modulateValue(lfoProgram, TARGET, 0, 0.1));
  });

  it('gives smooth, repeatable value noise', () => {
    const a = valueNoise(7, 'B1', 3.25);
    expect(valueNoise(7, 'B1', 3.25)).toBe(a);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThanOrEqual(1);
    expect(Math.abs(valueNoise(7, 'B1', 3.26) - a)).toBeLessThan(0.1);
    expect(valueNoise(8, 'B1', 3.25)).not.toBe(a);
  });

  it('ramps across the track, not across a frame counter', () => {
    const program = compile([binding({ source: source({ type: 'ramp', from: 0, to: 1 }) })], EMPTY_ANALYSIS);
    expect(modulateValue(program, TARGET, 0, 0)).toBeCloseTo(0, 6);
    expect(modulateValue(program, TARGET, 0, DURATION / 2)).toBeCloseTo(0.5, 6);
    expect(modulateValue(program, TARGET, 0, DURATION)).toBeCloseTo(1, 6);
  });
});

// ---------------------------------------------------------------------------
// Step 5–6 of the value pipeline
// ---------------------------------------------------------------------------

const floatSpec: ParamSpec = { key: 'glow', label: 'Glow', group: 'A', type: 'float', default: 0.5, min: 0, max: 2 };
const intSpec: ParamSpec = { key: 'bars', label: 'Bars', group: 'A', type: 'int', default: 8, min: 2, max: 64 };
const boolSpec: ParamSpec = { key: 'on', label: 'On', group: 'A', type: 'bool', default: false };
const enumSpec: ParamSpec = {
  key: 'mode', label: 'Mode', group: 'A', type: 'enum', default: 'linear',
  options: [{ value: 'linear', label: 'Linear' }, { value: 'radial', label: 'Radial' }, { value: 'mirrored', label: 'Mirrored' }],
};

describe('value resolution: clamp once, at the end (module-spec §5)', () => {
  it('lets an intermediate value exceed the range and clamps only the result', () => {
    // base 1.5 is inside 0..2; ×2 would be 3 and is clamped to 2 — not clamped early to 2
    // and then multiplied, which would have given 4 → 2 by a different route.
    const { values } = resolveParams([floatSpec], { glow: 1.5 }, { modulate: (_k, base) => base * 2 });
    expect(values['glow']).toBe(2);
  });

  it('modulates an out-of-range stored value from its stored position', () => {
    const { values } = resolveParams([floatSpec], { glow: 5 }, { modulate: (_k, base) => base - 4 });
    expect(values['glow']).toBe(1);
  });

  it('is unchanged when nothing modulates it', () => {
    expect(resolveParams([floatSpec], { glow: 9 }).values['glow']).toBe(2);
    expect(resolveParams([intSpec], { bars: 7.6 }).values['bars']).toBe(8);
  });

  it('rounds an int after modulating and clamping', () => {
    const { values } = resolveParams([intSpec], { bars: 10 }, { modulate: (_k, base) => base + 0.4 });
    expect(values['bars']).toBe(10);
    expect(resolveParams([intSpec], { bars: 10 }, { modulate: (_k, base) => base + 0.6 }).values['bars']).toBe(11);
  });

  it('thresholds a bool at 0.5 (D25)', () => {
    expect(resolveParams([boolSpec], { on: false }, { modulate: () => 0.49 }).values['on']).toBe(false);
    expect(resolveParams([boolSpec], { on: false }, { modulate: () => 0.5 }).values['on']).toBe(true);
  });

  it('modulates an enum by option index, clamped to the list', () => {
    expect(resolveParams([enumSpec], { mode: 'linear' }, { modulate: (_k, base) => base + 1 }).values['mode']).toBe('radial');
    expect(resolveParams([enumSpec], { mode: 'linear' }, { modulate: () => 99 }).values['mode']).toBe('mirrored');
  });

  it('reports rather than guessing when a parameter has no numeric axis', () => {
    const colorSpec: ParamSpec = { key: 'tint', label: 'Tint', group: 'A', type: 'color', default: '#ffffff' };
    const { values, issues } = resolveParams([colorSpec], { tint: '#ff0000' }, { modulate: () => 1 });
    expect(values['tint']).toBe('#ff0000');
    expect(issues[0]?.detail).toContain('no numeric axis');
  });

  it('reports a binding on a parameter declared non-modulatable', () => {
    const fixed: ParamSpec = { ...floatSpec, modulatable: false };
    const { values, issues } = resolveParams([fixed], { glow: 1 }, { modulate: () => 2 });
    expect(values['glow']).toBe(1);
    expect(issues[0]?.detail).toContain('non-modulatable');
  });

  it('only calls the evaluator for keys that carry a binding', () => {
    const called: string[] = [];
    resolveParams([floatSpec, intSpec], {}, {
      modulated: new Set(['glow']),
      modulate: (key, base) => {
        called.push(key);
        return base;
      },
    });
    expect(called).toEqual(['glow']);
  });
});

describe("binding levels (the studio's meters, M13)", () => {
  it("reports each enabled binding's shaped signal, before amount and invert", () => {
    const lfo = binding({ id: 'L', source: source({ type: 'lfo', shape: 'saw', rateHz: 1 }), inputRange: 'auto', amount: 5, invert: true });
    const off = binding({ id: 'OFF', enabled: false });
    const levels = bindingLevels(compile([lfo, off]), 0.25);
    // Saw at 1 Hz, a quarter of the way through a cycle; amount and invert do not touch the level.
    expect(levels.get('L')).toBeCloseTo(0.25);
    expect(levels.has('OFF')).toBe(false);
  });

  it('leaves out a binding that could not be compiled, which the issues list reports instead', () => {
    const missing = binding({ id: 'M', source: source({ stem: 'drums' }) });
    const program = compile([missing]);
    expect(bindingLevels(program, 1).has('M')).toBe(false);
    expect(program.issues.map((i) => i.bindingId)).toEqual(['M']);
  });
});

describe('audio sources follow the clip, not the timeline (PROJECT.md §8.10)', () => {
  // A band silent for the first second of the file and loud after it.
  const step = [...new Array<number>(ANALYSIS_RATE).fill(0), ...new Array<number>(ANALYSIS_RATE * 4).fill(1)];
  // One second of lead-in; the clip starts half a second into the file and ends at 2 s.
  const placement = { leadInTicks: 48_000, clipInTicks: 24_000, clipOutTicks: 96_000 };
  const program = compileModulation({ bindings: [binding()], analysis: analysisWith(step), durationSeconds: DURATION, seed: 7, placement });

  it('reads the source at the mapped time', () => {
    // Timeline 1.2 s is 0.7 s into the file: still the silent part. 1.8 s is 1.3 s in: loud.
    expect(modulateValue(program, TARGET, 0, 1.2)).toBeCloseTo(0);
    expect(modulateValue(program, TARGET, 0, 1.8)).toBeCloseTo(1);
  });

  it('is silent in the lead-in and after the clip ends, whatever the file holds there', () => {
    expect(modulateValue(program, TARGET, 0, 0.5)).toBe(0);
    // Timeline 2.6 s would be 2.1 s into the file — loud there, but past the clip's out-point.
    expect(modulateValue(program, TARGET, 0, 2.6)).toBe(0);
  });
});

describe("the curve source (the auto-director's arrangement, standing in for keyframes)", () => {
  const S = 48_000;
  const points = [{ ticks: 1 * S, value: 0.2 }, { ticks: 2 * S, value: 1 }, { ticks: 3 * S, value: 0 }];

  it('is linear between points and flat outside them', () => {
    expect(sampleCurve(points, 0)).toBe(0.2);
    expect(sampleCurve(points, 1.5)).toBeCloseTo(0.6, 9);
    expect(sampleCurve(points, 2.5)).toBeCloseTo(0.5, 9);
    expect(sampleCurve(points, 3.9)).toBe(0);
    expect(sampleCurve([], 1)).toBe(0);
  });

  it('a step (two points on one tick) jumps rather than dividing by zero', () => {
    const step = [{ ticks: S, value: 0 }, { ticks: S, value: 1 }, { ticks: 2 * S, value: 1 }];
    expect(sampleCurve(step, 0.999)).toBe(0);
    expect(sampleCurve(step, 1.5)).toBe(1);
  });

  it('drives a binding without any analysis, and inputRange auto leaves it alone', () => {
    const program = compile([binding({ source: source({ type: 'curve', points }), inputRange: 'auto' })], EMPTY_ANALYSIS);
    expect(program.issues).toEqual([]);
    expect(modulateValue(program, TARGET, 0, 1.5)).toBeCloseTo(0.6, 6);
  });

  it('a curve with no points is reported and kept, not guessed at', () => {
    const program = compile([binding({ source: source({ type: 'curve', points: [] }) })], EMPTY_ANALYSIS);
    expect(program.issues.map((i) => i.bindingId)).toEqual(['B1']);
    expect(modulateValue(program, TARGET, 0.3, 1)).toBe(0.3);
  });
});

describe('marker sources (S9)', () => {
  const S = 48_000;
  const markers = [S, 3 * S];

  it('marker: a hit at each marker that falls to nothing in a quarter second', () => {
    expect(markerPulse(markers, 0.5)).toBe(0);
    expect(markerPulse(markers, 1)).toBe(1);
    expect(markerPulse(markers, 1.125)).toBeCloseTo(0.5, 9);
    expect(markerPulse(markers, 2)).toBe(0);
    expect(markerPulse(markers, 3)).toBe(1);
  });

  it('markerProgress: 0 to 1 across each scene, from the start and to the end', () => {
    expect(markerProgress(markers, 0.5, 4)).toBeCloseTo(0.5, 9);
    expect(markerProgress(markers, 1, 4)).toBe(0);
    expect(markerProgress(markers, 2, 4)).toBeCloseTo(0.5, 9);
    expect(markerProgress(markers, 3.5, 4)).toBeCloseTo(0.5, 9);
  });

  it('drives a binding, and says so when the project has no markers', () => {
    const b = binding({ source: source({ type: 'marker' }) });
    const program = compileModulation({ bindings: [b], analysis: EMPTY_ANALYSIS, durationSeconds: DURATION, seed: 7, markers });
    expect(program.issues).toEqual([]);
    expect(bindingLevels(program, 1).get('B1')).toBeCloseTo(1, 6);
    expect(bindingLevels(program, 2).get('B1')).toBeCloseTo(0, 6);
    const none = compileModulation({ bindings: [b], analysis: EMPTY_ANALYSIS, durationSeconds: DURATION, seed: 7 });
    expect(none.issues[0]?.detail).toMatch(/markers/);
  });
});
