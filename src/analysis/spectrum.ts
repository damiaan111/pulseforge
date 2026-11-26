// Mix/stem analysis → fixed-rate feature tracks (PROJECT.md §8.1, data-formats §4).
// P0 subset: log-spaced spectrum bins and named band energies.
//
// Levels are expressed as sine-equivalent amplitude in dBFS and mapped linearly from
// floorDb..0 dB to 0..1, so a full-scale sine inside a band reads 1.0 and silence 0.

import { ANALYSIS_RATE, type AnalysisTrack, type SourceAnalysis } from '../engine/core/analysis.ts';
import {
  detectOnsets, levelToUnit, spectralCentroid, spectralFlux, stereoWidth, windowedPeak, windowedRms,
} from './features.ts';
import { createFft, hannWindow } from './fft.ts';

/**
 * Part of the cache key (data-formats §4.3): bump whenever results change, or a stale cache
 * survives a bug fix and produces "it's still doing the old thing" for an afternoon.
 * v2 adds the scalar feature tracks (rms, peak, onset, centroid, flux, stereoWidth).
 * v4: the beat grid's period is fitted to the onsets, not rounded to a whole frame.
 */
export const ANALYSIS_VERSION = 4;
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

/**
 * The seven bands every project starts with (data-formats §1, `analysisSettings.bands`). One list,
 * used both as the analyser's default and as a new document's default, so a binding on "bass" in
 * a fresh project reads exactly the band the analyser computed under that name.
 */
export const STANDARD_BANDS: readonly (BandDefinition & { readonly label: string })[] = [
  { name: 'sub', label: 'Sub', minHz: 20, maxHz: 60 },
  { name: 'bass', label: 'Bass', minHz: 60, maxHz: 250 },
  { name: 'lowMid', label: 'Low mid', minHz: 250, maxHz: 500 },
  { name: 'mid', label: 'Mid', minHz: 500, maxHz: 2000 },
  { name: 'highMid', label: 'High mid', minHz: 2000, maxHz: 4000 },
  { name: 'presence', label: 'Presence', minHz: 4000, maxHz: 6000 },
  { name: 'brilliance', label: 'Brilliance', minHz: 6000, maxHz: 20_000 },
];

export const DEFAULT_SPECTRUM_SETTINGS: SpectrumSettings = {
  fftSize: 2048,
  bins: 64,
  minHz: 30,
  maxHz: 16_000,
  floorDb: -72,
  bands: STANDARD_BANDS.map(({ name, minHz, maxHz }) => ({ name, minHz, maxHz })),
};

export interface AnalysedSource extends SourceAnalysis {
  /**
   * Detected onset times in seconds. Not a track and not cached as one — it is the input to
   * tempo detection, which runs once over the whole source.
   */
  readonly onsetTimes: readonly number[];
}

export interface SourceOptions {
  /** The right channel, when a stereo decode is available. Enables the `stereoWidth` feature. */
  readonly right?: Float32Array;
  /** 0..1, from `analysisSettings.onsetSensitivity`. */
  readonly onsetSensitivity?: number;
}

/** Frames at 240 Hz; frame k is centred on sample k · 200. */
export function analysisFrameCount(sampleCount: number): number {
  const hop = ANALYSIS_SAMPLE_RATE / ANALYSIS_RATE;
  return sampleCount === 0 ? 0 : Math.floor((sampleCount - 1) / hop) + 1;
}

export function computeSourceAnalysis(
  pcm: Float32Array,
  settings: SpectrumSettings = DEFAULT_SPECTRUM_SETTINGS,
  options: SourceOptions = {},
): AnalysedSource {
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
  // Scalar features share this one STFT pass: computing them separately would double the cost
  // of the slowest part of analysis for no benefit.
  const rms = new Float32Array(frames);
  const peakTrack = new Float32Array(frames);
  const centroid = new Float32Array(frames);
  const flux = new Float32Array(frames);
  const width = options.right === undefined ? undefined : new Float32Array(frames);
  const magnitude = new Float64Array(fftSize / 2);
  const previousMagnitude = new Float64Array(fftSize / 2);
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
      magnitude[i] = Math.sqrt(power[i] as number);
    }

    // Levels: RMS over the analysis window (smooth), peak over one hop (fast enough to catch a
    // transient the RMS window would average away).
    rms[k] = levelToUnit(windowedRms(pcm, centre, fftSize), floorDb);
    peakTrack[k] = levelToUnit(windowedPeak(pcm, centre, hop * 2), floorDb);
    centroid[k] = spectralCentroid(power, binHz, minHz, maxHz);
    // Flux is a sum of magnitude *rises* across bins; scaling it per bin and through the same
    // dBFS mapping as the levels keeps every source on one comparable 0..1 scale.
    flux[k] = k === 0
      ? 0
      : levelToUnit((spectralFlux(magnitude, previousMagnitude) * peakToAmplitude) / Math.sqrt(fftSize / 2), floorDb);
    previousMagnitude.set(magnitude);
    if (width !== undefined && options.right !== undefined) {
      width[k] = stereoWidth(pcm, options.right, centre, fftSize);
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
      spectrum[k * bins + b] = levelToUnit(Math.sqrt(peak) * peakToAmplitude, floorDb);
    }

    bandRanges.forEach((range, index) => {
      let sum = 0;
      for (let i = range.lo; i <= range.hi; i++) sum += power[i] ?? 0;
      const data = bandData[index];
      if (data !== undefined) data[k] = levelToUnit(Math.sqrt(sum * powerToAmplitude), floorDb);
    });
  }

  const bands = new Map<string, AnalysisTrack>();
  settings.bands.forEach((band, index) => {
    const data = bandData[index];
    if (data !== undefined) bands.set(band.name, { rate: ANALYSIS_RATE, channels: 1, data });
  });

  const track = (data: Float32Array): AnalysisTrack => ({ rate: ANALYSIS_RATE, channels: 1, data });
  const onsets = detectOnsets(flux, { rate: ANALYSIS_RATE, sensitivity: options.onsetSensitivity ?? 0.5 });
  const features = new Map<string, AnalysisTrack>([
    ['rms', track(rms)],
    ['peak', track(peakTrack)],
    ['centroid', track(centroid)],
    ['flux', track(flux)],
    ['onset', track(onsets.strength)],
  ]);
  // Absent, not zero: a binding on stereo width with a mono decode must be reported, not
  // silently read as "perfectly mono".
  if (width !== undefined) features.set('stereoWidth', track(width));

  return { spectrum: { rate: ANALYSIS_RATE, channels: bins, data: spectrum }, bands, features, onsetTimes: onsets.times };
}
