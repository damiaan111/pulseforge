// Project mutations (src/project/commands.ts, M8).
//
// Two things get the most attention here, because they are the two the risk register names:
// per-aspect editing (PROJECT.md §8.11 — "you edit in vertical and wonder why landscape
// changed") and reference integrity when layers are duplicated or deleted.

import { describe, expect, it } from 'vitest';

import {
  CommandError, addEffect, addLayer, addModulation, clearAspectOverride, clearParamOverride,
  duplicateLayer, findLayer, groupLayers, moveEffect, moveLayer, removeEffect, removeLayer,
  removeModulation, renameLayer, replaceLayer, replaceLook, resetTransform, setEffectParam, setLayerBlend, setLayerFlag,
  setLayerMask, setLayerParam, setLayerTransform, setPaletteColor, ungroupLayer, updateModulation,
} from '../../src/project/commands.ts';
import {
  createBinding, createDocument, createEffect, createGroupLayer, createModuleLayer,
} from '../../src/project/create.ts';
import { walkLayers, type Layer, type ProjectDocument } from '../../src/project/document.ts';
import { createTestIdFactory } from '../../src/project/ids.ts';
import { stringifyDocument } from '../../src/project/serialize.ts';

const K1 = '0000000000K000000000000001';
const K2 = '0000000000K000000000000002';
const G1 = '0000000000G000000000000001';
const E1 = '0000000000E000000000000001';
const E2 = '0000000000E000000000000002';
const M1 = '0000000000M000000000000001';

const bars = (id: string, name = '') => createModuleLayer('core.visualizer.bars', { id, name });

function projectWith(layers: readonly Layer[]): ProjectDocument {
  return { ...createDocument({ timestamp: '2026-09-14T00:00:00.000Z' }), layers };
}

const base = () => projectWith([bars(K1, 'Bars'), bars(K2, 'More bars')]);

const layerIds = (document: ProjectDocument) => [...walkLayers(document.layers)].map(({ layer }) => layer.id);

describe('parameters and aspect overrides (PROJECT.md §8.11, D44)', () => {
  it('writes to the layer itself when editing the base', () => {
    const next = setLayerParam(K1, 'barCount', 32).apply(base());
    expect((findLayer(next, K1) as { params: Record<string, unknown> }).params['barCount']).toBe(32);
    expect(findLayer(next, K1)?.aspectOverrides).toEqual({});
  });

  it('writes to the override when an aspect is active, leaving the base alone', () => {
    // This is the whole feature: editing in vertical must not change landscape.
    const withBase = setLayerParam(K1, 'barCount', 64).apply(base());
    const next = setLayerParam(K1, 'barCount', 20, '9:16').apply(withBase);

    const layer = findLayer(next, K1) as { params: Record<string, unknown> };
    expect(layer.params['barCount']).toBe(64);
    expect(next.layers[0]?.aspectOverrides['9:16']?.params).toEqual({ barCount: 20 });
    expect(next.layers[0]?.aspectOverrides['16:9']).toBeUndefined();
  });

  it('keeps overrides for different aspects apart', () => {
    let document = setLayerParam(K1, 'barCount', 20, '9:16').apply(base());
    document = setLayerParam(K1, 'barCount', 32, '1:1').apply(document);
    expect(document.layers[0]?.aspectOverrides['9:16']?.params).toEqual({ barCount: 20 });
    expect(document.layers[0]?.aspectOverrides['1:1']?.params).toEqual({ barCount: 32 });
  });

  it('resets one parameter to base without disturbing the others', () => {
    let document = setLayerParam(K1, 'barCount', 20, '9:16').apply(base());
    document = setLayerParam(K1, 'maxHeight', 0.3, '9:16').apply(document);
    document = clearParamOverride(K1, 'barCount', '9:16').apply(document);
    expect(document.layers[0]?.aspectOverrides['9:16']?.params).toEqual({ maxHeight: 0.3 });
  });

  it('clears a whole aspect at once', () => {
    let document = setLayerParam(K1, 'barCount', 20, '9:16').apply(base());
    document = setLayerTransform(K1, { y: 0.6 }, '9:16').apply(document);
    document = clearAspectOverride(K1, '9:16').apply(document);
    expect(document.layers[0]?.aspectOverrides).toEqual({});
  });

  it('stores only the transform properties that were edited', () => {
    // An override that froze every property would make later base edits mysteriously ineffective.
    const next = setLayerTransform(K1, { y: 0.62 }, '9:16').apply(base());
    expect(next.layers[0]?.aspectOverrides['9:16']?.transform).toEqual({ y: 0.62 });
  });

  it('refuses to set module parameters on a group', () => {
    const document = projectWith([createGroupLayer([], { id: G1 })]);
    expect(() => setLayerParam(G1, 'barCount', 8).apply(document)).toThrow(CommandError);
  });

  it('names the id when a layer is missing', () => {
    expect(() => setLayerParam('nope', 'x', 1).apply(base())).toThrow(/No layer with id "nope"/);
  });
});

