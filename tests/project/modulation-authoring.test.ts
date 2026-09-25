import { GLOBAL_OWNER } from '../../src/project/commands.ts';
// Making and describing bindings in the studio (M13, modulation-spec §10–§11).

import { describe, expect, it } from 'vitest';

import { compileModulation, modulateValue } from '../../src/engine/core/modulation.ts';
import type { ParamSpec } from '../../src/engine/core/params.ts';
import { createBinding, createDocument, createEffect, createModuleLayer } from '../../src/project/create.ts';
import type { ProjectDocument } from '../../src/project/document.ts';
import {
  RECIPES, allBindings, defaultBinding, describeSource, describeTarget, effectParamTarget, isImperceptible,
  isModulatable, layerParamTarget, paramSpan, parseTarget, suggestedSources, type SchemaLookup,
} from '../../src/project/modulation-authoring.ts';

const glow: ParamSpec = { key: 'glow', label: 'Glow', group: 'Look', type: 'float', default: 0.4, min: 0, max: 2, softMax: 1 };
const count: ParamSpec = { key: 'barCount', label: 'Bar count', group: 'Shape', type: 'int', default: 64, min: 8, max: 128 };
const scale: ParamSpec = { key: 'scale', label: 'Scale', group: 'Shape', type: 'float', default: 1, min: 0, max: 4 };
const hue: ParamSpec = { key: 'hue', label: 'Hue', group: 'Look', type: 'float', default: 0, min: 0, max: 360 };
const mode: ParamSpec = { key: 'mode', label: 'Mode', group: 'Look', type: 'enum', default: 'a', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }, { value: 'c', label: 'C' }] };
const colour: ParamSpec = { key: 'fill', label: 'Fill', group: 'Look', type: 'color', default: '#ffffff' };
const locked: ParamSpec = { ...glow, key: 'fixed', modulatable: false };

let counter = 0;
const newId = () => `B${counter++}`;

const L1 = '0000000000L000000000000001';
const E1 = '0000000000E000000000000001';

const schemas: SchemaLookup = (id) => ({
  'core.visualizer.bars': { name: 'Bars', params: [glow, count] },
  'core.effect.bloom': { name: 'Bloom', params: [{ ...glow, key: 'intensity', label: 'Intensity' }] },
} as Record<string, ReturnType<SchemaLookup>>)[id];

function document(): ProjectDocument {
  const layer = {
    ...createModuleLayer('core.visualizer.bars', { id: L1, name: 'Bars' }),
    effects: [createEffect('core.effect.bloom', { id: E1 })],
    modulations: [createBinding(layerParamTarget(L1, 'glow'), { id: 'M1' })],
  };
  return { ...createDocument({ timestamp: '2026-01-01T00:00:00.000Z' }), layers: [layer] };
}

describe('what can be modulated, and by how much', () => {
  it('measures amounts against the range the slider shows', () => {
    expect(paramSpan(glow)).toBe(1); // softMax, not the hard 2
    expect(paramSpan(count)).toBe(120);
    expect(paramSpan(mode)).toBe(2);
    expect(paramSpan(colour)).toBe(0);
  });

  it('offers numbers and discrete values, not colours or opted-out parameters', () => {
    expect(isModulatable(glow)).toBe(true);
    expect(isModulatable(mode)).toBe(true);
    expect(isModulatable(colour)).toBe(false);
    expect(isModulatable(locked)).toBe(false);
  });

  it('offers likely sources first for the kind of parameter', () => {
    expect(suggestedSources(scale)[0]).toBe('onset');
    expect(suggestedSources(glow)[0]).toBe('rms');
    expect(suggestedSources(hue)[0]).toBe('centroid');
  });

  it('a new binding adds a quarter of the range, in the parameter’s own units', () => {
    const b = defaultBinding(layerParamTarget(L1, 'barCount'), count, { newId });
    expect(b.amount).toBe(30);
    expect(b.mode).toBe('add');
    expect(b.inputRange).toBe('auto');
    const band = defaultBinding(layerParamTarget(L1, 'glow'), glow, { newId, sourceType: 'band' });
    expect(band.source).toMatchObject({ type: 'band', band: 'bass' });
  });
});

