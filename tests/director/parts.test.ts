// The auto-director's parts, one rule at a time: arrangement (anti-chaos, anti-monotony, presence,
// drops, the title hold), palette contrast, matching and calibration.

import { describe, expect, it } from 'vitest';

import type { Section } from '../../src/analysis/sections.ts';
import { arrange, type ArrangeInput } from '../../src/director/arrange.ts';
import { calibrate } from '../../src/director/calibrate.ts';
import type { StyleVector } from '../../src/director/digest.ts';
import { canonicalJson, fingerprint } from '../../src/director/fingerprint.ts';
import { scoreTemplate } from '../../src/director/match.ts';
import { contrastRatio, generatePalette } from '../../src/director/palette.ts';
import { parseTemplate, type TemplateArrangement, type TemplateModulation } from '../../src/director/template.ts';
import type { ParamSpec } from '../../src/engine/core/params.ts';
import { MODULES, builtinTemplates } from './fixture.ts';

const section = (startSeconds: number, endSeconds: number, label: Section['label']): Section => ({ startSeconds, endSeconds, label, energy: 0.5 });

const ARRANGEMENT: TemplateArrangement = {
  sections: {
    intro: { intensity: 0.3, addLayers: [], removeLayers: [] },
    main: { intensity: 1, addLayers: ['ACCENT'], removeLayers: [] },
    breakdown: { intensity: 0.4, addLayers: [], removeLayers: ['ACCENT'] },
  },
  intensityTargets: [],
  floor: 0.35,
  optionalLayers: ['ACCENT'],
  textHold: 'untilFirstVocal',
  drop: { targets: [], amount: 0.5, decaySeconds: 0.5 },
  fadeIn: 0,
  fadeOut: 0,
};

function input(overrides: Partial<ArrangeInput> = {}): ArrangeInput {
  return {
    sections: [section(0, 20, 'intro'), section(20, 50, 'main'), section(50, 70, 'breakdown'), section(70, 100, 'main')],
    placement: { leadInTicks: 0, clipInTicks: 0 },
    durationSeconds: 100,
    beats: Array.from({ length: 200 }, (_, i) => i * 0.5),
    onsets: [],
    drops: [],
    vocalSegments: [],
    arrangement: ARRANGEMENT,
    optionalSlots: ['ACCENT'],
    jitter: () => 0,
    intensityJitter: 0,
    ...overrides,
  };
}

describe('arrangement', () => {
  it('gives each section its intensity and a curve that holds, then ramps across boundaries', () => {
    const a = arrange(input());
    expect(a.sections.map((s) => [s.label, s.intensity])).toEqual([['intro', 0.3], ['main', 1], ['breakdown', 0.4], ['main', 1]]);
    const ticks = a.intensity.map((p) => p.ticks);
    expect([...ticks].sort((x, y) => x - y)).toEqual(ticks);
    expect(a.intensity[0]).toEqual({ ticks: 0, value: 0.3 });
  });

  it('brings an optional layer in and out on section boundaries, with a fade', () => {
    const presence = arrange(input()).presence.get('ACCENT');
    expect(presence?.kind).toBe('curve');
    if (presence?.kind !== 'curve') return;
    expect(presence.inSeconds).toBe(20);
    expect(presence.outSeconds).toBeNull();
    const values = presence.points.map((p) => p.value);
    expect(values).toEqual([0, 0, 1, 1, 0, 0, 1]);
  });

  it('merges a boundary less than 8 s after the previous change (anti-chaos)', () => {
    const a = arrange(input({ sections: [section(0, 20, 'intro'), section(20, 24, 'main'), section(24, 60, 'breakdown'), section(60, 100, 'main')] }));
    expect(a.sections.length).toBe(3);
    expect(a.notes.some((n) => /anti-chaos/.test(n))).toBe(true);
  });

  it('snaps boundaries to the beat grid', () => {
    const a = arrange(input({ sections: [section(0, 20.2, 'intro'), section(20.2, 100, 'main')] }));
    expect(a.sections[1]!.startSeconds).toBe(20);
  });

  it('pushes apart two neighbouring sections that would look the same (anti-monotony)', () => {
    const a = arrange(input({ sections: [section(0, 30, 'main'), section(30, 60, 'main'), section(60, 100, 'main')] }));
    expect(a.sections[1]!.intensity).not.toBe(a.sections[0]!.intensity);
    expect(a.notes.some((n) => /anti-monotony/.test(n))).toBe(true);
  });

  it('puts a drop impulse exactly on the nearest onset, and never two within 8 s', () => {
    const a = arrange(input({ drops: [20.05, 24], onsets: [19.9, 20.1, 23.9] }));
    const peaks = a.drops.filter((p) => p.value === 1).map((p) => p.ticks / 48_000);
    expect(peaks).toEqual([20.1]);
  });

  it('clears the title before the first vocal, or at the end of the intro without vocals', () => {
    expect(arrange(input({ vocalSegments: [{ start: 12, end: 20 }] })).textOutSeconds).toBeCloseTo(11.6, 6);
    expect(arrange(input()).textOutSeconds).toBe(20);
  });

  it('maps source time to the timeline: a lead-in moves every section', () => {
    const a = arrange(input({ placement: { leadInTicks: 48_000 * 2, clipInTicks: 0 }, durationSeconds: 102 }));
    expect(a.sections[1]!.startSeconds).toBe(22);
  });
});

const STYLE: StyleVector = { tempo: 0.7, energy: 0.8, brightness: 0.5, density: 0.5, organic: 0.2, vocalWeight: 0.5, dynamics: 0.4, darkness: 0.6, unmeasured: [] };

