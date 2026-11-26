// What a click on a visual does, in the left rail and on a preset card.
//
// These read as choices, so they behave like choices: the one in use is marked, clicking it again
// turns it off, and clicking another swaps it. Stacking is what a compositor is for, but it is a
// deliberate act (Shift+click, or "Add as layer"), not what a second click happens to do. A swap
// only happens within a family: choosing a visualizer must never overwrite the background or lyrics.

import { addLayer, findLayer, removeLayer, replaceLayer } from './commands.ts';
import { createModuleLayer } from './create.ts';
import { walkLayers, type Layer, type ModuleLayer, type ProjectDocument } from './document.ts';
import type { Command } from './history.ts';
import { newLayerPosition } from './layer-order.ts';

export type LayerPick = 'add' | 'swap' | 'remove';
export type KindLookup = (moduleId: string) => string | undefined;

/** Visualizers and 3D scenes are the same choice to a person: the thing that moves to the music. */
function family(kind: string | undefined): string | undefined {
  return kind === 'scene3d' ? 'visualizer' : kind;
}

export function sameFamily(a: string, b: string, kindOf: KindLookup): boolean {
  const left = family(kindOf(a));
  return left !== undefined && left === family(kindOf(b));
}

/** The selected layer, when it is one a click can act on. A locked layer is left alone. */
function target(document: ProjectDocument, selectedLayerId: string | null): ModuleLayer | undefined {
  const layer = selectedLayerId === null ? undefined : findLayer(document, selectedLayerId);
  return layer?.kind === 'module' && !layer.locked ? layer : undefined;
}

export function layerPick(document: ProjectDocument, selectedLayerId: string | null, moduleId: string, kindOf: KindLookup, stack: boolean): LayerPick {
  if (stack) return 'add';
  const selected = target(document, selectedLayerId);
  if (selected === undefined) return 'add';
  if (selected.module === moduleId) return 'remove';
  return sameFamily(selected.module, moduleId, kindOf) ? 'swap' : 'add';
}

export interface PickResult {
  readonly command: Command;
  /** The layer to select afterwards. */
  readonly select: string | null;
  /** Said to the user: bindings that could not survive a swap. */
  readonly note: string | null;
}

/**
 * The picked module in the selected layer's place: its position, timing, opacity and effects stay,
 * since those belong to where it sits. Its parameters and modulations were for the old module, and
 * their loss is named, and undone with the swap.
 */
function swapped(layer: ModuleLayer, moduleId: string, id: string): Layer {
  const fresh = createModuleLayer(moduleId, { id, name: moduleId.split('.').pop() ?? 'Layer' });
  return { ...layer, id, name: fresh.name, module: fresh.module, params: fresh.params, modulations: [], aspectOverrides: {} };
}

export function pickLayer(document: ProjectDocument, selectedLayerId: string | null, moduleId: string, kindOf: KindLookup, stack: boolean, newId: () => string): PickResult {
  const pick = layerPick(document, selectedLayerId, moduleId, kindOf, stack);
  const selected = target(document, selectedLayerId);
  if (pick === 'remove' && selected !== undefined) {
    return { command: { ...removeLayer(selected.id), label: `Remove ${selected.name}` }, select: null, note: null };
  }
  if (pick === 'swap' && selected !== undefined) {
    const layer = swapped(selected, moduleId, newId());
    const lost = selected.modulations.length;
    return {
      command: replaceLayer(selected.id, layer, `Swap ${selected.name} for ${layer.name}`),
      select: layer.id,
      note: lost === 0 ? null : `${lost} modulation${lost === 1 ? '' : 's'} on ${selected.name} went with it; undo brings them back.`,
    };
  }
  const layer = createModuleLayer(moduleId, { id: newId(), name: moduleId.split('.').pop() ?? 'Layer' });
  return { command: addLayer(layer, newLayerPosition(document, moduleId)), select: layer.id, note: null };
}

/** The layer a preset is showing as, if any: named after it, with its module. */
export function presetLayer(document: ProjectDocument, preset: { readonly name: string; readonly moduleId: string | undefined }): ModuleLayer | undefined {
  for (const { layer } of walkLayers(document.layers)) {
    if (layer.kind === 'module' && layer.module === preset.moduleId && layer.name === preset.name) return layer;
  }
  return undefined;
}

const MILKDROP_MODULE = 'core.visualizer.milkdrop';

/** The layer showing a MilkDrop preset, if any. */
export function milkdropLayer(document: ProjectDocument, preset: string): ModuleLayer | undefined {
  for (const { layer } of walkLayers(document.layers)) {
    if (layer.kind === 'module' && layer.module === MILKDROP_MODULE && layer.params['preset'] === preset) return layer;
  }
  return undefined;
}

/** The MilkDrop layer on top that can still be changed. */
function topMilkdropLayer(document: ProjectDocument): ModuleLayer | undefined {
  let top: ModuleLayer | undefined;
  for (const { layer } of walkLayers(document.layers)) {
    if (layer.kind === 'module' && layer.module === MILKDROP_MODULE && !layer.locked) top = layer;
  }
  return top;
}

/** A click on a MilkDrop card: the same rules as `pickLayer`, with the preset as the choice. */
export function pickMilkdrop(document: ProjectDocument, selectedLayerId: string | null, preset: string, kindOf: KindLookup, stack: boolean, newId: () => string): PickResult {
  const inUse = stack ? undefined : milkdropLayer(document, preset);
  if (inUse !== undefined && !inUse.locked) return { command: { ...removeLayer(inUse.id), label: `Remove ${preset}` }, select: null, note: null };

  // With nothing selected a click means the picture already there, not a second one over it.
  const selected = target(document, selectedLayerId) ?? (stack ? undefined : topMilkdropLayer(document));
  if (!stack && selected?.module === MILKDROP_MODULE) {
    const layer: ModuleLayer = { ...selected, name: preset, params: { ...selected.params, preset } };
    return { command: replaceLayer(selected.id, layer, `Use ${preset}`), select: selected.id, note: null };
  }
  const result = pickLayer(document, selectedLayerId, MILKDROP_MODULE, kindOf, stack, newId);
  const named = (layer: Layer): Layer => (layer.kind === 'module' && layer.module === MILKDROP_MODULE ? { ...layer, name: preset, params: { ...layer.params, preset } } : layer);
  const id = result.select;
  return {
    ...result,
    command: {
      label: `Use ${preset}`,
      apply: (current) => {
        const next = result.command.apply(current);
        return { ...next, layers: next.layers.map((layer) => (layer.id === id ? named(layer) : layer)) };
      },
    },
  };
}

