import { describe, expect, it } from 'vitest';

import {
  BASE_BUCKET_SAMPLES,
  buildPeakPyramid,
  decodePeaks,
  encodePeaks,
  peaksForRange,
} from '../../src/analysis/peaks.ts';

const RATE = 48_000;

/** One second of a full-scale sine — symmetric, so min and max should mirror. */
function sine(seconds = 1, amplitude = 1): Float32Array {
  const data = new Float32Array(RATE * seconds);
  for (let i = 0; i < data.length; i += 1) data[i] = Math.sin((i / RATE) * 440 * Math.PI * 2) * amplitude;
  return data;
}

describe('buildPeakPyramid', () => {
  it('halves until a single bucket covers the track', () => {
    const pyramid = buildPeakPyramid(sine(), RATE);
    expect(pyramid.levels[0]!.bucketSamples).toBe(BASE_BUCKET_SAMPLES);
    expect(pyramid.levels.at(-1)!.data.length / 2).toBe(1);
    for (let i = 1; i < pyramid.levels.length; i += 1) {
      expect(pyramid.levels[i]!.bucketSamples).toBe(pyramid.levels[i - 1]!.bucketSamples * 2);
    }
  });

  it('keeps min and max rather than an average', () => {
    const pyramid = buildPeakPyramid(sine(), RATE);
    const top = pyramid.levels.at(-1)!;
    // A full-scale sine reaches ±1; an averaging pyramid would have collapsed towards zero.
    expect(top.data[0]).toBeLessThan(-0.99);
    expect(top.data[1]).toBeGreaterThan(0.99);
  });

  it('preserves asymmetry, which an absolute-peak pyramid would lose', () => {
    const data = new Float32Array(RATE);
    data.fill(0.2);
    data[100] = 0.9; // a loud positive spike, nothing negative
    const pyramid = buildPeakPyramid(data, RATE);
    const top = pyramid.levels.at(-1)!;
    expect(top.data[1]).toBeCloseTo(0.9, 5);
    expect(top.data[0]).toBeCloseTo(0.2, 5);
  });

  it('handles audio shorter than one bucket', () => {
    const pyramid = buildPeakPyramid(Float32Array.from([0.5, -0.25]), RATE);
    expect(pyramid.levels).toHaveLength(1);
    expect(pyramid.levels[0]!.data[0]).toBeCloseTo(-0.25, 6);
    expect(pyramid.levels[0]!.data[1]).toBeCloseTo(0.5, 6);
  });

  it('handles empty audio without throwing', () => {
    const pyramid = buildPeakPyramid(new Float32Array(0), RATE);
    expect(pyramid.sampleCount).toBe(0);
    expect(peaksForRange(pyramid, 0, 1, 10).max.every((value) => value === 0)).toBe(true);
  });
});