describe('recipes', () => {
  it('each makes a binding the evaluator accepts, scaled to the parameter, and labelled', () => {
    const analysis = { sources: new Map() };
    for (const recipe of RECIPES) {
      const b = recipe.make(layerParamTarget(L1, 'glow'), glow, newId);
      expect(b.label).toBe(recipe.name);
      expect(Number.isFinite(b.amount)).toBe(true);
      // Generators compile with no audio; audio sources are reported (not thrown) without it.
      const program = compileModulation({ bindings: [b], analysis, durationSeconds: 10, seed: 1 });
      if (['lfo', 'noise', 'ramp', 'progress'].includes(b.source.type)) {
        expect(program.issues).toEqual([]);
        expect(Number.isFinite(modulateValue(program, b.target, 0.4, 3))).toBe(true);
      } else if (['lyricActive', 'lineProgress', 'wordActive'].includes(b.source.type)) {
        // Lyric sources are reported without timed lyrics, and live with them.
        expect(program.issues.map((i) => i.problem)).toEqual(['unsupported']);
        const lyrics = { lines: [{ id: 'l', text: 'one two', startTicks: 48_000, endTicks: 96_000, role: 'lead', words: [], style: null }], untimedLines: 0 };
        const live = compileModulation({ bindings: [b], analysis, durationSeconds: 10, seed: 1, lyrics });
        expect(live.issues).toEqual([]);
        expect(modulateValue(live, b.target, 0.4, 1.5)).not.toBe(modulateValue(live, b.target, 0.4, 8));
      } else {
        expect(program.issues.map((i) => i.problem)).toEqual(['missing-stem']);
      }
    }
  });

  it('scale with the parameter they are applied to', () => {
    const kick = RECIPES.find((r) => r.id === 'kick-pump')!;
    expect(kick.make('x', glow, newId).amount).toBeCloseTo(0.15);
    expect(kick.make('x', count, newId).amount).toBe(18);
  });
});

describe('reading bindings back', () => {
  it('parses both kinds of target path', () => {
    expect(parseTarget(layerParamTarget(L1, 'glow'))).toEqual({ layerId: L1, effectId: null, key: 'glow' });
    expect(parseTarget(effectParamTarget(L1, E1, 'intensity'))).toEqual({ layerId: L1, effectId: E1, key: 'intensity' });
    expect(parseTarget('global.effects.x.params.y')).toEqual({ layerId: GLOBAL_OWNER, effectId: 'x', key: 'y' });
    expect(effectParamTarget(GLOBAL_OWNER, 'x', 'y')).toBe('global.effects.x.params.y');
    expect(parseTarget('global.params.y')).toBeUndefined();
    expect(parseTarget('layers.K1.opacity')).toEqual({ layerId: 'K1', effectId: null, key: 'opacity', layerProperty: true });
  });

  it('describes targets in the UI’s words, and says why a broken one is broken', () => {
    const doc = document();
    expect(describeTarget(doc, layerParamTarget(L1, 'glow'), schemas)).toMatchObject({ label: 'Bars › Glow', problem: null });
    expect(describeTarget(doc, effectParamTarget(L1, E1, 'intensity'), schemas)).toMatchObject({ label: 'Bars › Bloom › Intensity', problem: null });
    expect(describeTarget(doc, layerParamTarget(L1, 'gone'), schemas).problem).toContain('no parameter "gone"');
    expect(describeTarget(doc, effectParamTarget(L1, 'nope', 'intensity'), schemas).problem).toContain('effect was removed');
    expect(describeTarget(doc, layerParamTarget('missing', 'glow'), schemas).problem).toContain('layer no longer exists');
  });

  it('lists every binding with the layer that stores it', () => {
    expect(allBindings(document()).map((r) => [r.ownerId, r.binding.id])).toEqual([[L1, 'M1']]);
  });

  it('flags a binding too weak to see', () => {
    const b = createBinding('x', { amount: 0.005 });
    expect(isImperceptible(b, glow)).toBe(true);
    expect(isImperceptible({ ...b, amount: 0.2 }, glow)).toBe(false);
    expect(isImperceptible({ ...b, mode: 'multiply', amount: 0.5 }, glow)).toBe(false);
    expect(isImperceptible({ ...b, mode: 'replace' }, glow)).toBe(false);
  });

  it('says what drives a binding in one line', () => {
    const b = createBinding('x', { sourceType: 'onset', stem: 'drums' });
    expect(describeSource(b)).toBe('Onsets · drums');
    expect(describeSource({ ...b, source: { ...b.source, type: 'band', band: 'bass', stem: 'mix' } })).toBe('bass band · mix');
    expect(describeSource({ ...b, source: { ...b.source, type: 'lfo', shape: 'sine', rateHz: 0.25 } })).toBe('LFO sine 0.25 Hz');
  });
});
