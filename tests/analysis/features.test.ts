// Audio features, onsets and tempo (src/analysis/features.ts, M4).
//
// Tested against signals whose answer is known by construction — a click track at an exact
// tempo, a full-scale sine, identical vs inverted channels — because "it looks about right on a
// song" is not a test, and these numbers end up driving every render.

import { describe, expect, it } from 'vitest';

import { analyzeMix } from '../../src/analysis/analyze.ts';
import {
  beatPulse, detectOnsets, detectTempo, levelToUnit, spectralCentroid, spectralFlux, stereoWidth,
  windowedPeak, windowedRms,
} from '../../src/analysis/features.ts';
import { ANALYSIS_SAMPLE_RATE } from '../../src/analysis/spectrum.ts';
import { ANALYSIS_RATE } from '../../src/engine/core/analysis.ts';

const RATE = ANALYSIS_SAMPLE_RATE;

/** A sine at `hz`, `seconds` long, amplitude 1. */
function sine(hz: number, seconds: number, amplitude = 1): Float32Array {
  const pcm = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < pcm.length; i += 1) pcm[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / RATE);
  return pcm;
}

/** Short bursts of noise at an exact tempo — the cleanest thing a beat tracker can be given. */
function clickTrack(bpm: number, seconds: number): Float32Array {
  const pcm = new Float32Array(Math.round(seconds * RATE));
  const period = (60 / bpm) * RATE;
  const burst = Math.round(0.01 * RATE);
  for (let beat = 0; beat * period < pcm.length; beat += 1) {
    const start = Math.round(beat * period);
    for (let i = 0; i < burst && start + i < pcm.length; i += 1) {
      // A decaying click: broadband enough to show up in the flux across many bins.
      pcm[start + i] = Math.sin(i * 0.7) * (1 - i / burst);
    }
  }
  return pcm;
}

describe('levels', () => {
  it('reads a full-scale sine as 1 and silence as 0', () => {
    const pcm = sine(440, 0.2);
    const centre = Math.round(pcm.length / 2);
    expect(windowedRms(pcm, centre, 2048)).toBeCloseTo(1, 2);
    expect(windowedPeak(pcm, centre, 512)).toBeCloseTo(1, 2);
    expect(windowedRms(new Float32Array(4096), 100, 2048)).toBe(0);
  });

  it('maps dBFS to 0..1 against the floor', () => {
    expect(levelToUnit(1, -72)).toBeCloseTo(1, 9);
    expect(levelToUnit(0, -72)).toBe(0);
    // −36 dB is halfway up a −72 dB floor.
    expect(levelToUnit(10 ** (-36 / 20), -72)).toBeCloseTo(0.5, 6);
  });

  it('clamps rather than reporting above 1 for an over-unity signal', () => {
    expect(levelToUnit(4, -72)).toBe(1);
  });
});

describe('spectralCentroid', () => {
  const binHz = RATE / 2048;

  it('rises with brightness, on a log scale', () => {
    const low = new Float64Array(1024);
    const high = new Float64Array(1024);
    low[Math.round(200 / binHz)] = 1;
    high[Math.round(6000 / binHz)] = 1;
    const dark = spectralCentroid(low, binHz, 30, 16_000);
    const bright = spectralCentroid(high, binHz, 30, 16_000);
    expect(bright).toBeGreaterThan(dark);
    // Log mapping is the point: a linear one would put 200 Hz at 0.01 and never move.
    expect(dark).toBeGreaterThan(0.2);
    expect(bright).toBeLessThan(1);
  });

  it('is 0 for silence rather than NaN', () => {
    expect(spectralCentroid(new Float64Array(1024), binHz, 30, 16_000)).toBe(0);
  });
});

describe('spectralFlux', () => {
  it('counts energy appearing and ignores energy leaving', () => {
    const quiet = Float64Array.from([0, 0, 0, 0]);
    const loud = Float64Array.from([0, 1, 1, 1]);
    expect(spectralFlux(loud, quiet)).toBeCloseTo(3, 9);
    // A note ending is not an onset; counting it would fire the source twice per note.
    expect(spectralFlux(quiet, loud)).toBe(0);
  });
});

describe('stereoWidth', () => {
  it('is 0 for identical channels and high for inverted ones', () => {
    const left = sine(440, 0.1);
    const same = new Float32Array(left);
    const inverted = left.map((s) => -s);
    const centre = Math.round(left.length / 2);
    expect(stereoWidth(left, same, centre, 2048)).toBeCloseTo(0, 6);
    expect(stereoWidth(left, inverted, centre, 2048)).toBeGreaterThan(0.9);
  });
});

