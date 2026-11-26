// The director and MilkDrop: a preset chosen for the track, always one known to draw a picture, and
// nothing that depends on them when they are not installed.

import { describe, expect, it } from 'vitest';

import { direct } from '../../src/director/direct.ts';
import { rankTemplates } from '../../src/director/match.ts';
import { chooseLook, lookDistance, milkdropLooks, type MilkdropLook } from '../../src/director/milkdrop.ts';
import { MILKDROP_MEASURES } from '../../src/director/milkdrop-catalogue.ts';
import type { StyleVector } from '../../src/director/digest.ts';
import { walkLayers, type ModuleLayer } from '../../src/project/document.ts';
import { MODULES, directorInput } from './fixture.ts';

const ALL = MILKDROP_MEASURES.map((row) => row[0]);
const STYLE: StyleVector = { tempo: 0.5, energy: 0.9, brightness: 0.5, density: 0.5, organic: 0.5, vocalWeight: 0.5, dynamics: 0.5, darkness: 0.2, unmeasured: [] };
const look = (over: Partial<MilkdropLook>): MilkdropLook => ({ name: 'a', brightness: 0.5, fill: 0.5, motion: 0.5, hue: 0, saturation: 0, ...over });
const milkdropLayer = (result: ReturnType<typeof direct>) =>
  [...walkLayers(result.document.layers)].map(({ layer }) => layer).find((l): l is ModuleLayer => l.kind === 'module' && l.module === 'core.visualizer.milkdrop');

describe('choosing a look', () => {
  it('knows only presets that are both measured and installed', () => {
    expect(milkdropLooks([ALL[0] as string, 'Not measured']).map((l) => l.name)).toEqual([ALL[0]]);
    expect(milkdropLooks([])).toEqual([]);
  });

  it('holds a preset to the track: busy for energy, dark for darkness', () => {
    expect(lookDistance(look({ motion: 0.9 }), STYLE, 0)).toBeLessThan(lookDistance(look({ motion: 0.1 }), STYLE, 0));
    const dark = { ...STYLE, darkness: 0.9 };
    expect(lookDistance(look({ brightness: 0.1 }), dark, 0)).toBeLessThan(lookDistance(look({ brightness: 0.9 }), dark, 0));
  });

  it('leans towards the palette, the short way round the wheel', () => {
    const near = lookDistance(look({ hue: 350, saturation: 1 }), STYLE, 10);
    expect(near).toBeLessThan(lookDistance(look({ hue: 170, saturation: 1 }), STYLE, 10));
  });

  it('ignores an axis that could not be measured', () => {
    const guessed = { ...STYLE, unmeasured: ['energy'] };
    expect(lookDistance(look({ motion: 0.1 }), guessed, 0)).toBe(lookDistance(look({ motion: 0.9 }), guessed, 0));
  });

  it('gives the same look for the same seed, and others for others', () => {
    const looks = milkdropLooks(ALL);
    expect(chooseLook(looks, STYLE, 40, 7, 'HERO')).toEqual(chooseLook(looks, STYLE, 40, 7, 'HERO'));
    expect(new Set([1, 2, 3, 4, 5, 6, 7, 8].map((seed) => chooseLook(looks, STYLE, 40, seed, 'HERO')?.name)).size).toBeGreaterThan(2);
  });

  it('has nothing to choose from an empty list', () => {
    expect(chooseLook([], STYLE, 0, 1, 'HERO')).toBeUndefined();
  });
});

describe('directing with MilkDrop', () => {
  const input = { ...directorInput(), milkdropPresets: ALL };

  it('prefers a MilkDrop template, and names a preset the catalogue knows', () => {
    const result = direct(input, { seed: 5 });
    expect(result.template.id).toMatch(/^tpl\.milkdrop\./);
    const preset = milkdropLayer(result)?.params['preset'];
    expect(ALL).toContain(preset);
    expect(result.log.some((entry) => entry.text.includes(String(preset)))).toBe(true);
  });

  it('is a pure function of the seed, and a new seed can change the preset', () => {
    const preset = (seed: number) => milkdropLayer(direct(input, { seed }))?.params['preset'];
    expect(preset(5)).toBe(preset(5));
    expect(new Set([1, 2, 3, 4, 5, 6].map(preset)).size).toBeGreaterThan(1);
  });

  it('writes bindings that reach the preset', () => {
    const layer = milkdropLayer(direct(input, { seed: 5 }));
    expect(layer?.modulations.some((binding) => binding.target.endsWith('params.brightness'))).toBe(true);
  });

  it('without the presets, offers the other templates and says why not these', () => {
    const none = directorInput();
    expect(milkdropLayer(direct(none, { seed: 5 }))).toBeUndefined();
    const ranked = rankTemplates(none.templates, none.style, new Set(), MODULES, '16:9');
    const surge = ranked.find((r) => r.template.id === 'tpl.milkdrop.surge');
    expect(surge?.availability.available).toBe(false);
    expect(surge?.availability.reason).toContain('Components');
    expect(() => direct(none, { seed: 5, templateId: 'tpl.milkdrop.surge' })).toThrow(/not installed/);
  });
});
