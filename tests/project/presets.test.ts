import { describe, expect, it } from 'vitest';

import { createBinding, createDocument, createEffect, createGroupLayer, createModuleLayer } from '../../src/project/create.ts';
import {
  applyLayerPreset,
  createLayerPreset,
  createProjectPreset,
  nonDefaultValues,
  parsePreset,
  PresetError,
  PRESET_FORMAT_VERSION,
  stringifyPreset,
  type ManifestLookup,
} from '../../src/project/presets.ts';

const manifests: ManifestLookup = (id) =>
  ({
    'core.visualizer.bars': {
      version: '1.0.0',
      paramsSchemaVersion: 1,
      defaults: { barCount: 64, glow: 0.4, mode: 'linear', color: { r: 1, g: 0, b: 1, a: 1 } },
    },
    'core.visualizer.rings': {
      version: '1.0.0',
      paramsSchemaVersion: 1,
      defaults: { glow: 0.4, radius: 0.25 },
    },
    'core.fx.bloom': { version: '1.0.0', paramsSchemaVersion: 1, defaults: { intensity: 0.6 } },
  })[id];

let counter = 0;
const newId = () => `id${String(counter++).padStart(3, '0')}`;

function barsLayer() {
  counter = 0;
  const effect = createEffect('core.fx.bloom', { id: 'fx1', params: { intensity: 0.9 } });
  const layer = createModuleLayer('core.visualizer.bars', {
    id: 'layer1',
    name: 'Bars',
    params: { barCount: 96, glow: 0.4, mode: 'radial' },
  });
  return {
    ...layer,
    effects: [effect],
    modulations: [
      createBinding('layers.layer1.params.barCount', { id: 'bind1', amount: 12 }),
      createBinding('layers.layer1.effects.fx1.params.intensity', { id: 'bind2', amount: 0.5 }),
    ],
  };
}

describe('nonDefaultValues', () => {
  it('keeps only what differs, so improved defaults still reach old presets', () => {
    const values = nonDefaultValues('core.visualizer.bars', { barCount: 96, glow: 0.4, mode: 'radial' }, manifests);
    expect(values).toEqual({ barCount: 96, mode: 'radial' }); // glow matched the default
  });

  it('compares objects by value, not by reference', () => {
    const values = nonDefaultValues('core.visualizer.bars', { color: { r: 1, g: 0, b: 1, a: 1 } }, manifests);
    expect(values).toEqual({});
  });

  it('keeps everything for a module it cannot check', () => {
    const values = nonDefaultValues('third.party.thing', { anything: 7 }, manifests);
    expect(values).toEqual({ anything: 7 });
  });
});

describe('createLayerPreset', () => {
  it('stores non-defaults and rewrites targets relative to the layer', () => {
    const preset = createLayerPreset(barsLayer(), manifests);
    expect(preset.formatVersion).toBe(PRESET_FORMAT_VERSION);
    expect(preset.values).toEqual({ barCount: 96, mode: 'radial' });
    expect(preset.effects[0]!.values).toEqual({ intensity: 0.9 });
    expect(preset.modulations.map((binding) => binding.target)).toEqual([
      'self.params.barCount',
      'self.effects.0.params.intensity', // positional: effect ids are regenerated on apply
    ]);
  });

  it('drops binding ids, which belong to the document not the preset', () => {
    const preset = createLayerPreset(barsLayer(), manifests);
    expect(preset.modulations[0]).not.toHaveProperty('id');
  });

  it('refuses a group, whose meaning is its children', () => {
    const group = createGroupLayer([], { id: 'g1', name: 'Group' });
    expect(() => createLayerPreset(group, manifests)).toThrow(PresetError);
  });
});