describe('onset detection', () => {
  it('finds clicks at the times they were placed', () => {
    const { onsetTimes } = analyzeMix(clickTrack(120, 4));
    // 120 bpm for 4 s is 8 clicks; allow the detector to miss the one at t=0, whose flux has
    // no previous frame to rise from.
    expect(onsetTimes.length).toBeGreaterThanOrEqual(7);
    expect(onsetTimes.length).toBeLessThanOrEqual(9);
    for (const t of onsetTimes.slice(1)) {
      const nearestBeat = Math.round(t / 0.5) * 0.5;
      expect(Math.abs(t - nearestBeat)).toBeLessThan(0.03);
    }
  });

  it('finds nothing in silence, instead of firing on noise in the floor', () => {
    expect(detectOnsets(new Float32Array(1000), { rate: ANALYSIS_RATE, sensitivity: 1 }).times).toEqual([]);
  });

  it('produces a decaying impulse per onset — the punchiest source in the catalogue', () => {
    const flux = new Float32Array(240);
    flux[100] = 1;
    const { strength } = detectOnsets(flux, { rate: ANALYSIS_RATE, sensitivity: 0.5 });
    expect(strength[100]).toBeCloseTo(1, 6);
    expect(strength[110] as number).toBeLessThan(1);
    expect(strength[110] as number).toBeGreaterThan(0);
    expect(strength[99]).toBe(0);
  });

  it('finds more with higher sensitivity', () => {
    const flux = new Float32Array(720);
    for (let i = 50; i < 700; i += 50) flux[i] = i % 100 === 0 ? 1 : 0.25;
    const shy = detectOnsets(flux, { rate: ANALYSIS_RATE, sensitivity: 0 }).times.length;
    const eager = detectOnsets(flux, { rate: ANALYSIS_RATE, sensitivity: 1 }).times.length;
    expect(eager).toBeGreaterThanOrEqual(shy);
  });
});

describe('tempo and the beat grid', () => {
  it('recovers a known tempo from a click track', () => {
    const { beatGrid } = analyzeMix(clickTrack(120, 8));
    expect(beatGrid.bpm).toBeGreaterThan(118);
    expect(beatGrid.bpm).toBeLessThan(122);
    expect(beatGrid.confidence).toBeGreaterThan(0.3);
  });

  it('works at another tempo, so it is not fitting one number', () => {
    const { beatGrid } = analyzeMix(clickTrack(90, 8));
    expect(beatGrid.bpm).toBeGreaterThan(88);
    expect(beatGrid.bpm).toBeLessThan(92);
  });

  it('places beats on the clicks, not merely at the right spacing', () => {
    const { beatGrid } = analyzeMix(clickTrack(120, 8));
    expect(beatGrid.beats.length).toBeGreaterThan(10);
    for (const t of beatGrid.beats.slice(1, 8)) {
      expect(Math.abs(t - Math.round(t / 0.5) * 0.5)).toBeLessThan(0.05);
    }
  });

  it('does not drift when the tempo falls between two whole frames', () => {
    // 85.01 bpm is 169.39 frames a beat. A whole-frame period is 94 ms out by the end of 80 s.
    const period = (60 / 85.01) * ANALYSIS_RATE;
    const onset = new Float32Array(80 * ANALYSIS_RATE);
    for (let k = 0; ; k += 1) {
      const i = Math.round(30 + k * period);
      if (i >= onset.length) break;
      onset[i] = 1;
    }
    const grid = detectTempo(onset, 80, { rate: ANALYSIS_RATE });
    expect(grid.bpm).toBeCloseTo(85.01, 0);
    const last = grid.beats[grid.beats.length - 1] as number;
    const truth = (30 + Math.round((last * ANALYSIS_RATE - 30) / period) * period) / ANALYSIS_RATE;
    expect(Math.abs(last - truth)).toBeLessThan(0.015);
  });

  it('honours an explicit BPM instead of detecting', () => {
    const grid = detectTempo(new Float32Array(2400), 10, { rate: ANALYSIS_RATE, bpmOverride: 128 });
    expect(grid.bpm).toBe(128);
    expect(grid.beats[1]).toBeCloseTo(60 / 128, 9);
  });

  it('reports no grid rather than a confident wrong tempo for silence', () => {
    const grid = detectTempo(new Float32Array(2400), 10, { rate: ANALYSIS_RATE });
    expect(grid.bpm).toBe(0);
    expect(grid.beats).toEqual([]);
    expect(grid.confidence).toBe(0);
  });

  it('turns the grid into a pulse that peaks on each beat', () => {
    const pulse = beatPulse({ bpm: 120, beats: [0, 0.5, 1], confidence: 1 }, ANALYSIS_RATE, 300);
    expect(pulse[0]).toBeCloseTo(1, 6);
    expect(pulse[120]).toBeCloseTo(1, 6);
    expect(pulse[60] as number).toBeLessThan(0.2); // between beats
  });
});

describe('analyzeMix', () => {
  it('produces every feature the modulation catalogue names', () => {
    const { analysis } = analyzeMix(sine(440, 1));
    const features = analysis.sources.get('mix')?.features;
    for (const name of ['rms', 'peak', 'onset', 'beat', 'centroid', 'flux']) {
      expect(features?.has(name)).toBe(true);
    }
    // Absent without a second channel — reported by the evaluator, never read as "mono".
    expect(features?.has('stereoWidth')).toBe(false);
  });

  it('adds stereoWidth when a right channel is supplied', () => {
    const left = sine(440, 0.5);
    const { analysis } = analyzeMix(left, { right: left.map((s) => -s) });
    expect(analysis.sources.get('mix')?.features.has('stereoWidth')).toBe(true);
  });

  it('is deterministic: the same audio gives the same numbers', () => {
    const pcm = clickTrack(120, 2);
    const a = analyzeMix(pcm);
    const b = analyzeMix(pcm);
    expect([...(b.analysis.sources.get('mix')?.features.get('rms')?.data ?? [])])
      .toEqual([...(a.analysis.sources.get('mix')?.features.get('rms')?.data ?? [])]);
    expect(b.beatGrid).toEqual(a.beatGrid);
  });

  it('omits the beat grid when no tempo was found', () => {
    expect(analyzeMix(new Float32Array(RATE)).analysis.beatGrid).toBeUndefined();
  });
});
