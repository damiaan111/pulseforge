// Keyframe evaluation (S1, docs/keyframes-spec.md §4): holding outside the keys, easing within a
// segment by the left key's curve, interpolation by type, and determinism.

import { describe, expect, it } from 'vitest';

import { cubicBezier, ease, indexAutomation, sampleTrack, type AutomationKey } from '../../src/engine/core/automation.ts';

const S = 48_000;
const key = (seconds: number, value: AutomationKey['value'], easing: AutomationKey['easing'] = 'linear'): AutomationKey => ({ ticks: seconds * S, value, easing });

describe('easing', () => {
  it('starts at 0 and ends at 1 for every curve, and linear is the identity', () => {
    for (const e of ['linear', 'easeIn', 'easeOut', 'easeInOut', { cubic: [0.3, -0.5, 0.7, 1.5] }] as const) {
      expect(ease(e, 0)).toBeCloseTo(0, 9);
      expect(ease(e, 1)).toBeCloseTo(1, 9);
    }
    expect(ease('linear', 0.37)).toBe(0.37);
  });

  it('ease-in lags, ease-out leads, ease-in-out is symmetric', () => {
    expect(ease('easeIn', 0.5)).toBeLessThan(0.5);
    expect(ease('easeOut', 0.5)).toBeGreaterThan(0.5);
    expect(ease('easeInOut', 0.5)).toBeCloseTo(0.5, 9);
    expect(ease('easeInOut', 0.25) + ease('easeInOut', 0.75)).toBeCloseTo(1, 6);
  });

  it('a Bézier with its handles on the diagonal is linear, and overshoot is allowed', () => {
    expect(cubicBezier(1 / 3, 1 / 3, 2 / 3, 2 / 3, 0.3)).toBeCloseTo(0.3, 9);
    expect(ease({ cubic: [0.3, 0, 0.3, 1.6] }, 0.7)).toBeGreaterThan(1);
  });
});

describe('a track at time t', () => {
  const keys = [key(1, 10), key(3, 20, 'hold'), key(5, 0)];

  it('holds the first value before and the last value after', () => {
    expect(sampleTrack(keys, 0, 'number')).toBe(10);
    expect(sampleTrack(keys, 9, 'number')).toBe(0);
  });

  it('interpolates by the left key\'s easing, and hold waits for the next key', () => {
    expect(sampleTrack(keys, 2, 'number')).toBeCloseTo(15, 9);
    expect(sampleTrack(keys, 4.99, 'number')).toBe(20);
    expect(sampleTrack(keys, 5, 'number')).toBe(0);
  });

  it('colours ease in linear light: the midpoint of black and white is not #808080', () => {
    const mid = sampleTrack([key(0, '#000000'), key(2, '#ffffff')], 1, 'color');
    // Linear 0.5 in sRGB is about 188 (0xbc).
    expect(mid).toBe('#bcbcbc');
  });

  it('discrete values hold, whatever the easing', () => {
    const modes = [key(0, 'radial', 'easeInOut'), key(2, 'bars')];
    expect(sampleTrack(modes, 1.99, 'discrete')).toBe('radial');
    expect(sampleTrack(modes, 2, 'discrete')).toBe('bars');
    expect(sampleTrack([key(0, true), key(1, false)], 0.5, 'discrete')).toBe(true);
  });

  it('a single key is a constant, and no keys is nothing', () => {
    expect(sampleTrack([key(3, 7)], 0, 'number')).toBe(7);
    expect(sampleTrack([], 1, 'number')).toBeUndefined();
  });

  it('is a pure function of t: any order of evaluation gives the same values', () => {
    const times = Array.from({ length: 50 }, (_, i) => i * 0.13);
    const forwards = times.map((t) => sampleTrack(keys, t, 'number'));
    const backwards = [...times].reverse().map((t) => sampleTrack(keys, t, 'number')).reverse();
    expect(backwards).toEqual(forwards);
  });

  it('index skips empty tracks; the last track on a target wins', () => {
    const index = indexAutomation([
      { id: 'a', target: 'x', keyframes: [key(0, 1)] },
      { id: 'b', target: 'y', keyframes: [] },
      { id: 'c', target: 'x', keyframes: [key(0, 2)] },
    ]);
    expect([...index.keys()]).toEqual(['x']);
    expect(index.get('x')?.id).toBe('c');
  });
});
