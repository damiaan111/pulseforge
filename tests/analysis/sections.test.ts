import { describe, expect, it } from 'vitest';

import { ANALYSIS_RATE, type SourceAnalysis } from '../../src/engine/core/analysis.ts';
import { detectSections, MIN_SECTION_SECONDS, sectionsToJson, SECTIONS_FORMAT_VERSION } from '../../src/analysis/sections.ts';

const BINS = 16;
const STRUCTURE_RATE = 4;

/**
 * A synthetic track built from named timbres: each entry is a stretch of seconds with a spectral
 * shape and a level. Real audio would make these tests slow and their expectations arguable;
 * synthetic timbre makes "where are the boundaries" a question with a known answer.
 */
function makeSource(parts: readonly { seconds: number; centre: number; level: number }[]): {
  source: SourceAnalysis;
  duration: number;
} {
  const duration = parts.reduce((sum, part) => sum + part.seconds, 0);
  const spectrumFrames = Math.round(duration * STRUCTURE_RATE);
  const spectrum = new Float32Array(spectrumFrames * BINS);
  const rmsFrames = Math.round(duration * ANALYSIS_RATE);
  const rms = new Float32Array(rmsFrames);

  let frame = 0;
  let rmsFrame = 0;
  for (const part of parts) {
    for (let i = 0; i < Math.round(part.seconds * STRUCTURE_RATE) && frame < spectrumFrames; i += 1, frame += 1) {
      for (let bin = 0; bin < BINS; bin += 1) {
        // A bump around `centre`: a distinct timbre, independent of level.
        spectrum[frame * BINS + bin] = Math.exp(-((bin - part.centre) ** 2) / 8) * part.level;
      }
    }
    for (let i = 0; i < Math.round(part.seconds * ANALYSIS_RATE) && rmsFrame < rmsFrames; i += 1, rmsFrame += 1) {
      rms[rmsFrame] = part.level;
    }
  }

  return {
    duration,
    source: {
      spectrum: { rate: STRUCTURE_RATE, channels: BINS, data: spectrum },
      bands: new Map(),
      features: new Map([['rms', { rate: ANALYSIS_RATE, channels: 1, data: rms }]]),
    },
  };
}