describe('applyLayerPreset', () => {
  it('rebinds modulations at the new layer, so applying twice does not fight', () => {
    const preset = createLayerPreset(barsLayer(), manifests);
    const target = createModuleLayer('core.visualizer.bars', { id: 'target1' });

    const first = applyLayerPreset(preset, target, { newId, manifests });
    const second = applyLayerPreset(preset, target, { newId, manifests });

    expect(first.layer.id).not.toBe(second.layer.id);
    expect(first.layer.modulations[0]!.target).toBe(`layers.${first.layer.id}.params.barCount`);
    expect(second.layer.modulations[0]!.target).toBe(`layers.${second.layer.id}.params.barCount`);
    // The effect binding resolves to the *new* effect's id, not the saved one.
    expect(first.layer.modulations[1]!.target).toBe(`layers.${first.layer.id}.effects.${first.layer.effects[0]!.id}.params.intensity`);
    expect(first.layer.effects[0]!.id).not.toBe('fx1');
  });

  it('gives every binding and effect a fresh id', () => {
    const preset = createLayerPreset(barsLayer(), manifests);
    const applied = applyLayerPreset(preset, createModuleLayer('core.visualizer.bars'), { newId, manifests });
    const ids = [applied.layer.id, ...applied.layer.effects.map((e) => e.id), ...applied.layer.modulations.map((m) => m.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('replaces the module by default — that is what applying a preset means', () => {
    const preset = createLayerPreset(barsLayer(), manifests);
    const rings = createModuleLayer('core.visualizer.rings', { id: 'r1' });
    const applied = applyLayerPreset(preset, rings, { newId, manifests });
    expect(applied.layer.module).toBe('core.visualizer.bars');
    expect(applied.layer.params).toEqual({ barCount: 96, mode: 'radial' });
  });

  it('keepModule carries across only the shared keys and says what it dropped', () => {
    const preset = createLayerPreset(barsLayer(), manifests);
    const rings = createModuleLayer('core.visualizer.rings', { id: 'r1' });
    const applied = applyLayerPreset(preset, rings, { newId, manifests, keepModule: true });
    // rings keeps being rings; it has no barCount or mode, so both are reported, not lost.
    expect(applied.layer.module).toBe('core.visualizer.rings');
    expect(applied.layer.params).toEqual({});
    expect(applied.notes.join(' ')).toContain('barCount');
    expect(applied.notes.join(' ')).toContain('mode');
  });

  it('reports a module that is not installed instead of failing', () => {
    const preset = createLayerPreset(barsLayer(), manifests);
    const applied = applyLayerPreset(
      { ...preset, module: { id: 'third.party.thing', version: '1', paramsSchemaVersion: 1 } },
      createModuleLayer('core.visualizer.bars'),
      { newId, manifests },
    );
    expect(applied.notes.join(' ')).toContain('not installed');
    expect(applied.layer.module).toBe('third.party.thing'); // preserved, never dropped
  });

  it('reports a params schema version it was not saved for', () => {
    const preset = createLayerPreset(barsLayer(), manifests);
    const applied = applyLayerPreset(
      { ...preset, module: { ...preset.module, paramsSchemaVersion: 99 } },
      createModuleLayer('core.visualizer.bars'),
      { newId, manifests },
    );
    expect(applied.notes.join(' ')).toContain('v99');
  });

  it('styleOnly leaves the target’s own modulations alone', () => {
    const preset = createLayerPreset(barsLayer(), manifests);
    const target = {
      ...createModuleLayer('core.visualizer.bars', { id: 'target1' }),
      modulations: [createBinding('layers.target1.params.glow', { id: 'keep' })],
    };
    const applied = applyLayerPreset(preset, target, { newId, manifests, styleOnly: true });
    expect(applied.layer.modulations.map((m) => m.id)).toEqual(['keep']);
    expect(applied.layer.params).toEqual({ barCount: 96, mode: 'radial' });
  });

  it('keepName preserves the layer’s name', () => {
    const preset = createLayerPreset(barsLayer(), manifests);
    const target = createModuleLayer('core.visualizer.bars', { id: 't', name: 'My layer' });
    expect(applyLayerPreset(preset, target, { newId, manifests }).layer.name).toBe('Bars');
    expect(applyLayerPreset(preset, target, { newId, manifests, keepName: true }).layer.name).toBe('My layer');
  });

  it('refuses a preset from another format version', () => {
    const preset = createLayerPreset(barsLayer(), manifests);
    expect(() =>
      applyLayerPreset({ ...preset, formatVersion: 99 }, createModuleLayer('core.visualizer.bars'), { newId, manifests }),
    ).toThrow(/format 99/);
  });

  it('refuses to apply a layer preset to a group', () => {
    const preset = createLayerPreset(barsLayer(), manifests);
    const group = createGroupLayer([], { id: 'g1', name: 'G' });
    expect(() => applyLayerPreset(preset, group, { newId, manifests })).toThrow(PresetError);
  });

  it('keeps a binding that points outside the preset, and says so', () => {
    const layer = barsLayer();
    const preset = createLayerPreset(
      { ...layer, modulations: [createBinding('layers.somewhereElse.params.x', { id: 'b' })] },
      manifests,
    );
    const applied = applyLayerPreset(preset, createModuleLayer('core.visualizer.bars'), { newId, manifests });
    expect(applied.layer.modulations[0]!.target).toBe('layers.somewhereElse.params.x');
    expect(applied.notes.join(' ')).toContain('outside the preset');
  });
});

describe('project presets', () => {
  it('captures the palette and the top-level module layers', () => {
    const document = {
      ...createDocument({ name: 'Song' }),
      layers: [barsLayer(), createGroupLayer([], { id: 'g', name: 'G' })],
    };
    const preset = createProjectPreset(document, manifests);
    expect(preset.scope).toBe('project');
    expect(preset.name).toBe('Song');
    expect(preset.layers).toHaveLength(1); // the group is skipped, not an error
    expect(preset.palette).toEqual(document.palette);
  });
});

describe('preset files', () => {
  it('round-trips through JSON', () => {
    const preset = createLayerPreset(barsLayer(), manifests);
    const parsed = parsePreset(JSON.parse(stringifyPreset(preset)));
    expect(parsed).toEqual(preset);
  });

  it('says what is wrong rather than throwing a type error later', () => {
    expect(() => parsePreset(null)).toThrow(/not a JSON object/);
    expect(() => parsePreset({})).toThrow(/no format version/);
    expect(() => parsePreset({ formatVersion: 99 })).toThrow(/format 99/);
    expect(() => parsePreset({ formatVersion: PRESET_FORMAT_VERSION, scope: 'nonsense' })).toThrow(/scope/);
  });
});
