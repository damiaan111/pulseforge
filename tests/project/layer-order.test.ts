// Nudging and dragging layers in the list (M9): positions for moveLayer, checked by applying them.

import { describe, expect, it } from 'vitest';

import { BUILTIN_MODULES } from '../../src/engine/engine.ts';
import { addLayer, moveLayer } from '../../src/project/commands.ts';
import { createDocument, createGroupLayer, createModuleLayer } from '../../src/project/create.ts';
import { type Layer, type ProjectDocument } from '../../src/project/document.ts';
import { displayOrder, dropPosition, newLayerPosition, stepPosition } from '../../src/project/layer-order.ts';
import { pickLayer, pickMilkdrop, type KindLookup } from '../../src/project/layer-picker.ts';

const bars = (id: string) => createModuleLayer('core.visualizer.bars', { id, name: id });
const kindOf: KindLookup = (id) => BUILTIN_MODULES.find((m) => m.manifest.id === id)?.manifest.kind;

function doc(layers: Layer[]): ProjectDocument {
  return { ...createDocument({ timestamp: '2026-01-01T00:00:00.000Z' }), layers };
}

/** The list as the UI shows it: top first, each group's row above its indented children. */
function shown(document: ProjectDocument): string[] {
  return displayOrder(document.layers).map(({ layer, depth }) => `${'  '.repeat(depth)}${layer.id}`);
}

function applied(document: ProjectDocument, id: string, position: ReturnType<typeof stepPosition>): ProjectDocument {
  expect(position).toBeDefined();
  return moveLayer(id, position!).apply(document);
}

describe('stepping a layer up or down', () => {
  // Stored bottom-first: A is the bottom layer, C the top.
  const base = doc([bars('A'), bars('B'), bars('C')]);

  it('moves one place in the list each way', () => {
    expect(shown(base)).toEqual(['C', 'B', 'A']);
    expect(shown(applied(base, 'A', stepPosition(base, 'A', 'up')))).toEqual(['C', 'A', 'B']);
    expect(shown(applied(base, 'C', stepPosition(base, 'C', 'down')))).toEqual(['B', 'C', 'A']);
  });

  it('has nowhere to go past either end', () => {
    expect(stepPosition(base, 'C', 'up')).toBeUndefined();
    expect(stepPosition(base, 'A', 'down')).toBeUndefined();
  });

  it('stays inside its group', () => {
    const grouped = doc([bars('A'), createGroupLayer([bars('X'), bars('Y')], { id: 'G' })]);
    expect(shown(applied(grouped, 'X', stepPosition(grouped, 'X', 'up')))).toEqual(['G', '  X', '  Y', 'A']);
    expect(stepPosition(grouped, 'Y', 'up')).toBeUndefined();
  });
});

describe('where a new layer lands', () => {
  const lyrics = (id: string) => createModuleLayer('core.text.lyrics', { id, name: id });
  const title = (id: string) => createModuleLayer('core.text.title', { id, name: id });
  const added = (document: ProjectDocument, module: string) =>
    shown(addLayer(createModuleLayer(module, { id: 'NEW', name: 'new' }), newLayerPosition(document, module)).apply(document));
  const BARS = 'core.visualizer.bars';

  it('goes on top when there are no words', () => {
    expect(added(doc([bars('A')]), BARS)).toEqual(['NEW', 'A']);
    expect(added(doc([]), BARS)).toEqual(['NEW']);
  });

  it('stays under the words, the whole block of them', () => {
    expect(added(doc([bars('A'), lyrics('L')]), BARS)).toEqual(['L', 'NEW', 'A']);
    expect(added(doc([bars('A'), title('T'), lyrics('L')]), BARS)).toEqual(['L', 'T', 'NEW', 'A']);
  });

  it('leaves what sits above the words above them', () => {
    expect(added(doc([bars('A'), lyrics('L'), bars('FLASH')]), BARS)).toEqual(['FLASH', 'L', 'NEW', 'A']);
  });

  it('counts a group holding words, and does not go under words already buried', () => {
    const grouped = doc([bars('A'), createGroupLayer([lyrics('L')], { id: 'G' })]);
    expect(added(grouped, BARS)).toEqual(['G', '  L', 'NEW', 'A']);
    expect(added(doc([title('T'), bars('A'), lyrics('L')]), BARS)).toEqual(['L', 'NEW', 'A', 'T']);
  });

  it('puts words themselves on top', () => {
    expect(added(doc([bars('A'), lyrics('L')]), 'core.text.title')).toEqual(['NEW', 'L', 'A']);
  });

  it('a layer turned off and on again comes back under the lyrics', () => {
    const song = doc([bars('A'), lyrics('L')]);
    const off = pickLayer(song, 'A', BARS, kindOf, false, () => 'B').command.apply(song);
    expect(shown(off)).toEqual(['L']);
    const on = pickLayer(off, null, BARS, kindOf, false, () => 'B').command.apply(off);
    expect(shown(on)).toEqual(['L', 'B']);
  });

  it('does the same for a MilkDrop card', () => {
    const song = doc([bars('A'), lyrics('L')]);
    const on = pickMilkdrop(song, null, 'One', kindOf, false, () => 'M').command.apply(song);
    expect(shown(on)).toEqual(['L', 'M', 'A']);
  });
});

describe('dropping a layer onto another row', () => {
  const base = doc([bars('A'), bars('B'), bars('C'), bars('D')]);

  it('lands directly above the row it was dropped on, from either direction', () => {
    expect(shown(base)).toEqual(['D', 'C', 'B', 'A']);
    expect(shown(applied(base, 'A', dropPosition(base, 'A', 'C')))).toEqual(['D', 'A', 'C', 'B']);
    expect(shown(applied(base, 'D', dropPosition(base, 'D', 'B')))).toEqual(['C', 'D', 'B', 'A']);
  });

  it('ignores a drop that changes nothing, or onto itself', () => {
    // B is directly below C, so "above B" is where C already is.
    expect(dropPosition(base, 'C', 'B')).toBeUndefined();
    expect(dropPosition(base, 'B', 'B')).toBeUndefined();
  });

  it('moves into another group, and never into its own children', () => {
    const grouped = doc([bars('A'), createGroupLayer([bars('X'), bars('Y')], { id: 'G' })]);
    expect(shown(applied(grouped, 'A', dropPosition(grouped, 'A', 'X')))).toEqual(['G', '  Y', '  A', '  X']);
    expect(dropPosition(grouped, 'G', 'X')).toBeUndefined();
  });
});