describe('detectSections', () => {
  it('finds the boundary between two different timbres', () => {
    const { source, duration } = makeSource([
      { seconds: 30, centre: 3, level: 0.3 },
      { seconds: 30, centre: 12, level: 0.9 },
    ]);
    const { sections } = detectSections(source, duration);

    expect(sections.length).toBeGreaterThanOrEqual(2);
    const boundary = sections[0]!.endSeconds;
    expect(boundary).toBeGreaterThan(24);
    expect(boundary).toBeLessThan(36);
  });

  it('covers the whole track with no gaps or overlaps', () => {
    const { source, duration } = makeSource([
      { seconds: 20, centre: 2, level: 0.2 },
      { seconds: 25, centre: 10, level: 0.8 },
      { seconds: 20, centre: 5, level: 0.4 },
    ]);
    const { sections } = detectSections(source, duration);

    expect(sections[0]!.startSeconds).toBe(0);
    expect(sections.at(-1)!.endSeconds).toBeCloseTo(duration, 1);
    for (let i = 1; i < sections.length; i += 1) {
      expect(sections[i]!.startSeconds).toBeCloseTo(sections[i - 1]!.endSeconds, 6);
    }
  });

  it('never places boundaries closer than the anti-chaos minimum', () => {
    // Rapid alternation: without a minimum spacing this strobes, which is exactly what
    // auto-director-spec §6 forbids.
    const parts = Array.from({ length: 20 }, (_, i) => ({
      seconds: 3,
      centre: i % 2 === 0 ? 2 : 13,
      level: i % 2 === 0 ? 0.3 : 0.9,
    }));
    const { source, duration } = makeSource(parts);
    const { sections } = detectSections(source, duration);

    for (const section of sections) {
      expect(section.endSeconds - section.startSeconds).toBeGreaterThanOrEqual(MIN_SECTION_SECONDS - 0.5);
    }
  });

  it('a level change alone is not a section change', () => {
    // Same timbre, different volume: a chorus is not simply "louder", and treating it that way
    // puts a boundary in the middle of a crescendo.
    const { source, duration } = makeSource([
      { seconds: 30, centre: 8, level: 0.25 },
      { seconds: 30, centre: 8, level: 0.95 },
    ]);
    const { sections } = detectSections(source, duration);
    expect(sections).toHaveLength(1);
  });

  it('returns one section for audio too short to have structure', () => {
    const { source, duration } = makeSource([{ seconds: 5, centre: 5, level: 0.5 }]);
    const { sections } = detectSections(source, duration);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.label).toBe('main');
    expect(sections[0]!.endSeconds).toBeCloseTo(duration, 6);
  });

  it('handles silence without inventing structure', () => {
    const { source, duration } = makeSource([
      { seconds: 30, centre: 5, level: 0 },
      { seconds: 30, centre: 5, level: 0 },
    ]);
    const { sections } = detectSections(source, duration);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.energy).toBe(0);
  });

  it('sensitivity trades boundaries for stability', () => {
    const { source, duration } = makeSource([
      { seconds: 20, centre: 2, level: 0.3 },
      { seconds: 20, centre: 9, level: 0.6 },
      { seconds: 20, centre: 14, level: 0.9 },
      { seconds: 20, centre: 4, level: 0.4 },
    ]);
    const shy = detectSections(source, duration, { sensitivity: 0 }).sections.length;
    const eager = detectSections(source, duration, { sensitivity: 1 }).sections.length;
    expect(eager).toBeGreaterThanOrEqual(shy);
  });

  it('labels the loudest stretch main and a quiet opening intro', () => {
    const { source, duration } = makeSource([
      { seconds: 20, centre: 2, level: 0.15 },
      { seconds: 30, centre: 12, level: 0.95 },
      { seconds: 20, centre: 3, level: 0.2 },
    ]);
    const { sections } = detectSections(source, duration);
    expect(sections[0]!.label).toBe('intro');
    expect(sections.some((section) => section.label === 'main')).toBe(true);
    expect(sections.at(-1)!.label).toBe('outro');
  });

  it('reports energy per section on the rms scale', () => {
    const { source, duration } = makeSource([
      { seconds: 30, centre: 2, level: 0.2 },
      { seconds: 30, centre: 12, level: 0.8 },
    ]);
    const { sections } = detectSections(source, duration);
    expect(sections[0]!.energy).toBeCloseTo(0.2, 1);
    expect(sections.at(-1)!.energy).toBeCloseTo(0.8, 1);
  });

  it('keeps the novelty curve so a boundary can be explained', () => {
    const { source, duration } = makeSource([
      { seconds: 30, centre: 2, level: 0.3 },
      { seconds: 30, centre: 12, level: 0.9 },
    ]);
    const result = detectSections(source, duration);
    expect(result.noveltyRate).toBe(STRUCTURE_RATE);
    expect(Math.max(...result.novelty)).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    const { source, duration } = makeSource([
      { seconds: 25, centre: 3, level: 0.4 },
      { seconds: 25, centre: 11, level: 0.8 },
    ]);
    expect(detectSections(source, duration).sections).toEqual(detectSections(source, duration).sections);
  });
});

describe('sectionsToJson', () => {
  it('writes the sections and drops the curve, which is reconstructible', () => {
    const { source, duration } = makeSource([
      { seconds: 30, centre: 2, level: 0.3 },
      { seconds: 30, centre: 12, level: 0.9 },
    ]);
    const json = JSON.parse(sectionsToJson(detectSections(source, duration))) as Record<string, unknown>;
    expect(json['formatVersion']).toBe(SECTIONS_FORMAT_VERSION);
    expect(Array.isArray(json['sections'])).toBe(true);
    expect(json['novelty']).toBeUndefined();
  });
});
