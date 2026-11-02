import { describe, expect, it } from 'vitest';

import { ANALYSIS_RATE, type AnalysisSet, type SourceAnalysis } from '../../src/engine/core/analysis.ts';
import type { Section } from '../../src/analysis/sections.ts';
import { buildTrackDigest, describeStyle, styleVector, type TrackDigest } from '../../src/director/digest.ts';

const BINS = 12;

/** A synthetic source with a chosen loudness envelope and spectral tilt. */
function source(options: {
  readonly seconds: number;
  readonly rms: (t: number) => number;
  /** 0 = all energy in the lowest bins, 1 = all in the highest. */
  readonly tilt?: number;
  readonly centroid?: number;
  readonly stereoWidth?: number;
}): SourceAnalysis {
  const frames = Math.round(options.seconds * ANALYSIS_RATE);
  const rms = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) rms[i] = options.rms(i / ANALYSIS_RATE);

  const spectrumFrames = Math.round(options.seconds * 4);
  const spectrum = new Float32Array(spectrumFrames * BINS);
  const tilt = options.tilt ?? 0.5;
  for (let frame = 0; frame < spectrumFrames; frame += 1) {
    for (let bin = 0; bin < BINS; bin += 1) {
      const position = bin / (BINS - 1);
      spectrum[frame * BINS + bin] = Math.exp(-((position - tilt) ** 2) / 0.05);
    }
  }

  const features = new Map([
    ['rms', { rate: ANALYSIS_RATE, channels: 1, data: rms }],
    ['centroid', { rate: ANALYSIS_RATE, channels: 1, data: filled(frames, options.centroid ?? 0.4) }],
  ]);
  if (options.stereoWidth !== undefined) {
    features.set('stereoWidth', { rate: ANALYSIS_RATE, channels: 1, data: filled(frames, options.stereoWidth) });
  }
  return { spectrum: { rate: 4, channels: BINS, data: spectrum }, bands: new Map(), features };
}

function filled(length: number, value: number): Float32Array {
  const data = new Float32Array(length);
  data.fill(value);
  return data;
}

function analysisOf(mix: SourceAnalysis, bpm = 128, confidence = 0.8, seconds = 60): AnalysisSet {
  const beats: number[] = [];
  for (let i = 0; i * (60 / bpm) <= seconds; i += 1) beats.push(i * (60 / bpm));
  return { sources: new Map([['mix', mix]]), beatGrid: { bpm, confidence, beats } };
}

/** Onsets exactly on the grid — a quantised production. */
function quantisedOnsets(bpm: number, seconds: number): number[] {
  const period = 60 / bpm;
  return Array.from({ length: Math.floor(seconds / period) }, (_, i) => i * period);
}

const sections: Section[] = [
  { startSeconds: 0, endSeconds: 20, label: 'intro', energy: 0.05 },
  { startSeconds: 20, endSeconds: 45, label: 'main', energy: 0.3 },
  { startSeconds: 45, endSeconds: 60, label: 'outro', energy: 0.08 },
];