describe('layer properties', () => {
  it('renames, flags, blends and resets the transform', () => {
    let document = renameLayer(K1, 'Lead bars').apply(base());
    document = setLayerFlag(K1, 'soloed', true).apply(document);
    document = setLayerBlend(K1, 'add').apply(document);
    const layer = findLayer(document, K1) as Layer;
    expect(layer.name).toBe('Lead bars');
    expect(layer.soloed).toBe(true);
    expect(layer.blend).toBe('add');

    const moved = setLayerTransform(K1, { x: 0.2, rotationDeg: 30 }).apply(document);
    expect(resetTransform(K1).apply(moved).layers[0]?.transform).toMatchObject({ x: 0.5, rotationDeg: 0 });
  });

  it('labels a flag by what it will do', () => {
    expect(setLayerFlag(K1, 'enabled', false).label).toBe('Hide layer');
    expect(setLayerFlag(K1, 'locked', true).label).toBe('Lock layer');
  });
});

describe('adding, moving and removing layers', () => {
  it('adds at the top by default and at an index when asked', () => {
    const added = addLayer(bars('0000000000K000000000000003')).apply(base());
    expect(layerIds(added)).toEqual([K1, K2, '0000000000K000000000000003']);
    const inserted = addLayer(bars('0000000000K000000000000004'), { index: 0 }).apply(base());
    expect(layerIds(inserted)[0]).toBe('0000000000K000000000000004');
  });

  it('adds into a group', () => {
    const document = projectWith([createGroupLayer([], { id: G1 })]);
    const added = addLayer(bars(K1), { parentId: G1 }).apply(document);
    expect(layerIds(added)).toEqual([G1, K1]);
  });

  it('refuses a duplicate id, which would make every reference ambiguous', () => {
    expect(() => addLayer(bars(K1)).apply(base())).toThrow(/already in this project/);
  });

  it('removes a layer and its children', () => {
    const document = projectWith([createGroupLayer([bars(K1)], { id: G1 }), bars(K2)]);
    expect(layerIds(removeLayer(G1).apply(document))).toEqual([K2]);
  });

  it('clears a mask that pointed at the deleted layer', () => {
    let document = base();
    document = setLayerMask(K2, K1).apply(document);
    expect(findLayer(document, K2)?.maskLayerId).toBe(K1);
    // Leaving it would dangle: the loader would report a broken reference on next open.
    document = removeLayer(K1).apply(document);
    expect(findLayer(document, K2)?.maskLayerId).toBeNull();
  });

  it('refuses a mask that does not exist, and self-masking', () => {
    expect(() => setLayerMask(K1, 'nope').apply(base())).toThrow(CommandError);
    expect(() => setLayerMask(K1, K1).apply(base())).toThrow(/cannot mask itself/);
  });

  it('reorders within the top level and reparents into a group', () => {
    const document = projectWith([bars(K1), bars(K2), createGroupLayer([], { id: G1 })]);
    expect(layerIds(moveLayer(K1, { index: 1 }).apply(document))).toEqual([K2, K1, G1]);
    expect(layerIds(moveLayer(K1, { parentId: G1 }).apply(document))).toEqual([K2, G1, K1]);
  });

  it('indexes into the list with the layer already removed', () => {
    // Worth pinning: a drop indicator counts positions in the list as it looks *now*, which
    // differs by one when a layer moves down within its own parent. moveLayer takes the
    // post-removal index, so the caller does that subtraction.
    const document = projectWith([bars(K1), bars(K2), createGroupLayer([], { id: G1 })]);
    expect(layerIds(moveLayer(K1, { index: 0 }).apply(document))).toEqual([K1, K2, G1]);
    expect(layerIds(moveLayer(K1, { index: 2 }).apply(document))).toEqual([K2, G1, K1]);
    expect(layerIds(moveLayer(K1, { index: 99 }).apply(document))).toEqual([K2, G1, K1]);
  });

  it('refuses to move a group inside itself', () => {
    const inner = createGroupLayer([], { id: '0000000000G000000000000002' });
    const document = projectWith([createGroupLayer([inner], { id: G1 })]);
    expect(() => moveLayer(G1, { parentId: '0000000000G000000000000002' }).apply(document)).toThrow(/inside itself/);
    expect(() => moveLayer(G1, { parentId: G1 }).apply(document)).toThrow(/inside itself/);
  });
});