describe('palette', () => {
  it('enforces the text contrast minimum even when the template asks for low contrast colours', () => {
    const template = builtinTemplates().find((t) => t.id === 'tpl.minimal.type')!;
    const low = { ...template.palette, background: [0.4, 0.45] as const, mode: 'light' as const, minTextContrast: 7 };
    const { palette, notes } = generatePalette(low, STYLE, 1, 0);
    const c = (role: string) => palette.colors[palette.roles[role]!]!;
    expect(contrastRatio(c('text'), c('background'))).toBeGreaterThanOrEqual(7);
    expect(notes.some((n) => /contrast/i.test(n))).toBe(true);
  });

  it('is seeded: the same seed gives the same palette, another moves the hue within the jitter', () => {
    const spec = builtinTemplates()[0]!.palette;
    expect(generatePalette(spec, STYLE, 5, 20).palette).toEqual(generatePalette(spec, STYLE, 5, 20).palette);
    expect(generatePalette(spec, STYLE, 5, 20).palette.colors[0]).not.toBe(generatePalette(spec, STYLE, 6, 20).palette.colors[0]);
  });
});

describe('matching', () => {
  const template = (affinity: object) => parseTemplate({
    formatVersion: 1, id: 't', name: 'T', affinity,
    slots: [{ id: 'HERO', role: 'HERO', required: true, candidates: [{ module: 'core.visualizer.bars' }] }],
  }).template;

  it('scores inside the preferred range above outside it, and vetoes an avoided range', () => {
    const fits = scoreTemplate(template({ prefer: { energy: [0.7, 1] } }), STYLE, new Set(), MODULES, '16:9').score;
    const misses = scoreTemplate(template({ prefer: { energy: [0, 0.3] } }), STYLE, new Set(), MODULES, '16:9').score;
    const avoided = scoreTemplate(template({ prefer: { energy: [0.7, 1] }, avoid: { organic: [0, 0.3] } }), STYLE, new Set(), MODULES, '16:9').score;
    expect(fits).toBeGreaterThan(misses);
    expect(avoided).toBeLessThan(fits * 0.3);
  });

  it('leaves unmeasured axes out rather than scoring a guess', () => {
    const guessed = { ...STYLE, vocalWeight: 0.5, unmeasured: ['vocalWeight'] };
    expect(scoreTemplate(template({ prefer: { vocalWeight: [0.9, 1] } }), guessed, new Set(), MODULES, '16:9').score).toBe(0.5);
  });

  it('makes a template unavailable, with the reason, when a required slot has no installed module', () => {
    const t = parseTemplate({ formatVersion: 1, id: 'x', name: 'X', slots: [{ id: 'HERO', role: 'HERO', required: true, candidates: [{ module: 'vendor.nothing.here' }] }] }).template;
    const s = scoreTemplate(t, STYLE, new Set(), MODULES, '16:9');
    expect(s.availability.available).toBe(false);
    expect(s.availability.reason).toMatch(/vendor\.nothing\.here/);
  });

  it('substitutes a missing module by tag (D29)', () => {
    const t = parseTemplate({ formatVersion: 1, id: 'x', name: 'X', slots: [{ id: 'HERO', role: 'HERO', required: true, candidates: [{ module: 'core.visualizer.circular' }] }] }).template;
    const s = scoreTemplate(t, STYLE, new Set(), MODULES, '16:9');
    expect(s.availability.available).toBe(true);
    expect(s.availability.substitutes.get('core.visualizer.circular')).toBe('core.visualizer.radial');
  });
});

describe('calibration', () => {
  const float: ParamSpec = { key: 'glow', label: 'Glow', group: 'Look', type: 'float', default: 0.5, min: 0, max: 4, softMax: 1 };
  const mod = (overrides: Partial<TemplateModulation> = {}): TemplateModulation => ({
    targets: ['HERO.params.glow'], source: { type: 'rms', stem: 'mix', band: null, shape: null, rateHz: null, syncDivision: null },
    mode: 'add', intensity: 'medium', response: 'snappy', invert: false, label: null, ...overrides,
  });
  const stats = { p10: 0.1, p50: 0.3, p90: 0.6 };

  it('adds the band\'s share of the soft range, held under the soft max', () => {
    const c = calibrate(mod(), float, 0.5, stats, 0);
    expect(c.ok && c.amount).toBe(0.25);
    const strong = calibrate(mod({ intensity: 'strong' }), float, 0.5, stats, 0);
    expect(strong.ok && strong.amount).toBe(0.5);
  });

  it('maps the response to attack and release', () => {
    const c = calibrate(mod({ response: 'slow' }), float, 0.5, stats, 0);
    expect(c.ok && [c.attackMs, c.releaseMs]).toEqual([200, 1500]);
  });

  it('refuses a flat source, and an amount that rounds to nothing', () => {
    expect(calibrate(mod(), float, 0.5, { p10: 0.2, p50: 0.2, p90: 0.2 }, 0).ok).toBe(false);
    expect(calibrate(mod(), float, 1, stats, 0).ok).toBe(false);
  });

  it('caps a multiplying binding on a small base', () => {
    const speed: ParamSpec = { key: 'speed', label: 'Speed', group: 'Motion', type: 'float', default: 0.05, min: 0, max: 2 };
    const c = calibrate(mod({ mode: 'multiply' }), speed, 0.04, stats, 0);
    expect(c.ok && c.amount).toBeLessThanOrEqual(0.6);
  });
});

describe('fingerprints', () => {
  it('ignore key order and see any change', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
    expect(fingerprint({ a: 1, b: 2 })).toBe(fingerprint({ b: 2, a: 1 }));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 1.0001 }));
  });
});
