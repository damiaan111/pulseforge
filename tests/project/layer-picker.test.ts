// A click on a visual: marked when in use, off when clicked again, swapped for another, and stacked
// only on purpose. Never overwrites a different kind of layer.

import { describe, expect, it } from 'vitest';

import { BUILTIN_MODULES } from '../../src/engine/engine.ts';
import { addLayer, setLayerFlag } from '../../src/project/commands.ts';
import { createBinding, createDocument, createModuleLayer } from '../../src/project/create.ts';
import { layerPick, milkdropLayer, pickLayer, pickMilkdrop, presetLayer, type KindLookup } from '../../src/project/layer-picker.ts';
import type { ProjectDocument } from '../../src/project/document.ts';

const kindOf: KindLookup = (id) => BUILTIN_MODULES.find((m) => m.manifest.id === id)?.manifest.kind;
const BARS = 'core.visualizer.bars';
const WAVES = 'core.visualizer.waves';
const TEXT = 'core.text.title';
const BACKGROUND = 'core.source.background';
const SHAPES = 'core.scene3d.shapes';
let ids = 0;
const newId = () => `NEW${ids++}`;

function withLayer(module: string): ProjectDocument {
  return addLayer(createModuleLayer(module, { id: 'L', name: 'first' })).apply(createDocument({ name: 'Song' }));
}

describe('what a click does', () => {
  it('adds when nothing is selected', () => {
    expect(layerPick(createDocument({ name: 'Song' }), null, BARS, kindOf, false)).toBe('add');
  });

  it('turns off the one in use', () => {
    expect(layerPick(withLayer(BARS), 'L', BARS, kindOf, false)).toBe('remove');
  });

  it('swaps for another of the same family, 3D scenes included', () => {
    expect(layerPick(withLayer(BARS), 'L', WAVES, kindOf, false)).toBe('swap');
    expect(layerPick(withLayer(BARS), 'L', SHAPES, kindOf, false)).toBe('swap');
  });

  it('never overwrites a different kind of layer', () => {
    expect(layerPick(withLayer(TEXT), 'L', BARS, kindOf, false)).toBe('add');
    expect(layerPick(withLayer(BACKGROUND), 'L', BARS, kindOf, false)).toBe('add');
  });

  it('stacks only when asked', () => {
    expect(layerPick(withLayer(BARS), 'L', WAVES, kindOf, true)).toBe('add');
    expect(layerPick(withLayer(BARS), 'L', BARS, kindOf, true)).toBe('add');
  });

  it('leaves a locked layer alone', () => {
    const locked = setLayerFlag('L', 'locked', true).apply(withLayer(BARS));
    expect(layerPick(locked, 'L', BARS, kindOf, false)).toBe('add');
    expect(layerPick(locked, 'L', WAVES, kindOf, false)).toBe('add');
  });
});

describe('applying the click', () => {
  it('removes, and selects nothing', () => {
    const result = pickLayer(withLayer(BARS), 'L', BARS, kindOf, false, newId);
    expect(result.command.apply(withLayer(BARS)).layers).toEqual([]);
    expect(result.select).toBeNull();
  });

  it('swaps in place: one layer before, one after, with its opacity kept', () => {
    const before = withLayer(BARS);
    const dimmed = { ...before, layers: before.layers.map((layer) => ({ ...layer, opacity: 0.4 })) };
    const result = pickLayer(dimmed, 'L', WAVES, kindOf, false, newId);
    const after = result.command.apply(dimmed);
    expect(after.layers).toHaveLength(1);
    expect(after.layers[0]).toMatchObject({ module: WAVES, opacity: 0.4 });
    expect(result.select).toBe(after.layers[0]?.id);
  });

  it('names the modulations a swap cost', () => {
    const before = withLayer(BARS);
    const bound = { ...before, layers: before.layers.map((layer) => ({ ...layer, modulations: [createBinding('layers.L.params.x')] })) };
    expect(pickLayer(bound, 'L', WAVES, kindOf, false, newId).note).toMatch(/1 modulation on first/);
  });
});

describe('which preset is in use', () => {
  it('is the layer named after it, with its module', () => {
    const document = withLayer(BARS);
    expect(presetLayer(document, { name: 'first', moduleId: BARS })?.id).toBe('L');
    expect(presetLayer(document, { name: 'first', moduleId: WAVES })).toBeUndefined();
    expect(presetLayer(document, { name: 'other', moduleId: BARS })).toBeUndefined();
  });
});

describe('a MilkDrop card', () => {
  const MILKDROP = 'core.visualizer.milkdrop';
  const empty = createDocument({ name: 'Song' });

  it('adds a layer showing the preset, named after it', () => {
    const result = pickMilkdrop(empty, null, 'Geiss - Chrome', kindOf, false, newId);
    const after = result.command.apply(empty);
    expect(after.layers).toHaveLength(1);
    expect(after.layers[0]).toMatchObject({ module: MILKDROP, name: 'Geiss - Chrome', id: result.select });
    expect(milkdropLayer(after, 'Geiss - Chrome')?.params['preset']).toBe('Geiss - Chrome');
  });

  it('swaps the preset on the selected MilkDrop layer, keeping the layer', () => {
    const one = pickMilkdrop(empty, null, 'One', kindOf, false, newId);
    const first = one.command.apply(empty);
    const two = pickMilkdrop(first, one.select, 'Two', kindOf, false, newId);
    const after = two.command.apply(first);
    expect(after.layers).toHaveLength(1);
    expect(after.layers[0]?.id).toBe(one.select);
    expect(milkdropLayer(after, 'One')).toBeUndefined();
    expect(milkdropLayer(after, 'Two')).toBeDefined();
  });

  it('takes the place of another visual, and never of a background', () => {
    const bars = withLayer(BARS);
    expect(pickMilkdrop(bars, 'L', 'One', kindOf, false, newId).command.apply(bars).layers).toHaveLength(1);
    const background = withLayer(BACKGROUND);
    expect(pickMilkdrop(background, 'L', 'One', kindOf, false, newId).command.apply(background).layers).toHaveLength(2);
  });

  it('turns off when clicked again, and stacks with Shift', () => {
    const one = pickMilkdrop(empty, null, 'One', kindOf, false, newId);
    const first = one.command.apply(empty);
    expect(pickMilkdrop(first, one.select, 'One', kindOf, false, newId).command.apply(first).layers).toHaveLength(0);
    expect(pickMilkdrop(first, one.select, 'Two', kindOf, true, newId).command.apply(first).layers).toHaveLength(2);
  });
});