describe('duplicating', () => {
  const newIds = () => createTestIdFactory('N');

  it('places the copy directly above the original', () => {
    const copied = duplicateLayer(K1, newIds()).apply(base());
    expect(layerIds(copied)).toEqual([K1, '0000000000N000000000000001', K2]);
    expect(findLayer(copied, '0000000000N000000000000001')?.name).toBe('Bars copy');
  });

  it('regenerates every id, because ids are never reused', () => {
    let document = base();
    document = addEffect(K1, createEffect('core.effect.bloom', { id: E1 })).apply(document);
    document = addModulation(K1, createBinding(`layers.${K1}.params.glow`, { id: M1 })).apply(document);

    const copied = duplicateLayer(K1, newIds()).apply(document);
    const copy = copied.layers[1] as Layer;
    expect(copy.id).not.toBe(K1);
    expect(copy.effects[0]?.id).not.toBe(E1);
    expect(copy.modulations[0]?.id).not.toBe(M1);
  });

  it('retargets the copy’s bindings at the copy, not at the original', () => {
    // Otherwise duplicating a layer silently gives you two bindings driving the first one.
    let document = base();
    document = addModulation(K1, createBinding(`layers.${K1}.params.glow`, { id: M1 })).apply(document);
    const copied = duplicateLayer(K1, newIds()).apply(document);
    const copy = copied.layers[1] as Layer;
    expect(copy.modulations[0]?.target).toBe(`layers.${copy.id}.params.glow`);
    expect(copied.layers[0]?.modulations[0]?.target).toBe(`layers.${K1}.params.glow`);
  });

  it('copies a group and everything inside it', () => {
    const document = projectWith([createGroupLayer([bars(K1), bars(K2)], { id: G1 })]);
    const copied = duplicateLayer(G1, newIds()).apply(document);
    expect(layerIds(copied)).toHaveLength(6);
    expect(new Set(layerIds(copied)).size).toBe(6);
  });

  it('produces a document that still serialises cleanly', () => {
    const copied = duplicateLayer(K1, newIds()).apply(base());
    expect(() => stringifyDocument(copied)).not.toThrow();
  });
});

describe('effects', () => {
  const withEffects = () => {
    let document = base();
    document = addEffect(K1, createEffect('core.effect.bloom', { id: E1 })).apply(document);
    document = addEffect(K1, createEffect('core.effect.vignette', { id: E2 })).apply(document);
    return document;
  };

  it('adds in chain order and reorders, because order changes the picture', () => {
    const document = withEffects();
    expect(document.layers[0]?.effects.map((e) => e.id)).toEqual([E1, E2]);
    const moved = moveEffect(K1, E2, 0).apply(document);
    expect(moved.layers[0]?.effects.map((e) => e.id)).toEqual([E2, E1]);
  });

  it('removes, bypasses and edits params', () => {
    let document = withEffects();
    document = setEffectParam(K1, E1, 'intensity', 1.4).apply(document);
    expect(document.layers[0]?.effects[0]?.params['intensity']).toBe(1.4);
    document = removeEffect(K1, E2).apply(document);
    expect(document.layers[0]?.effects).toHaveLength(1);
  });

  it('names the id when an effect is missing', () => {
    expect(() => removeEffect(K1, 'nope').apply(base())).toThrow(/No effect with id "nope"/);
    expect(() => setEffectParam(K1, 'nope', 'x', 1).apply(base())).toThrow(/No effect with id "nope"/);
    expect(() => moveEffect(K1, 'nope', 0).apply(base())).toThrow(/No effect with id "nope"/);
  });
});

describe('modulation bindings', () => {
  it('adds, edits and removes', () => {
    let document = addModulation(K1, createBinding(`layers.${K1}.params.glow`, { id: M1 })).apply(base());
    document = updateModulation(K1, M1, { amount: 2.5, mode: 'multiply' }).apply(document);
    expect(document.layers[0]?.modulations[0]).toMatchObject({ amount: 2.5, mode: 'multiply' });
    document = removeModulation(K1, M1).apply(document);
    expect(document.layers[0]?.modulations).toHaveLength(0);
  });

  it('merges per field, so dragging amount is one undo step but changing mode is another', () => {
    expect(updateModulation(K1, M1, { amount: 1 }).mergeKey)
      .toBe(updateModulation(K1, M1, { amount: 2 }).mergeKey);
    expect(updateModulation(K1, M1, { amount: 1 }).mergeKey)
      .not.toBe(updateModulation(K1, M1, { mode: 'add' }).mergeKey);
  });

  it('names the id when a binding is missing', () => {
    expect(() => updateModulation(K1, 'nope', { amount: 1 }).apply(base())).toThrow(/No binding with id "nope"/);
  });
});