describe('buildTrackDigest', () => {
  it('summarises energy with percentiles, not extremes', () => {
    // One clipped sample must not define how dynamic a track is.
    const mix = source({ seconds: 60, rms: (t) => (t > 30 ? 0.3 : 0.1) });
    mix.features.get('rms')!.data[0] = 1;
    const digest = buildTrackDigest({ analysis: analysisOf(mix), durationSeconds: 60, onsetTimes: [], sections });

    expect(digest.energy.mean).toBeCloseTo(0.2, 1);
    expect(digest.energy.dynamicRange).toBeCloseTo(0.2, 1); // p90 − p10, not 1 − 0.1
    expect(digest.energy.crestFactor).toBeGreaterThan(1);
  });

  it('reads the spectral balance from where the energy sits', () => {
    const bassy = buildTrackDigest({
      analysis: analysisOf(source({ seconds: 30, rms: () => 0.2, tilt: 0.05 })),
      durationSeconds: 30,
      onsetTimes: [],
      sections: [],
    });
    const airy = buildTrackDigest({
      analysis: analysisOf(source({ seconds: 30, rms: () => 0.2, tilt: 0.95 })),
      durationSeconds: 30,
      onsetTimes: [],
      sections: [],
    });
    expect(bassy.spectrum.bassWeight).toBeGreaterThan(airy.spectrum.bassWeight);
    expect(airy.spectrum.airWeight).toBeGreaterThan(bassy.spectrum.airWeight);
  });

  it('measures how closely onsets land on the grid', () => {
    const mix = source({ seconds: 60, rms: () => 0.2 });
    const analysis = analysisOf(mix, 120);

    const quantised = buildTrackDigest({
      analysis,
      durationSeconds: 60,
      onsetTimes: quantisedOnsets(120, 60),
      sections,
    });
    // Onsets halfway between beats: as unrelated to the grid as it gets.
    const offGrid = buildTrackDigest({
      analysis,
      durationSeconds: 60,
      onsetTimes: quantisedOnsets(120, 60).map((t) => t + 0.25),
      sections,
    });

    expect(quantised.transients.regularity).toBeCloseTo(1, 5);
    expect(offGrid.transients.regularity).toBeCloseTo(0, 5);
    expect(quantised.transients.perBar).toBeCloseTo(4, 1);
  });

  it('has no regularity to report without a grid', () => {
    const mix = source({ seconds: 30, rms: () => 0.2 });
    const digest = buildTrackDigest({
      analysis: { sources: new Map([['mix', mix]]) },
      durationSeconds: 30,
      onsetTimes: [1, 2, 3],
      sections: [],
    });
    expect(digest.transients.regularity).toBeNull();
    expect(digest.transients.perBar).toBeNull();
    expect(digest.transients.density).toBeCloseTo(0.1, 5);
  });

  it('finds the loudest and quietest sections and the drops between them', () => {
    const digest = buildTrackDigest({
      analysis: analysisOf(source({ seconds: 60, rms: () => 0.2 })),
      durationSeconds: 60,
      onsetTimes: [],
      sections,
    });
    expect(digest.structure.loudestSection).toBe(1);
    expect(digest.structure.quietestSection).toBe(0);
    expect(digest.structure.drops).toEqual([20]); // into the loud section, not out of it
  });

  it('says stems are absent rather than reporting zero for them', () => {
    // A stem that has not been separated is missing, not silent (data-formats §4.4).
    const digest = buildTrackDigest({
      analysis: analysisOf(source({ seconds: 30, rms: () => 0.2 })),
      durationSeconds: 30,
      onsetTimes: [],
      sections: [],
    });
    expect(digest.stems.available).toBe(false);
    expect(digest.stems.vocalPresence).toBeNull();
    expect(digest.stems.vocalCoverage).toBeNull();
  });

  it('reads vocal coverage from a vocal stem when there is one', () => {
    const mix = source({ seconds: 60, rms: () => 0.2 });
    // Vocals for the middle third of the track.
    const vocals = source({ seconds: 60, rms: (t) => (t > 20 && t < 40 ? 0.3 : 0) });
    const analysis: AnalysisSet = {
      sources: new Map([['mix', mix], ['vocals', vocals]]),
      beatGrid: { bpm: 120, confidence: 0.9, beats: [0] },
    };
    const digest = buildTrackDigest({ analysis, durationSeconds: 60, onsetTimes: [], sections });

    expect(digest.stems.available).toBe(true);
    // Coverage, not level: a quiet vocal running throughout is still a vocal-led track.
    expect(digest.stems.vocalCoverage).toBeCloseTo(1 / 3, 1);
  });

  it('survives an empty analysis', () => {
    const digest = buildTrackDigest({
      analysis: { sources: new Map() },
      durationSeconds: 0,
      onsetTimes: [],
      sections: [],
    });
    expect(digest.bpm).toBe(0);
    expect(digest.energy.mean).toBe(0);
    expect(digest.structure.loudestSection).toBeNull();
  });
});

