// The top of the analysis pipeline: PCM in, a complete `AnalysisSet` out (M4).
//
// One entry point so the CLI, the app and the spikes all produce identical numbers from
// identical audio — which they must, because those numbers are what every render reacts to.
//
// Where the beat grid comes from matters and is a deliberate choice: **the drum stem when there
// is one, the mix otherwise.** Flux-based tempo detection on a full mix competes with bass
// notes, vocal attacks and reverb tails; on isolated drums it is a far easier problem
// (PROJECT.md §8.1). Stems are not wired in yet, so today it is the mix — but the decision is
// in the code rather than waiting to be remembered.

import { ANALYSIS_RATE, type AnalysisSet, type AnalysisTrack, type SourceAnalysis } from '../engine/core/analysis.ts';
import type { Stem } from '../engine/core/params.ts';
import { WAVEFORM_RATE } from '../engine/core/milkdrop.ts';
import { beatPulse, detectTempo, type BeatGrid } from './features.ts';
import {
  ANALYSIS_SAMPLE_RATE, DEFAULT_SPECTRUM_SETTINGS, analysisFrameCount, computeSourceAnalysis,
  type SpectrumSettings,
} from './spectrum.ts';

export interface AnalyzeOptions {
  readonly settings?: SpectrumSettings;
  /** 0..1, from `analysisSettings.onsetSensitivity`. */
  readonly onsetSensitivity?: number;
  /** From `analysisSettings.bpmOverride`: lays the grid out at this tempo instead of detecting. */
  readonly bpmOverride?: number | null;
  /** The right channel, when a stereo decode is available; enables `stereoWidth`. */
  readonly right?: Float32Array;
}

export interface AnalyzeResult {
  readonly analysis: AnalysisSet;
  readonly beatGrid: BeatGrid;
  /** Detected onsets in seconds — for the timeline's snap targets (ui-spec §3). */
  readonly onsetTimes: readonly number[];
}

/**
 * The song itself at `WAVEFORM_RATE`, for what wants real samples: MilkDrop draws its waveforms from
 * them and takes its own FFT. Every other track is a measurement of the audio; this is the audio.
 * Each output sample averages the inputs it covers, so the treble folds down gently.
 */
export function resampleWaveform(pcm: Float32Array): Float32Array {
  const ratio = ANALYSIS_SAMPLE_RATE / WAVEFORM_RATE;
  const out = new Float32Array(Math.floor((pcm.length * WAVEFORM_RATE) / ANALYSIS_SAMPLE_RATE));
  for (let i = 0; i < out.length; i += 1) {
    const from = Math.floor(i * ratio);
    const to = Math.max(from + 1, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = from; j < to; j += 1) sum += pcm[j] as number;
    out[i] = sum / (to - from);
  }
  return out;
}

/** Mono (or mono + right channel) PCM at 48 kHz → every track the modulation system can read. */
export function analyzeMix(pcm: Float32Array, options: AnalyzeOptions = {}): AnalyzeResult {
  const settings = options.settings ?? DEFAULT_SPECTRUM_SETTINGS;
  const source = computeSourceAnalysis(pcm, settings, {
    ...(options.right === undefined ? {} : { right: options.right }),
    ...(options.onsetSensitivity === undefined ? {} : { onsetSensitivity: options.onsetSensitivity }),
  });

  const frames = analysisFrameCount(pcm.length);
  const durationSeconds = pcm.length / ANALYSIS_SAMPLE_RATE;
  const onsetStrength = source.features.get('onset');
  const beatGrid = detectTempo(onsetStrength?.data ?? new Float32Array(0), durationSeconds, {
    rate: ANALYSIS_RATE,
    ...(options.bpmOverride === undefined ? {} : { bpmOverride: options.bpmOverride }),
  });

  // `beat` is a feature track like any other, so the evaluator reads it through the same path
  // as `rms` — the grid does not need a special case anywhere downstream.
  const features = new Map<string, AnalysisTrack>(source.features);
  features.set('beat', { rate: ANALYSIS_RATE, channels: 1, data: beatPulse(beatGrid, ANALYSIS_RATE, frames) });
  features.set('waveform', { rate: WAVEFORM_RATE, channels: 1, data: resampleWaveform(pcm) });

  const analysed: SourceAnalysis = { spectrum: source.spectrum, bands: source.bands, features };
  const sources = new Map<Stem, SourceAnalysis>([['mix', analysed]]);
  return {
    analysis: beatGrid.bpm > 0 ? { sources, beatGrid } : { sources },
    beatGrid,
    onsetTimes: source.onsetTimes,
  };
}