describe('peaksForRange', () => {
  it('fills exactly the columns asked for', () => {
    const pyramid = buildPeakPyramid(sine(2), RATE);
    const window = peaksForRange(pyramid, 0, 2, 700);
    expect(window.min).toHaveLength(700);
    expect(window.max).toHaveLength(700);
    expect(window.max.every((value) => value > 0.9)).toBe(true);
    expect(window.min.every((value) => value < -0.9)).toBe(true);
  });

  it('reads a coarser level when zoomed out and the finest when zoomed in', () => {
    const pyramid = buildPeakPyramid(sine(4), RATE);
    // Whole track in 100 columns vs 20 ms in 100 columns: same call, wildly different work.
    const wide = peaksForRange(pyramid, 0, 4, 100);
    const tight = peaksForRange(pyramid, 1, 1.02, 100);
    expect(wide.max.every((value) => value > 0.9)).toBe(true);
    // A 20 ms window of a 440 Hz sine still contains whole cycles, so it reaches full scale.
    expect(Math.max(...tight.max)).toBeGreaterThan(0.9);
  });

  it('is stable across zoom levels — the envelope keeps its shape', () => {
    // Quiet first half, loud second half. At any zoom the halves must stay distinguishable.
    const data = new Float32Array(RATE * 2);
    for (let i = 0; i < data.length; i += 1) {
      const loud = i >= RATE;
      data[i] = Math.sin((i / RATE) * 440 * Math.PI * 2) * (loud ? 1 : 0.1);
    }
    const pyramid = buildPeakPyramid(data, RATE);
    for (const columns of [16, 64, 256, 1024]) {
      const window = peaksForRange(pyramid, 0, 2, columns);
      const quiet = window.max[Math.floor(columns * 0.25)]!;
      const loud = window.max[Math.floor(columns * 0.75)]!;
      expect(quiet).toBeLessThan(0.2);
      expect(loud).toBeGreaterThan(0.9);
    }
  });

  it('draws silence past the end of the audio rather than running off the array', () => {
    const pyramid = buildPeakPyramid(sine(1), RATE);
    const window = peaksForRange(pyramid, 0, 2, 100);
    expect(window.max[10]).toBeGreaterThan(0.9); // inside the audio
    expect(window.max[90]).toBe(0); // past the end
    expect(window.min[90]).toBe(0);
  });

  it('returns zeros for an empty or inverted range', () => {
    const pyramid = buildPeakPyramid(sine(1), RATE);
    expect(peaksForRange(pyramid, 1, 1, 10).max.every((v) => v === 0)).toBe(true);
    expect(peaksForRange(pyramid, 2, 1, 10).max.every((v) => v === 0)).toBe(true);
    expect(() => peaksForRange(pyramid, 0, 1, 0)).toThrow(RangeError);
  });

  it('a negative start clamps instead of reading before the audio', () => {
    const pyramid = buildPeakPyramid(sine(1), RATE);
    const window = peaksForRange(pyramid, -0.5, 0.5, 50);
    expect(window.max.some((value) => value > 0.9)).toBe(true);
  });
});

describe('peaks serialisation', () => {
  it('round-trips exactly', () => {
    const pyramid = buildPeakPyramid(sine(3), RATE);
    const decoded = decodePeaks(encodePeaks(pyramid));
    expect(decoded.sampleRate).toBe(pyramid.sampleRate);
    expect(decoded.sampleCount).toBe(pyramid.sampleCount);
    expect(decoded.levels).toHaveLength(pyramid.levels.length);
    for (let i = 0; i < pyramid.levels.length; i += 1) {
      expect(decoded.levels[i]!.bucketSamples).toBe(pyramid.levels[i]!.bucketSamples);
      expect(decoded.levels[i]!.data).toEqual(pyramid.levels[i]!.data);
    }
  });

  it('is far smaller than the audio it describes', () => {
    const audio = sine(60);
    const bytes = encodePeaks(buildPeakPyramid(audio, RATE));
    // ~2 floats per 256 samples plus a geometric tail: well under 2% of the PCM.
    expect(bytes.byteLength).toBeLessThan(audio.byteLength * 0.02);
  });

  it('refuses a file from another format version rather than misreading it', () => {
    const bytes = encodePeaks(buildPeakPyramid(sine(1), RATE));
    const jsonLength = new DataView(bytes.buffer).getUint32(0, true);
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + jsonLength))) as Record<string, unknown>;
    const rewritten = JSON.stringify({ ...header, formatVersion: 99 });
    expect(rewritten.length).toBe(jsonLength + 1); // 1 → 99, so the header grew by one byte
    const forged = new Uint8Array(bytes.length + 1);
    new DataView(forged.buffer).setUint32(0, rewritten.length, true);
    forged.set(new TextEncoder().encode(rewritten), 4);
    expect(() => decodePeaks(forged)).toThrow(/format 99/);
  });

  it('rejects a truncated file', () => {
    expect(() => decodePeaks(new Uint8Array(4))).toThrow(/too short/);
  });
});
