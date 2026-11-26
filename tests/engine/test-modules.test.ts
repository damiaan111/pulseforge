import { describe, expect, it } from 'vitest';
import { flashLit } from '../../src/engine/modules/flash.ts';
import { TEST_PATTERN_COLORS, TEST_PATTERN_COLUMNS, TEST_PATTERN_ROWS } from '../../src/engine/modules/test-pattern.ts';
import { parseHexColor } from '../../src/engine/core/color.ts';
import { expectedEncoded } from '../../spike/validate/checks-render.ts';
import { clickTimes, CLICK_SCHEDULE } from '../../spike/validate/projects.ts';

describe('core.test.flash schedule', () => {
  it('is dark before the first flash and lit for the duration of each period', () => {
    expect(flashLit(0.99, 1, 0.5, 0.05)).toBe(false);
    expect(flashLit(1.0, 1, 0.5, 0.05)).toBe(true);
    expect(flashLit(1.049, 1, 0.5, 0.05)).toBe(true);
    expect(flashLit(1.05, 1, 0.5, 0.05)).toBe(false);
    expect(flashLit(1.5, 1, 0.5, 0.05)).toBe(true);
  });

  it('puts validation clicks between frames so rounding is exercised', () => {
    const times = clickTimes(3);
    expect(times[0]).toBeCloseTo(CLICK_SCHEDULE.first, 6);
    expect(Number.isInteger(times[0]! * 60)).toBe(false);
  });
});

describe('core.test.pattern', () => {
  it('has exactly one valid colour per patch', () => {
    expect(TEST_PATTERN_COLORS).toHaveLength(TEST_PATTERN_COLUMNS * TEST_PATTERN_ROWS);
    for (const hex of TEST_PATTERN_COLORS) expect(parseHexColor(hex)).toBeDefined();
  });

  it('expects colours below the tone knee to encode as authored', () => {
    const [r, g, b] = expectedEncoded('#808080');
    expect(r * 255).toBeCloseTo(128, 6);
    expect(g).toBe(r);
    expect(b).toBe(r);
    expect(expectedEncoded('#000000')).toEqual([0, 0, 0]);
  });

  it('expects saturated channels above the knee to be compressed slightly (D48)', () => {
    const [white] = expectedEncoded('#ffffff');
    expect(white * 255).toBeLessThan(255);
    expect(white * 255).toBeGreaterThan(245);
  });
});
