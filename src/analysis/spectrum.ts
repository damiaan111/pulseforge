// Mix/stem analysis → fixed-rate feature tracks (PROJECT.md §8.1, data-formats §4).
// P0 subset: log-spaced spectrum bins and named band energies.
//
// Levels are expressed as sine-equivalent amplitude in dBFS and mapped linearly from
// floorDb..0 dB to 0..1, so a full-scale sine inside a band reads 1.0 and silence 0.

import { ANALYSIS_RATE, type AnalysisTrack, type SourceAnalysis } from '../engine/core/analysis.ts';
import { createFft, hannWindow } from './fft.ts';

/** Part of the cache key (data-formats §4.3): bump whenever results change. */
export const ANALYSIS_VERSION = 1;
export const ANALYSIS_SAMPLE_RATE = 48_000;

export interface BandDefinition {
  readonly name: string;
  readonly minHz: number;
  readonly maxHz: number;
}

export interface SpectrumSettings {
  readonly fftSize: number;
  readonly bins: number;
  readonly minHz: number;
  readonly maxHz: number;
  readonly floorDb: number;
  readonly bands: readonly BandDefinition[];
}

export const DEFAULT_SPECTRUM_SETTINGS: SpectrumSettings = {
  fftSize: 2048,
  bins: 64,
  minHz: 30,
  maxHz: 16_000,
  floorDb: -72,
  bands: [{ name: 'bass', minHz: 40, maxHz: 160 }],
};

/** Frames at 240 Hz; frame k is centred on sample k · 200. */
export function analysisFrameCount(sampleCount: number): number {
  const hop = ANALYSIS_SAMPLE_RATE / ANALYSIS_RATE;
  return sampleCount === 0 ? 0 : Math.floor((sampleCount - 1) / hop) + 1;
}

function toUnit(amplitude: number, floorDb: number): number {
  if (!(amplitude > 0)) return 0;
  const db = 20 * Math.log10(amplitude);
  return Math.min(1, Math.max(0, (db - floorDb) / -floorDb));
}

export function computeSourceAnalysis(pcm: Float32Array, settings: SpectrumSettings = DEFAULT_SPECTRUM_SETTINGS): SourceAnalysis {
  const { fftSize, bins, minHz, maxHz, floorDb } = settings;
  const hop = ANALYSIS_SAMPLE_RATE / ANALYSIS_RATE;
  const frames = analysisFrameCount(pcm.length);
  const fft = createFft(fftSize);
  const window = hannWindow(fftSize);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  const power = new Float64Array(fftSize / 2);
  const binHz = ANALYSIS_SAMPLE_RATE / fftSize;

  // Log-spaced bin edges, mapped to FFT bin index ranges once.
  const ranges: Array<{ lo: number; hi: number; centre: number }> = [];
  for (let b = 0; b < bins; b++) {
    const f0 = minHz * (maxHz / minHz) ** (b / bins);
    const f1 = minHz * (maxHz / minHz) ** ((b + 1) / bins);
    ranges.push({ lo: Math.ceil(f0 / binHz), hi: Math.floor(f1 / binHz), centre: Math.sqrt(f0 * f1) / binHz });
  }
  const bandRanges = settings.bands.map((band) => ({
    lo: Math.max(1, Math.round(band.minHz / binHz)),
    hi: Math.min(fftSize / 2 - 1, Math.round(band.maxHz / binHz)),
  }));

  const spectrum = new Float32Array(frames * bins);
  const bandData = settings.bands.map(() => new Float32Array(frames));
  // A windowed sine of amplitude A peaks at |X| = A·N/4; its positive-half power sums to 3A²N²/32.
  const peakToAmplitude = 4 / fftSize;
  const powerToAmplitude = 32 / (3 * fftSize * fftSize);

  for (let k = 0; k < frames; k++) {
    const centre = k * hop;
    for (let n = 0; n < fftSize; n++) {
      const index = centre - fftSize / 2 + n;
      const sample = index >= 0 && index < pcm.length ? (pcm[index] ?? 0) : 0;
      re[n] = sample * (window[n] ?? 0);
      im[n] = 0;
    }
    fft.transform(re, im);
    for (let i = 0; i < fftSize / 2; i++) {
      const r = re[i] ?? 0;
      const m = im[i] ?? 0;
      power[i] = r * r + m * m;
    }

    for (let b = 0; b < bins; b++) {
      const range = ranges[b];
      if (range === undefined) continue;
      let peak = 0;
      if (range.hi >= range.lo) {
        for (let i = range.lo; i <= range.hi; i++) peak = Math.max(peak, power[i] ?? 0);
      } else {
        // Narrower than one FFT bin (the low end): interpolate at the log-centre frequency.
        const x = Math.min(fftSize / 2 - 1, range.centre);
        const i0 = Math.floor(x);
        const i1 = Math.min(fftSize / 2 - 1, i0 + 1);
        const p0 = Math.sqrt(power[i0] ?? 0);
        const p1 = Math.sqrt(power[i1] ?? 0);
        peak = (p0 + (p1 - p0) * (x - i0)) ** 2;
      }
      spectrum[k * bins + b] = toUnit(Math.sqrt(peak) * peakToAmplitude, floorDb);
    }

    bandRanges.forEach((range, index) => {
      let sum = 0;
      for (let i = range.lo; i <= range.hi; i++) sum += power[i] ?? 0;
      const data = bandData[index];
      if (data !== undefined) data[k] = toUnit(Math.sqrt(sum * powerToAmplitude), floorDb);
    });
  }

  const bands = new Map<string, AnalysisTrack>();
  settings.bands.forEach((band, index) => {
    const data = bandData[index];
    if (data !== undefined) bands.set(band.name, { rate: ANALYSIS_RATE, channels: 1, data });
  });
  return { spectrum: { rate: ANALYSIS_RATE, channels: bins, data: spectrum }, bands };
}
