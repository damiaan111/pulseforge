// Applying a preset from the browser (S8, ui-spec §5): one undoable command per action.
//
// The ways to apply, and what each keeps:
//
//   layer presets     add           a new layer of the preset's module, on top
//                     replace       the selected layer becomes the preset (new id, new module)
//                     style         the preset's look, the selected layer's own modulations kept
//                     modulations   the selected layer kept whole, the preset's modulations added
//   project presets   look          layers, global effects and palette replaced
//                     merge         the preset's layers added above the current ones
//
// Pure apart from the id source, so the browser's behaviour is testable without a window. Notes
// from applying (a module not installed, a binding that will not resolve) come back to be shown:
// nothing about a preset is dropped silently (CLAUDE.md constraint 4).

import { addLayer, findLayer, replaceLayer, replaceLook, CommandError } from './commands.ts';
import { createModuleLayer } from './create.ts';
import type { ProjectDocument } from './document.ts';
import type { Command } from './history.ts';
import { applyLayerPreset, applyProjectPreset, type ManifestLookup, type Preset } from './presets.ts';

export type PresetApplyMode = 'add' | 'replace' | 'style' | 'modulations' | 'look' | 'merge';

export interface PresetApplication {
  readonly command: Command;
  readonly notes: readonly string[];
  /** The layer to select afterwards, if the action made or remade one. */
  readonly select: string | null;
}

/** What a plain click on a card does: replace the selected layer if there is one, else add. */
export function defaultApplyMode(preset: Preset, document: ProjectDocument, selectedLayerId: string | null): PresetApplyMode {
  if (preset.scope === 'project') return 'look';
  const selected = selectedLayerId === null ? undefined : findLayer(document, selectedLayerId);
  return selected?.kind === 'module' ? 'replace' : 'add';
}

export function applyPreset(
  preset: Preset,
  mode: PresetApplyMode,
  context: {
    readonly document: ProjectDocument;
    readonly selectedLayerId: string | null;
    readonly manifests: ManifestLookup;
    readonly newId: () => string;
  },
): PresetApplication {
  const { document, selectedLayerId, manifests, newId } = context;
  const label = `Apply preset “${preset.name}”`;

  if (preset.scope === 'project') {
    if (mode !== 'look' && mode !== 'merge') throw new CommandError(`A project preset cannot be applied as "${mode}".`);
    const applied = applyProjectPreset(preset, document, { newId, manifests, merge: mode === 'merge' });
    return { command: replaceLook(applied.document, label), notes: applied.notes, select: null };
  }

  if (mode === 'add') {
    const target = createModuleLayer(preset.module.id, { id: newId(), name: preset.name });
    const applied = applyLayerPreset(preset, target, { newId, manifests });
    // Labelled with the preset, like every other apply, so the undo history says what happened.
    return { command: { ...addLayer(applied.layer), label }, notes: applied.notes, select: applied.layer.id };
  }

  const target = selectedLayerId === null ? undefined : findLayer(document, selectedLayerId);
  if (target === undefined || target.kind !== 'module') {
    throw new CommandError('Select a layer to apply this preset to, or add it as a new layer.');
  }
  if (target.locked) {
    throw new CommandError(`"${target.name}" is locked. Unlock it to apply a preset to it, or add the preset as a new layer.`);
  }
  if (mode !== 'replace' && mode !== 'style' && mode !== 'modulations') {
    throw new CommandError(`A layer preset cannot be applied as "${mode}".`);
  }
  const applied = applyLayerPreset(preset, target, {
    newId,
    manifests,
    ...(mode === 'style' ? { styleOnly: true, keepName: true } : {}),
    ...(mode === 'modulations' ? { modulationsOnly: true } : {}),
  });
  return { command: replaceLayer(target.id, applied.layer, label), notes: applied.notes, select: applied.layer.id };
}