describe('styleVector', () => {
  const digestFor = (options: Parameters<typeof source>[0] & { bpm?: number; onsets?: number[]; confidence?: number }) => {
    const mix = source(options);
    return buildTrackDigest({
      analysis: analysisOf(mix, options.bpm ?? 128, options.confidence ?? 0.85, options.seconds),
      durationSeconds: options.seconds,
      onsetTimes: options.onsets ?? quantisedOnsets(options.bpm ?? 128, options.seconds),
      sections,
    });
  };

  it('scales against music in general, not against the track', () => {
    // An ambient piece's loudest moment is not "maximum energy" — normalising within the track
    // would say it was, and the director would dress it like a festival banger.
    const ambient = styleVector(digestFor({ seconds: 60, rms: (t) => 0.02 + 0.01 * Math.sin(t), bpm: 70, onsets: [1, 30] }));
    const banger = styleVector(digestFor({ seconds: 60, rms: () => 0.32, bpm: 150 }));

    expect(ambient.energy).toBeLessThan(0.25);
    expect(banger.energy).toBeGreaterThan(0.6);
  });

  it('puts most of the tempo axis where the distinction lives', () => {
    const slow = styleVector(digestFor({ seconds: 30, rms: () => 0.2, bpm: 70 }));
    const mid = styleVector(digestFor({ seconds: 30, rms: () => 0.2, bpm: 120 }));
    const fast = styleVector(digestFor({ seconds: 30, rms: () => 0.2, bpm: 175 }));

    expect(slow.tempo).toBeLessThan(0.2);
    expect(mid.tempo).toBeGreaterThan(0.4);
    expect(mid.tempo).toBeLessThan(0.7);
    expect(fast.tempo).toBeGreaterThan(0.85);
    // 90→140 spans more of the axis than 140→190, because that is where the distinction is.
    const a = styleVector(digestFor({ seconds: 30, rms: () => 0.2, bpm: 90 })).tempo;
    const b = styleVector(digestFor({ seconds: 30, rms: () => 0.2, bpm: 140 })).tempo;
    const c = styleVector(digestFor({ seconds: 30, rms: () => 0.2, bpm: 190 })).tempo;
    expect(b - a).toBeGreaterThan(c - b);
  });

  it('separates quantised from played', () => {
    const period = 60 / 120;
    const machine = styleVector(digestFor({ seconds: 60, rms: () => 0.2, bpm: 120 }));
    const played = styleVector(
      digestFor({
        seconds: 60,
        rms: () => 0.2,
        bpm: 120,
        confidence: 0.3,
        // A drummer pushing and pulling around the beat.
        onsets: quantisedOnsets(120, 60).map((t, i) => t + (i % 2 === 0 ? 0.18 : -0.14) * period),
      }),
    );
    expect(machine.organic).toBeLessThan(0.3);
    expect(played.organic).toBeGreaterThan(0.5);
  });

  it('reads brightness and darkness from the spectrum', () => {
    const bright = styleVector(digestFor({ seconds: 30, rms: () => 0.2, tilt: 0.95, centroid: 0.75 }));
    const dark = styleVector(digestFor({ seconds: 30, rms: () => 0.2, tilt: 0.05, centroid: 0.15 }));
    expect(bright.brightness).toBeGreaterThan(0.7);
    expect(dark.brightness).toBeLessThan(0.3);
    expect(dark.darkness).toBeGreaterThan(bright.darkness);
  });

  it('names the axes it could not measure instead of guessing', () => {
    // Stems are not separated yet, so vocalWeight is unknown — and a director that knows it is
    // guessing can pick a template that does not depend on the guess.
    const style = styleVector(digestFor({ seconds: 30, rms: () => 0.2 }));
    expect(style.unmeasured).toContain('vocalWeight');
    expect(style.vocalWeight).toBe(0.5);
  });

  it('every axis stays inside 0..1 for absurd input', () => {
    const digest: TrackDigest = {
      ...digestFor({ seconds: 30, rms: () => 0.2 }),
      bpm: 10_000,
      energy: { mean: 99, peak: 1000, dynamicRange: 99, crestFactor: 1000 },
      spectrum: { centroidMean: 9, airWeight: 9, bassWeight: 9 },
    };
    const style = styleVector(digest);
    for (const [axis, value] of Object.entries(style)) {
      if (axis === 'unmeasured') continue;
      expect(value as number, axis).toBeGreaterThanOrEqual(0);
      expect(value as number, axis).toBeLessThanOrEqual(1);
    }
  });

  it('is deterministic', () => {
    const digest = digestFor({ seconds: 30, rms: () => 0.2 });
    expect(styleVector(digest)).toEqual(styleVector(digest));
  });
});

describe('describeStyle', () => {
  it('reads as a sentence a person can check against the music', () => {
    const description = describeStyle({
      tempo: 0.8,
      energy: 0.8,
      brightness: 0.7,
      density: 0.7,
      organic: 0.1,
      vocalWeight: 0.7,
      dynamics: 0.4,
      darkness: 0.2,
      unmeasured: [],
    });
    expect(description).toContain('fast');
    expect(description).toContain('high-energy');
    expect(description).toContain('bright');
    expect(description).toContain('electronic');
    expect(description).toContain('vocal-led');
  });

  it('says what it could not measure rather than implying it knows', () => {
    const description = describeStyle({
      tempo: 0.5,
      energy: 0.5,
      brightness: 0.5,
      density: 0.5,
      organic: 0.5,
      vocalWeight: 0.5,
      dynamics: 0.5,
      darkness: 0.5,
      unmeasured: ['vocalWeight'],
    });
    expect(description).toContain('vocalWeight not measured');
    expect(description).not.toContain('vocal-led');
    expect(description).not.toContain('instrumental');
  });
});
