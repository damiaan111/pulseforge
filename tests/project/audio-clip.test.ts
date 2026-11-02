// The audio clip's level: gain and fade curves (M29, PROJECT.md §8.10).

import { describe, expect, it } from 'vitest';

import { clipLevel, fadeShape, isUnity } from '../../src/project/audio-clip.ts';
import { FADE_CURVES } from '../../src/project/document.ts';

const flat = { gain: 1, fadeInTicks: 0, fadeOutTicks: 0, fadeInCurve: 'equal-power', fadeOutCurve: 'equal-power' } as const;

describe('fade shapes', () => {
  it.each(FADE_CURVES)('%s runs from silence to full level, and rises monotonically', (curve) => {
    expect(fadeShape(curve, 0)).toBe(0);
    expect(fadeShape(curve, 1)).toBeCloseTo(1);
    let previous = 0;
    for (let x = 0.01; x <= 1; x += 0.01) {
      const value = fadeShape(curve, x);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it('equal-power is louder than linear through the middle, as it should be', () => {
    expect(fadeShape('equal-power', 0.5)).toBeCloseTo(Math.SQRT1_2);
    expect(fadeShape('linear', 0.5)).toBe(0.5);
    expect(fadeShape('s-curve', 0.25)).toBeLessThan(0.25);
  });
});

describe('the clip level', () => {
  it('is the gain away from the fades', () => {
    expect(clipLevel({ ...flat, gain: 0.8 }, 500, 1000)).toBe(0.8);
  });

  it('fades in from the first sample and out to the last', () => {
    const level = { ...flat, fadeInTicks: 100, fadeOutTicks: 100, fadeInCurve: 'linear', fadeOutCurve: 'linear' } as const;
    expect(clipLevel(level, 0, 1000)).toBe(0);
    expect(clipLevel(level, 50, 1000)).toBeCloseTo(0.5);
    expect(clipLevel(level, 950, 1000)).toBeCloseTo(0.5);
    expect(clipLevel(level, 1000, 1000)).toBe(0);
  });

  it('lets overlapping fades rise and fall rather than jump', () => {
    const level = { ...flat, fadeInTicks: 800, fadeOutTicks: 800, fadeInCurve: 'linear', fadeOutCurve: 'linear' } as const;
    // A 1000-sample clip under two 800-sample fades peaks in the middle, below full level.
    const middle = clipLevel(level, 500, 1000);
    expect(middle).toBeCloseTo((500 / 800) * (500 / 800));
    expect(clipLevel(level, 400, 1000)).toBeLessThan(middle + 1e-9);
  });

  it('knows when there is nothing to apply', () => {
    expect(isUnity(flat)).toBe(true);
    expect(isUnity({ ...flat, gain: 0.9 })).toBe(false);
    expect(isUnity({ ...flat, fadeInTicks: 10 })).toBe(false);
  });
});
