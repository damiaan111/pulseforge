import { describe, expect, it } from 'vitest';
import {
  TONEMAP_KNEE,
  linearToSrgb,
  parseHexColor,
  srgbToLinear,
  tonemap,
  tonemapScalar,
  toLinearPremultiplied,
} from '../../src/engine/core/color.ts';
import { resolveParams, type ParamSpec } from '../../src/engine/core/params.ts';
import { createPrng, hash32, mix32, random01 } from '../../src/engine/core/prng.ts';

describe('prng', () => {
  it('is pinned: these exact values are part of every project\'s appearance', () => {
    // If this fails, the hash changed and every seeded project renders differently.
    // Only update these values as a deliberate, documented decision.
    expect(mix32(0)).toBe(0);
    expect(mix32(1)).toBe(0x514e28b7);
    expect([hash32(1337), hash32(1337, 'layer-a', 0), hash32(0, 1), hash32(42, 'x', 'y')]).toMatchSnapshot();
  });

  it('is a pure function of seed and keys', () => {
    expect(hash32(7, 'layer', 3)).toBe(hash32(7, 'layer', 3));
    expect(random01(7, 'layer', 3)).toBe(createPrng(7)('layer', 3));
  });

  it('separates seeds, key order and key types', () => {
    const values = new Set([
      hash32(1, 'a', 'b'),
      hash32(1, 'b', 'a'),
      hash32(2, 'a', 'b'),
      hash32(1, '1'),
      hash32(1, 1),
      hash32(1),
      hash32(1, 2 ** 32),
      hash32(1, 0),
    ]);
    expect(values.size).toBe(8);
  });

  it('is roughly uniform in [0, 1)', () => {
    const buckets = new Array<number>(10).fill(0);
    for (let i = 0; i < 100_000; i++) {
      const v = random01(99, i);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      buckets[Math.floor(v * 10)]!++;
    }
    for (const count of buckets) expect(Math.abs(count - 10_000)).toBeLessThan(500);
  });

  it('rejects non-integer numeric keys', () => {
    expect(() => hash32(1, 0.5)).toThrow(RangeError);
  });
});

describe('color', () => {
  it('round-trips sRGB and linear', () => {
    for (const v of [0, 0.02, 0.2, 0.5, 0.8, 1]) expect(linearToSrgb(srgbToLinear(v))).toBeCloseTo(v, 12);
    expect(srgbToLinear(0.5)).toBeCloseTo(0.214041, 6);
  });

  it('parses hex colours and premultiplies in linear light', () => {
    expect(parseHexColor('#ff2d95')).toEqual({ r: 1, g: 45 / 255, b: 149 / 255, a: 1 });
    expect(parseHexColor('#fff')).toEqual({ r: 1, g: 1, b: 1, a: 1 });
    expect(parseHexColor('ff2d95')).toBeUndefined();
    const half = toLinearPremultiplied({ r: 1, g: 0.5, b: 0, a: 0.5 });
    expect(half.r).toBe(0.5);
    expect(half.g).toBeCloseTo(srgbToLinear(0.5) * 0.5, 12);
  });

  it('leaves colours below the knee untouched', () => {
    expect(tonemap(0.9, 0.2, 0.5)).toEqual([0.9, 0.2, 0.5]);
    expect(tonemapScalar(0.3)).toBe(0.3);
  });

  it('rolls highlights off below 1.0, monotonically, preserving hue ratios', () => {
    let previous = 0;
    for (let x = 0; x <= 20; x += 0.05) {
      const y = tonemapScalar(x);
      expect(y).toBeGreaterThanOrEqual(previous);
      expect(y).toBeLessThanOrEqual(1); // asymptotic; reaches 1.0 in float64 only far past white
      previous = y;
    }
    expect(tonemapScalar(4)).toBeLessThan(1);
    expect(tonemapScalar(1)).toBeCloseTo(TONEMAP_KNEE + (1 - TONEMAP_KNEE) * (1 - Math.exp(-1)), 12);
    const [r, g, b] = tonemap(4, 2, 1);
    expect(r / g).toBeCloseTo(2, 12);
    expect(g / b).toBeCloseTo(2, 12);
  });
});

describe('resolveParams', () => {
  const schema: ParamSpec[] = [
    { key: 'count', label: 'Count', group: 'g', type: 'int', default: 64, min: 8, max: 256 },
    { key: 'width', label: 'Width', group: 'g', type: 'float', default: 0.7, min: 0.05, max: 1 },
    { key: 'mode', label: 'Mode', group: 'g', type: 'enum', default: 'linear', options: [{ value: 'linear', label: 'Linear' }, { value: 'radial', label: 'Radial' }] },
    { key: 'fill', label: 'Fill', group: 'g', type: 'color', default: '#ff2d95' },
    { key: 'source', label: 'Source', group: 'g', type: 'select:stem', default: 'mix' },
  ];

  it('uses defaults for missing values', () => {
    expect(resolveParams(schema, {}).values).toEqual({ count: 64, width: 0.7, mode: 'linear', fill: '#ff2d95', source: 'mix' });
  });

  it('clamps, then rounds ints', () => {
    const { values, issues } = resolveParams(schema, { count: 300.4, width: -2 });
    expect(values['count']).toBe(256);
    expect(values['width']).toBe(0.05);
    expect(issues).toEqual([]);
    expect(resolveParams(schema, { count: 10.5 }).values['count']).toBe(11);
  });

  it('reports wrong types and invalid values instead of hiding them', () => {
    const { values, issues } = resolveParams(schema, { count: '12', mode: 'spiral', fill: '#zzz', source: 'kazoo' });
    expect(values).toMatchObject({ count: 64, mode: 'linear', fill: '#ff2d95', source: 'mix' });
    expect(issues.map((i) => [i.key, i.problem])).toEqual([
      ['count', 'wrong-type'],
      ['mode', 'invalid-value'],
      ['fill', 'invalid-value'],
      ['source', 'invalid-value'],
    ]);
  });

  it('preserves and reports unknown keys (never silently dropped)', () => {
    const { unknown, issues } = resolveParams(schema, { futureParam: { nested: true } });
    expect(unknown).toEqual({ futureParam: { nested: true } });
    expect(issues).toEqual([expect.objectContaining({ key: 'futureParam', problem: 'unknown-key' })]);
  });
});