describe('project-level edits', () => {
  it('refuses a palette index that does not exist', () => {
    expect(() => setPaletteColor(0, '#fff').apply(base())).toThrow(/No palette colour at index 0/);
  });

  it('sets a palette colour that does', () => {
    const document = { ...base(), palette: { colors: ['#000000'], roles: {}, extra: {} } };
    expect(setPaletteColor(0, '#ff2d95').apply(document).palette.colors).toEqual(['#ff2d95']);
  });
});

describe('immutability', () => {
  it('leaves the input document untouched, which is what undo depends on', () => {
    const before = base();
    const snapshot = stringifyDocument(before);
    setLayerParam(K1, 'barCount', 99).apply(before);
    setLayerTransform(K1, { x: 0.1 }, '9:16').apply(before);
    removeLayer(K2).apply(before);
    addEffect(K1, createEffect('core.effect.bloom', { id: E1 })).apply(before);
    expect(stringifyDocument(before)).toBe(snapshot);
  });

  it('shares the subtrees it did not touch', () => {
    const before = projectWith([bars(K1), createGroupLayer([bars(K2)], { id: G1 })]);
    const after = setLayerParam(K1, 'barCount', 8).apply(before);
    // Structural sharing is what makes a history of whole documents affordable.
    expect(after.layers[1]).toBe(before.layers[1]);
    expect(after.layers[0]).not.toBe(before.layers[0]);
  });
});


describe('grouping (M38)', () => {
  const K3 = '0000000000K000000000000003';
  const G2 = '0000000000G000000000000002';

  it('wraps layers in place, keeping their order, where the topmost of them was', () => {
    const document = projectWith([bars(K1), bars(K2), bars(K3)]);
    const grouped = groupLayers([K1, K3], createGroupLayer([], { id: G1 })).apply(document);
    expect(grouped.layers.map((l) => l.id)).toEqual([K2, G1]);
    const group = grouped.layers[1]!;
    expect(group.kind === 'group' ? group.children.map((c) => c.id) : []).toEqual([K1, K3]);
  });

  it('groups inside a group, and leaves the rest of that group alone', () => {
    const inner = createGroupLayer([bars(K1), bars(K2)], { id: G1 });
    const document = projectWith([inner]);
    const grouped = groupLayers([K2], createGroupLayer([], { id: G2 })).apply(document);
    const outer = grouped.layers[0]!;
    const children = outer.kind === 'group' ? outer.children : [];
    expect(children.map((c) => c.id)).toEqual([K1, G2]);
  });

  it('refuses layers that live in different groups', () => {
    const document = projectWith([createGroupLayer([bars(K1)], { id: G1 }), bars(K2)]);
    expect(() => groupLayers([K1, K2], createGroupLayer([], { id: G2 })).apply(document)).toThrow(CommandError);
  });

  it('ungroup puts the children back where the group was, in order', () => {
    const document = projectWith([bars(K1), createGroupLayer([bars(K2), bars(K3)], { id: G1 })]);
    const flat = ungroupLayer(G1).apply(document);
    expect(flat.layers.map((l) => l.id)).toEqual([K1, K2, K3]);
  });

  it('ungroup refuses a layer that is not a group, and grouping is undoable by round-trip', () => {
    const document = projectWith([bars(K1), bars(K2)]);
    expect(() => ungroupLayer(K1).apply(document)).toThrow(CommandError);
    const grouped = groupLayers([K1, K2], createGroupLayer([], { id: G1 })).apply(document);
    expect(ungroupLayer(G1).apply(grouped).layers.map((l) => l.id)).toEqual([K1, K2]);
  });
});

describe('applying presets (S8)', () => {
  it('replaceLayer puts the new layer where the old one was, even inside a group', () => {
    const document = projectWith([bars(K1), createGroupLayer([bars(K2)], { id: G1 })]);
    const replacement = createModuleLayer('core.visualizer.orb', { id: M1, name: 'Orb' });
    const next = replaceLayer(K2, replacement).apply(document);
    expect(layerIds(next)).toEqual([K1, G1, M1]);
    expect(findLayer(next, M1)?.name).toBe('Orb');
    expect(() => replaceLayer('missing', replacement).apply(document)).toThrow(CommandError);
  });

  it('replaceLook swaps layers, global effects and palette and nothing else', () => {
    const document = { ...base(), seed: 99 };
    const look = {
      layers: [bars(M1, 'From preset')],
      globalEffects: [createEffect('core.effect.bloom', { id: E1 })],
      palette: { ...document.palette, colors: ['#123456'] },
    };
    const next = replaceLook(look).apply(document);
    expect(next.layers.map((l) => l.id)).toEqual([M1]);
    expect(next.globalEffects.map((e) => e.id)).toEqual([E1]);
    expect(next.palette.colors).toEqual(['#123456']);
    expect({ ...next, layers: document.layers, globalEffects: document.globalEffects, palette: document.palette }).toEqual(document);
  });
});
