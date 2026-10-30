// Every project mutation, as a pure function of the document (M8, ui-spec §10).
//
// Each factory returns a `Command` for `History.run`. They never mutate: they rebuild the path
// from the document root to the thing being changed and share everything else, which is what
// makes storing whole documents in the undo stack cheap.
//
// **Aspect-aware editing (D44, PROJECT.md §8.11).** Most edits take an `EditTarget`: `'base'`
// writes the layer's own value, an aspect bucket writes that aspect's override. This is the
// mechanism behind "editing while 9:16 is active writes to the 9:16 override", and the risk
// register calls it out as the most likely confusion the multi-format feature creates — so it
// is explicit in the API rather than implied by some ambient mode. The inspector is expected to
// show which target is active and offer reset-to-base (`clearAspectOverride`).
//
// A command aimed at an id that does not exist throws: ids come from the live document, so a
// miss is a bug in the caller, not a condition to paper over.

import type { BeatRefinement } from '../analysis/beat-refinement.ts';
import {
  IDENTITY_TRANSFORM, walkLayers,
  type AspectBucket, type AspectOverride, type AssetRef, type EffectSpec, type GroupLayer, type Layer,
  type MaskSettings, type ModulationBinding, type ModuleLayer, type ProjectDocument, type Transform,
} from './document.ts';
import type { Command } from './history.ts';

export class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandError';
  }
}

/** Where an edit lands: the layer's own value, or one aspect's override. */
export type EditTarget = 'base' | AspectBucket;

// ---------------------------------------------------------------------------
// Layer-tree plumbing
// ---------------------------------------------------------------------------

/** Rebuilds the tree with `id` replaced by `fn(layer)`. Returns undefined when `id` is absent. */
function mapLayer(
  layers: readonly Layer[],
  id: string,
  fn: (layer: Layer) => Layer,
): readonly Layer[] | undefined {
  let changed = false;
  const next = layers.map((layer) => {
    if (layer.id === id) {
      changed = true;
      return fn(layer);
    }
    if (layer.kind === 'group') {
      const children = mapLayer(layer.children, id, fn);
      if (children !== undefined) {
        changed = true;
        return { ...layer, children };
      }
    }
    return layer;
  });
  return changed ? next : undefined;
}

/** Rebuilds the tree without `id`. Returns undefined when `id` is absent. */
function dropLayer(layers: readonly Layer[], id: string): readonly Layer[] | undefined {
  let changed = false;
  const next: Layer[] = [];
  for (const layer of layers) {
    if (layer.id === id) {
      changed = true;
      continue;
    }
    if (layer.kind === 'group') {
      const children = dropLayer(layer.children, id);
      if (children !== undefined) {
        changed = true;
        next.push({ ...layer, children });
        continue;
      }
    }
    next.push(layer);
  }
  return changed ? next : undefined;
}

export function findLayer(document: ProjectDocument, id: string): Layer | undefined {
  for (const { layer } of walkLayers(document.layers)) {
    if (layer.id === id) return layer;
  }
  return undefined;
}

function requireLayer(document: ProjectDocument, id: string): Layer {
  const layer = findLayer(document, id);
  if (layer === undefined) throw new CommandError(`No layer with id "${id}" in this project`);
  return layer;
}

/** Applies `fn` to one layer, or throws naming the id. */
function withLayer(document: ProjectDocument, id: string, fn: (layer: Layer) => Layer): ProjectDocument {
  const layers = mapLayer(document.layers, id, fn);
  if (layers === undefined) throw new CommandError(`No layer with id "${id}" in this project`);
  return { ...document, layers };
}

/**
 * The owner id of the project's own effect chain and its bindings (`document.globalEffects`,
 * `globalModulations`) — the post chain over the finished composite. Effect and modulation commands
 * take it wherever they take a layer id, so the one effect-chain editor serves both.
 */
export const GLOBAL_OWNER = 'global';

/**
 * Like `withLayer`, for the commands that only touch an owner's `effects` and `modulations`: a layer,
 * or the global chain when `ownerId` is `GLOBAL_OWNER`.
 */
function withChainOwner(document: ProjectDocument, ownerId: string, fn: (owner: Layer) => Layer): ProjectDocument {
  if (ownerId !== GLOBAL_OWNER) return withLayer(document, ownerId, fn);
  // The global chain has no layer around it; the functions below read and rebuild only these two.
  const owner = fn({ effects: document.globalEffects, modulations: document.globalModulations } as unknown as Layer);
  return { ...document, globalEffects: owner.effects, globalModulations: owner.modulations };
}

const EMPTY_OVERRIDE: AspectOverride = { transform: {}, params: {}, extra: {} };

function withOverride(layer: Layer, aspect: AspectBucket, fn: (override: AspectOverride) => AspectOverride): Layer {
  const existing = layer.aspectOverrides[aspect] ?? EMPTY_OVERRIDE;
  return { ...layer, aspectOverrides: { ...layer.aspectOverrides, [aspect]: fn(existing) } };
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

/**
 * Sets one module parameter. Mergeable: a slider drag collapses into a single undo step, keyed
 * on the layer, the parameter *and* the target, so dragging in 16:9 and then in 9:16 stays two
 * steps — they are edits to two different stored values.
 */
export function setLayerParam(
  layerId: string,
  key: string,
  value: unknown,
  target: EditTarget = 'base',
): Command {
  return {
    label: `Set ${key}`,
    mergeKey: `param:${layerId}:${key}:${target}`,
    apply: (document) => withLayer(document, layerId, (layer) => {
      if (layer.kind !== 'module') {
        throw new CommandError(`Layer "${layerId}" is a group and has no module parameters`);
      }
      if (target === 'base') return { ...layer, params: { ...layer.params, [key]: value } };
      return withOverride(layer, target, (override) => ({ ...override, params: { ...override.params, [key]: value } }));
    }),
  };
}

/** Removes an aspect override for one parameter, so it inherits the base again. */
export function clearParamOverride(layerId: string, key: string, aspect: AspectBucket): Command {
  return {
    label: `Reset ${key} to base`,
    apply: (document) => withLayer(document, layerId, (layer) => {
      const override = layer.aspectOverrides[aspect];
      if (override === undefined || !(key in override.params)) return layer;
      const { [key]: _removed, ...params } = override.params;
      return withOverride(layer, aspect, (o) => ({ ...o, params }));
    }),
  };
}

// ---------------------------------------------------------------------------
// Transform and layer properties
// ---------------------------------------------------------------------------

export type TransformPatch = Partial<Omit<Transform, 'extra'>>;

/** Moves, scales or rotates a layer. Mergeable, so an on-canvas drag is one undo step. */
export function setLayerTransform(layerId: string, patch: TransformPatch, target: EditTarget = 'base'): Command {
  const keys = Object.keys(patch);
  return {
    label: keys.length === 1 ? `Set ${keys[0]}` : 'Transform layer',
    mergeKey: `transform:${layerId}:${keys.sort().join(',')}:${target}`,
    apply: (document) => withLayer(document, layerId, (layer) => {
      if (target === 'base') return { ...layer, transform: { ...layer.transform, ...patch } };
      // An override stores only the properties actually edited, so everything untouched keeps
      // inheriting the base rather than being frozen at whatever it was that day.
      return withOverride(layer, target, (override) => ({ ...override, transform: { ...override.transform, ...patch } }));
    }),
  };
}

export function resetTransform(layerId: string): Command {
  return {
    label: 'Reset transform',
    apply: (document) => withLayer(document, layerId, (layer) => ({
      ...layer,
      transform: { ...IDENTITY_TRANSFORM, extra: layer.transform.extra },
    })),
  };
}

/** Clears a whole aspect's overrides for one layer (the inspector's reset-to-base). */
export function clearAspectOverride(layerId: string, aspect: AspectBucket): Command {
  return {
    label: `Clear ${aspect} overrides`,
    apply: (document) => withLayer(document, layerId, (layer) => {
      if (layer.aspectOverrides[aspect] === undefined) return layer;
      const { [aspect]: _removed, ...rest } = layer.aspectOverrides;
      return { ...layer, aspectOverrides: rest };
    }),
  };
}

type LayerFlag = 'enabled' | 'locked' | 'soloed';

export function setLayerFlag(layerId: string, flag: LayerFlag, value: boolean): Command {
  const verbs: Record<LayerFlag, [string, string]> = {
    enabled: ['Show layer', 'Hide layer'],
    locked: ['Lock layer', 'Unlock layer'],
    soloed: ['Solo layer', 'Unsolo layer'],
  };
  return {
    label: verbs[flag][value ? 0 : 1],
    apply: (document) => withLayer(document, layerId, (layer) => ({ ...layer, [flag]: value } as Layer)),
  };
}

export function renameLayer(layerId: string, name: string): Command {
  return {
    label: 'Rename layer',
    mergeKey: `rename:${layerId}`,
    apply: (document) => withLayer(document, layerId, (layer) => ({ ...layer, name })),
  };
}

export function setLayerOpacity(layerId: string, opacity: number): Command {
  return {
    label: 'Set opacity',
    mergeKey: `opacity:${layerId}`,
    apply: (document) => withLayer(document, layerId, (layer) => ({ ...layer, opacity })),
  };
}

export function setLayerBlend(layerId: string, blend: Layer['blend']): Command {
  return {
    label: 'Set blend mode',
    apply: (document) => withLayer(document, layerId, (layer) => ({ ...layer, blend })),
  };
}

/**
 * Replaces a layer wholesale — applying a layer preset (S8). The replacement may carry a new id
 * (a preset applied in full is a new layer); it takes the old one's place in the tree, inside
 * whatever group held it.
 */
export function replaceLayer(layerId: string, layer: Layer, label = 'Apply preset'): Command {
  return {
    label,
    apply: (document) => withLayer(document, layerId, () => layer),
  };
}

export function setLayerTimeRange(layerId: string, inTicks: number, outTicks: number | null): Command {
  return {
    label: 'Set layer time range',
    mergeKey: `timeRange:${layerId}`,
    apply: (document) => withLayer(document, layerId, (layer) => ({
      ...layer,
      timeRange: { ...layer.timeRange, inTicks, outTicks },
    })),
  };
}

export function setLayerMask(layerId: string, maskLayerId: string | null): Command {
  return {
    label: maskLayerId === null ? 'Remove mask' : 'Set mask',
    apply: (document) => {
      if (maskLayerId !== null) {
        requireLayer(document, maskLayerId);
        if (maskLayerId === layerId) throw new CommandError('A layer cannot mask itself');
        // compositor-spec §5: cycles are rejected when the mask is set. Follow the chain from the
        // new source; reaching this layer again means A masks B masks … A.
        const seen = new Set<string>([layerId]);
        let next: string | null = maskLayerId;
        while (next !== null) {
          if (seen.has(next)) throw new CommandError('That would make masks go round in a circle (a layer ends up masking itself)');
          seen.add(next);
          next = findLayer(document, next)?.maskLayerId ?? null;
        }
      }
      return withLayer(document, layerId, (layer) => ({ ...layer, maskLayerId }));
    },
  };
}

/** How a layer's mask is read: channel, invert, feather (S7). A feather drag is one undo step. */
export function setMaskSettings(layerId: string, patch: Partial<MaskSettings>): Command {
  return {
    label: 'Set mask options',
    mergeKey: `mask:${layerId}:${Object.keys(patch).sort().join(',')}`,
    apply: (document) => withLayer(document, layerId, (layer) => ({
      ...layer,
      mask: { ...layer.mask, ...patch, feather: Math.min(0.25, Math.max(0, patch.feather ?? layer.mask.feather)) },
    })),
  };
}

/** Whether a mask source is also drawn in the picture (S7). */
export function setMaskSourceVisible(layerId: string, visible: boolean): Command {
  return {
    label: visible ? 'Show mask layer' : 'Hide mask layer',
    apply: (document) => withLayer(document, layerId, (layer) => ({ ...layer, maskSourceVisible: visible })),
  };
}

// ---------------------------------------------------------------------------
// Adding, removing and reordering layers
// ---------------------------------------------------------------------------

function insertInto(layers: readonly Layer[], layer: Layer, index: number): readonly Layer[] {
  const at = Math.min(layers.length, Math.max(0, index));
  return [...layers.slice(0, at), layer, ...layers.slice(at)];
}

export interface InsertPosition {
  /** The group to insert into, or null for the top level. */
  readonly parentId?: string | null;
  /** Bottom → top, like the stored order. Defaults to the top of the list. */
  readonly index?: number;
}

export function addLayer(layer: Layer, position: InsertPosition = {}): Command {
  return {
    label: layer.kind === 'group' ? 'Add group' : 'Add layer',
    apply: (document) => {
      if (findLayer(document, layer.id) !== undefined) {
        throw new CommandError(`A layer with id "${layer.id}" is already in this project`);
      }
      const parentId = position.parentId ?? null;
      const index = position.index ?? Number.MAX_SAFE_INTEGER;
      if (parentId === null) {
        return { ...document, layers: insertInto(document.layers, layer, index) };
      }
      const parent = requireLayer(document, parentId);
      if (parent.kind !== 'group') throw new CommandError(`Layer "${parentId}" is not a group`);
      return withLayer(document, parentId, (group) => ({
        ...(group as GroupLayer),
        children: insertInto((group as GroupLayer).children, layer, index),
      }));
    },
  };
}

export function removeLayer(layerId: string): Command {
  return {
    label: 'Delete layer',
    apply: (document) => {
      const layers = dropLayer(document.layers, layerId);
      if (layers === undefined) throw new CommandError(`No layer with id "${layerId}" in this project`);
      // A mask pointing at the deleted layer would dangle. Clearing it here keeps the document
      // self-consistent; the loader would otherwise report a broken reference on next open.
      const removedIds = new Set([layerId, ...collectIds(requireLayer(document, layerId))]);
      const cleaned = clearMasks(layers, removedIds);
      // Its keyframe tracks go with it (keyframes-spec §6), in the same undo step.
      const automation = document.automation.filter((track) => !removedIds.has(track.target.split('.')[1] ?? ''));
      return { ...document, layers: cleaned, automation };
    },
  };
}

function collectIds(layer: Layer): string[] {
  if (layer.kind !== 'group') return [];
  return layer.children.flatMap((child) => [child.id, ...collectIds(child)]);
}

function clearMasks(layers: readonly Layer[], removed: ReadonlySet<string>): readonly Layer[] {
  return layers.map((layer) => {
    const masked = layer.maskLayerId !== null && removed.has(layer.maskLayerId)
      ? { ...layer, maskLayerId: null }
      : layer;
    if (masked.kind === 'group') return { ...masked, children: clearMasks(masked.children, removed) };
    return masked;
  });
}

/**
 * Moves a layer to a new parent and index.
 *
 * **`index` is into the destination list *after* the layer has been taken out of it.** Stating
 * that is not pedantry: a drag-and-drop list naturally thinks in "drop before the item
 * currently at position n", and the two differ by one whenever a layer moves down within its
 * own parent. Callers converting from a drop indicator must subtract one in that case.
 *
 * Reparenting into one's own descendant would detach the subtree from the document, so it is
 * refused rather than silently losing layers.
 */
export function moveLayer(layerId: string, position: InsertPosition): Command {
  return {
    label: 'Reorder layer',
    apply: (document) => {
      const layer = requireLayer(document, layerId);
      const parentId = position.parentId ?? null;
      if (parentId !== null) {
        const parent = requireLayer(document, parentId);
        if (parent.kind !== 'group') throw new CommandError(`Layer "${parentId}" is not a group`);
        if (parentId === layerId || collectIds(layer).includes(parentId)) {
          throw new CommandError('A layer cannot be moved inside itself');
        }
      }
      const without = dropLayer(document.layers, layerId) as readonly Layer[];
      const index = position.index ?? Number.MAX_SAFE_INTEGER;
      if (parentId === null) return { ...document, layers: insertInto(without, layer, index) };
      const layers = mapLayer(without, parentId, (group) => ({
        ...(group as GroupLayer),
        children: insertInto((group as GroupLayer).children, layer, index),
      }));
      return { ...document, layers: layers as readonly Layer[] };
    },
  };
}

/**
 * Duplicates a layer, its effects, its bindings and (for a group) its children. Every id is
 * regenerated — ids are never reused (data-formats §1.4) — and modulation targets are rewritten
 * to point at the copy, so the duplicate reacts like the original instead of driving it.
 */
/**
 * Wraps layers in a new group, in place (M38). The group lands where the topmost of them was, and
 * they keep their relative order — "group these three" must not reshuffle them.
 *
 * Only siblings can be grouped: layers from different parents have no single place the group could
 * sit, and silently moving one out of its group would be a surprise.
 */
export function groupLayers(layerIds: readonly string[], group: GroupLayer): Command {
  return {
    label: layerIds.length === 1 ? 'Group layer' : `Group ${layerIds.length} layers`,
    apply: (document) => {
      if (layerIds.length === 0) throw new CommandError('Nothing to group');
      if (findLayer(document, group.id) !== undefined) throw new CommandError(`A layer with id "${group.id}" is already in this project`);
      const parents = new Set(layerIds.map((id) => parentIdOf(document, id)));
      if (parents.size > 1) throw new CommandError('Those layers are in different groups; group layers that sit side by side');
      const parentId = [...parents][0] ?? null;
      const siblings = siblingsOf(document, parentId);
      const chosen = siblings.filter((layer) => layerIds.includes(layer.id));
      if (chosen.length !== layerIds.length) throw new CommandError('Some of those layers are no longer in the project');
      const highest = Math.max(...chosen.map((layer) => siblings.indexOf(layer)));
      const remaining = siblings.filter((layer) => !layerIds.includes(layer.id));
      const insertAt = remaining.filter((layer) => siblings.indexOf(layer) < highest).length;
      const replacement = [...remaining];
      replacement.splice(insertAt, 0, { ...group, children: chosen });
      return withSiblings(document, parentId, replacement);
    },
  };
}

/** Dissolves a group, leaving its children where it was, in order. */
export function ungroupLayer(groupId: string): Command {
  return {
    label: 'Ungroup',
    apply: (document) => {
      const group = requireLayer(document, groupId);
      if (group.kind !== 'group') throw new CommandError(`Layer "${groupId}" is not a group`);
      const parentId = parentIdOf(document, groupId);
      const siblings = siblingsOf(document, parentId);
      const at = siblings.findIndex((layer) => layer.id === groupId);
      const replacement = [...siblings];
      replacement.splice(at, 1, ...group.children);
      return withSiblings(document, parentId, replacement);
    },
  };
}

/** The id of the group a layer sits in, or null at the top level. */
function parentIdOf(document: ProjectDocument, layerId: string): string | null {
  for (const { layer, parents } of walkLayers(document.layers)) {
    if (layer.id === layerId) return parents.at(-1)?.id ?? null;
  }
  throw new CommandError(`No layer with id "${layerId}" in this project`);
}

function siblingsOf(document: ProjectDocument, parentId: string | null): readonly Layer[] {
  if (parentId === null) return document.layers;
  const parent = requireLayer(document, parentId);
  if (parent.kind !== 'group') throw new CommandError(`Layer "${parentId}" is not a group`);
  return parent.children;
}

function withSiblings(document: ProjectDocument, parentId: string | null, layers: readonly Layer[]): ProjectDocument {
  if (parentId === null) return { ...document, layers };
  return withLayer(document, parentId, (parent) => ({ ...(parent as GroupLayer), children: layers }));
}

export function duplicateLayer(layerId: string, newIds: () => string): Command {
  return {
    label: 'Duplicate layer',
    apply: (document) => {
      const original = requireLayer(document, layerId);
      const remap = new Map<string, string>();
      const copy = cloneLayer(original, newIds, remap);
      const retargeted = retargetBindings(copy, remap);
      const parent = parentOf(document, layerId);
      const siblings = parent === null ? document.layers : parent.children;
      const index = siblings.findIndex((l) => l.id === layerId) + 1;
      const added = addLayer(retargeted, parent === null ? { index } : { parentId: parent.id, index }).apply(document);
      // The copy's keyframes too, pointed at the copy (keyframes-spec §6).
      const fix = (target: string) => target.split('.').map((part) => remap.get(part) ?? part).join('.');
      const copiedTracks = document.automation
        .filter((track) => remap.has(track.target.split('.')[1] ?? ''))
        .map((track) => ({ ...track, id: newIds(), target: fix(track.target), keyframes: track.keyframes.map((k) => ({ ...k, id: newIds() })) }));
      return copiedTracks.length === 0 ? added : { ...added, automation: [...added.automation, ...copiedTracks] };
    },
  };
}

function parentOf(document: ProjectDocument, layerId: string): GroupLayer | null {
  for (const { layer, parents } of walkLayers(document.layers)) {
    if (layer.id === layerId) return parents.at(-1) ?? null;
  }
  return null;
}

function cloneLayer(layer: Layer, newId: () => string, remap: Map<string, string>): Layer {
  const id = newId();
  remap.set(layer.id, id);
  const effects = layer.effects.map((effect) => {
    const effectId = newId();
    remap.set(effect.id, effectId);
    return { ...effect, id: effectId };
  });
  const modulations = layer.modulations.map((binding) => ({ ...binding, id: newId() }));
  const common = { ...layer, id, effects, modulations, name: layer.name === '' ? '' : `${layer.name} copy` };
  if (layer.kind === 'group') {
    return { ...(common as GroupLayer), children: layer.children.map((child) => cloneLayer(child, newId, remap)) };
  }
  return common as ModuleLayer;
}

/** Rewrites `layers.<oldId>…` targets inside the copy to point at the copy's own ids. */
function retargetBindings(layer: Layer, remap: ReadonlyMap<string, string>): Layer {
  const fix = (target: string): string => {
    const parts = target.split('.');
    return parts.map((part) => remap.get(part) ?? part).join('.');
  };
  const modulations = layer.modulations.map((binding) => ({ ...binding, target: fix(binding.target) }));
  if (layer.kind === 'group') {
    return { ...layer, modulations, children: layer.children.map((child) => retargetBindings(child, remap)) };
  }
  return { ...layer, modulations };
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

export function addEffect(layerId: string, effect: EffectSpec, index?: number): Command {
  return {
    label: 'Add effect',
    apply: (document) => withChainOwner(document, layerId, (layer) => {
      if (layer.effects.some((e) => e.id === effect.id)) {
        throw new CommandError(`An effect with id "${effect.id}" is already on this layer`);
      }
      const at = Math.min(layer.effects.length, Math.max(0, index ?? layer.effects.length));
      return { ...layer, effects: [...layer.effects.slice(0, at), effect, ...layer.effects.slice(at)] };
    }),
  };
}

export function removeEffect(layerId: string, effectId: string): Command {
  return {
    label: 'Remove effect',
    apply: (document) => withChainOwner(document, layerId, (layer) => {
      const effects = layer.effects.filter((e) => e.id !== effectId);
      if (effects.length === layer.effects.length) {
        throw new CommandError(`No effect with id "${effectId}" on layer "${layerId}"`);
      }
      return { ...layer, effects };
    }),
  };
}

/** Reorders within the chain. Order is visible and meaningful — bloom then vignette differs. */
export function moveEffect(layerId: string, effectId: string, toIndex: number): Command {
  return {
    label: 'Reorder effect',
    apply: (document) => withChainOwner(document, layerId, (layer) => {
      const from = layer.effects.findIndex((e) => e.id === effectId);
      if (from < 0) throw new CommandError(`No effect with id "${effectId}" on layer "${layerId}"`);
      const rest = [...layer.effects.slice(0, from), ...layer.effects.slice(from + 1)];
      const at = Math.min(rest.length, Math.max(0, toIndex));
      return { ...layer, effects: [...rest.slice(0, at), layer.effects[from] as EffectSpec, ...rest.slice(at)] };
    }),
  };
}

export function setEffectEnabled(layerId: string, effectId: string, enabled: boolean): Command {
  return {
    label: enabled ? 'Enable effect' : 'Bypass effect',
    apply: (document) => withChainOwner(document, layerId, (layer) => ({
      ...layer,
      effects: layer.effects.map((e) => (e.id === effectId ? { ...e, enabled } : e)),
    })),
  };
}

export function setEffectParam(layerId: string, effectId: string, key: string, value: unknown): Command {
  return {
    label: `Set ${key}`,
    mergeKey: `effectParam:${layerId}:${effectId}:${key}`,
    apply: (document) => withChainOwner(document, layerId, (layer) => {
      if (!layer.effects.some((e) => e.id === effectId)) {
        throw new CommandError(`No effect with id "${effectId}" on layer "${layerId}"`);
      }
      return {
        ...layer,
        effects: layer.effects.map((e) => (e.id === effectId ? { ...e, params: { ...e.params, [key]: value } } : e)),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Modulation
// ---------------------------------------------------------------------------

export function addModulation(layerId: string, binding: ModulationBinding): Command {
  return {
    label: 'Add modulation',
    apply: (document) => withChainOwner(document, layerId, (layer) => {
      if (layer.modulations.some((b) => b.id === binding.id)) {
        throw new CommandError(`A binding with id "${binding.id}" is already on this layer`);
      }
      return { ...layer, modulations: [...layer.modulations, binding] };
    }),
  };
}

export function removeModulation(layerId: string, bindingId: string): Command {
  return {
    label: 'Remove modulation',
    apply: (document) => withChainOwner(document, layerId, (layer) => {
      const modulations = layer.modulations.filter((b) => b.id !== bindingId);
      if (modulations.length === layer.modulations.length) {
        throw new CommandError(`No binding with id "${bindingId}" on layer "${layerId}"`);
      }
      return { ...layer, modulations };
    }),
  };
}

/** Edits one field of a binding. Mergeable per field, so dragging `amount` is one step. */
export function updateModulation(
  layerId: string,
  bindingId: string,
  patch: Partial<Omit<ModulationBinding, 'id' | 'extra'>>,
): Command {
  const keys = Object.keys(patch);
  return {
    label: keys.length === 1 ? `Set ${keys[0]}` : 'Edit modulation',
    mergeKey: `binding:${layerId}:${bindingId}:${keys.sort().join(',')}`,
    apply: (document) => withChainOwner(document, layerId, (layer) => {
      if (!layer.modulations.some((b) => b.id === bindingId)) {
        throw new CommandError(`No binding with id "${bindingId}" on layer "${layerId}"`);
      }
      return {
        ...layer,
        modulations: layer.modulations.map((b) => (b.id === bindingId ? { ...b, ...patch } : b)),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Project-level
// ---------------------------------------------------------------------------

export function renameProject(name: string): Command {
  return { label: 'Rename project', mergeKey: 'project:name', apply: (document) => ({ ...document, name }) };
}

export function setCanvas(patch: Partial<Omit<ProjectDocument['canvas'], 'extra'>>): Command {
  return {
    label: 'Change canvas',
    apply: (document) => ({ ...document, canvas: { ...document.canvas, ...patch } }),
  };
}

export function setAudio(patch: Partial<Omit<ProjectDocument['audio'], 'extra'>>): Command {
  const keys = Object.keys(patch);
  return {
    label: keys.length === 1 ? `Set audio ${keys[0]}` : 'Change audio',
    mergeKey: `audio:${keys.sort().join(',')}`,
    apply: (document) => ({ ...document, audio: { ...document.audio, ...patch } }),
  };
}

/**
 * Replaces the project's look — its layers, global effects and palette — in one step: applying a
 * project preset (S8). Everything else (audio, canvas, seed, timing, assets) is left alone, which
 * is the contract `applyProjectPreset` keeps too.
 */
export function replaceLook(
  look: Pick<ProjectDocument, 'layers' | 'globalEffects' | 'palette'>,
  label = 'Apply project preset',
): Command {
  return {
    label,
    apply: (document) => ({ ...document, layers: look.layers, globalEffects: look.globalEffects, palette: look.palette }),
  };
}

/**
 * The auto-director's result (M21, M22), as one undo step: the look — layers, both global lists,
 * palette, seed — and the director's record. Everything else (audio, lyrics, assets, canvas, name)
 * is the project's own and stays as it is at the moment the command runs.
 */
export function applyDirection(
  result: Pick<ProjectDocument, 'seed' | 'palette' | 'layers' | 'globalEffects' | 'globalModulations' | 'director'>,
  label = 'Generate project',
): Command {
  return {
    label,
    apply: (document) => ({
      ...document,
      seed: result.seed,
      palette: result.palette,
      layers: result.layers,
      globalEffects: result.globalEffects,
      globalModulations: result.globalModulations,
      director: result.director,
    }),
  };
}

/**
 * Which Demucs model separates this project's stems (D8: `htdemucs` fast, `htdemucs_ft` finer).
 * Part of the analysis key, so the studio re-analyses after it; stems made by the other model stay
 * cached and come back if it is switched back.
 */
export function setStemModel(model: string): Command {
  return {
    label: `Stem model: ${model}`,
    apply: (document) => (document.analysisSettings.stemModel === model
      ? document
      : { ...document, analysisSettings: { ...document.analysisSettings, stemModel: model } }),
  };
}

/** Stores a refined beat grid (S16), or goes back to the detected one with null. */
export function setBeatRefinement(refinement: BeatRefinement | null): Command {
  return {
    label: refinement === null ? 'Use detected beats' : 'Refine beats',
    apply: (document) => ({ ...document, analysisSettings: { ...document.analysisSettings, beatRefinement: refinement } }),
  };
}

/** Rerolls the master seed — "Surprise me" (M22). */
export function setSeed(seed: number): Command {
  return { label: 'Reroll seed', apply: (document) => ({ ...document, seed }) };
}

export function setPaletteColor(index: number, color: string): Command {
  return {
    label: 'Set palette colour',
    mergeKey: `palette:${index}`,
    apply: (document) => {
      if (index < 0 || index >= document.palette.colors.length) {
        throw new CommandError(`No palette colour at index ${index}`);
      }
      const colors = document.palette.colors.map((c, i) => (i === index ? color : c));
      return { ...document, palette: { ...document.palette, colors } };
    },
  };
}

/**
 * Adds a file to the project's assets. Importing the same file twice (same hash) returns the
 * existing entry's document unchanged rather than a duplicate, so choosing the same background
 * for two layers shares one asset.
 */
export function addAsset(asset: AssetRef): Command {
  return {
    label: `Import ${asset.name || 'asset'}`,
    apply: (document) => {
      if (document.assets.some((a) => a.id === asset.id)) throw new CommandError(`An asset with id ${asset.id} already exists`);
      if (document.assets.some((a) => a.hash === asset.hash && a.kind === asset.kind && asset.hash !== '')) return document;
      return { ...document, assets: [...document.assets, asset] };
    },
  };
}

/**
 * Several commands as one undo step — "import an image and use it here" is one thing the user
 * did, and undoing half of it would leave an asset nothing points at.
 */
export function sequence(label: string, commands: readonly Command[]): Command {
  return { label, apply: (document) => commands.reduce((current, command) => command.apply(current), document) };
}

/** Where an asset is used: a readable location per reference ("Sky · image", "Sky · 9:16 · image"). */
export interface AssetUse {
  readonly layerId: string;
  readonly where: string;
}

/**
 * Every reference to every asset. Parameters hold asset **ids** (module-spec: param type
 * `asset`), and ids are ULIDs, so a string parameter equal to an asset's id is a reference —
 * which lets this work without module manifests, and so for modules that are not installed.
 * Base params, aspect overrides and effects on layers and on the project all count.
 */
export function assetUsage(document: ProjectDocument): ReadonlyMap<string, readonly AssetUse[]> {
  const ids = new Set(document.assets.map((a) => a.id));
  const uses = new Map<string, AssetUse[]>();
  const scan = (params: Readonly<Record<string, unknown>>, layerId: string, where: string) => {
    for (const [key, value] of Object.entries(params)) {
      if (typeof value !== 'string' || !ids.has(value)) continue;
      const list = uses.get(value) ?? [];
      list.push({ layerId, where: `${where} · ${key}` });
      uses.set(value, list);
    }
  };
  for (const { layer } of walkLayers(document.layers)) {
    const label = layer.name || (layer.kind === 'module' ? layer.module : 'group');
    if (layer.kind === 'module') scan(layer.params, layer.id, label);
    for (const [bucket, override] of Object.entries(layer.aspectOverrides)) {
      if (override !== undefined) scan(override.params, layer.id, `${label} · ${bucket}`);
    }
    for (const effect of layer.effects) scan(effect.params, layer.id, `${label} · ${effect.name || effect.module}`);
  }
  for (const effect of document.globalEffects) scan(effect.params, '', `project · ${effect.name || effect.module}`);
  return uses;
}

/**
 * Points an asset at another file (M40 relink). The id stays, so every layer using it follows
 * without being touched; path, hash, size and name describe the new file.
 */
export function relinkAsset(id: string, file: { path: string; hash: string; size: number; name: string }): Command {
  return {
    label: `Relink ${file.name}`,
    apply: (document) => {
      if (!document.assets.some((a) => a.id === id)) throw new CommandError(`No asset with id "${id}" in this project`);
      return { ...document, assets: document.assets.map((a) => (a.id === id ? { ...a, ...file } : a)) };
    },
  };
}

/** Removes an asset nothing uses. A used one is refused: removing it would break those layers. */
export function removeAsset(id: string): Command {
  return {
    label: 'Remove asset',
    apply: (document) => {
      const asset = document.assets.find((a) => a.id === id);
      if (asset === undefined) throw new CommandError(`No asset with id "${id}" in this project`);
      const uses = assetUsage(document).get(id) ?? [];
      if (uses.length > 0) {
        throw new CommandError(`"${asset.name}" is still used by ${uses.map((u) => u.where).join(', ')}`);
      }
      return { ...document, assets: document.assets.filter((a) => a.id !== id) };
    },
  };
}

/** Removes every asset no parameter refers to. */
export function removeUnusedAssets(): Command {
  return {
    label: 'Remove unused assets',
    apply: (document) => {
      const used = assetUsage(document);
      const kept = document.assets.filter((a) => used.has(a.id));
      return kept.length === document.assets.length ? document : { ...document, assets: kept };
    },
  };
}

/** The asset already holding this file, if the project has one — so a re-import reuses it. */
export function findAssetByHash(document: ProjectDocument, hash: string): AssetRef | undefined {
  return document.assets.find((a) => a.hash === hash);
}

export function addPaletteColor(color: string): Command {
  return {
    label: 'Add palette colour',
    apply: (document) => ({
      ...document,
      palette: { ...document.palette, colors: [...document.palette.colors, color] },
    }),
  };
}

/**
 * Removes a colour and **repairs the role table**, which is the whole difficulty: roles are
 * indices into the colour list, so deleting the second of four silently re-points every role
 * above it at the wrong colour. Roles pointing at the removed colour are dropped — the module
 * default then applies, which is what `parse.ts` promises for an unassigned role — and roles
 * above it shift down.
 */
export function removePaletteColor(index: number): Command {
  return {
    label: 'Remove palette colour',
    apply: (document) => {
      const { palette } = document;
      if (index < 0 || index >= palette.colors.length) {
        throw new CommandError(`No palette colour at index ${index}`);
      }
      const colors = palette.colors.filter((_, i) => i !== index);
      const roles: Record<string, number> = {};
      for (const [role, at] of Object.entries(palette.roles)) {
        if (at === index) continue;
        roles[role] = at > index ? at - 1 : at;
      }
      return { ...document, palette: { ...palette, colors, roles } };
    },
  };
}

/** Points a role at a colour, or unassigns it with `null`. */
export function setPaletteRole(role: string, index: number | null): Command {
  return {
    label: index === null ? 'Unassign palette role' : 'Assign palette role',
    apply: (document) => {
      const { palette } = document;
      if (index !== null && (index < 0 || index >= palette.colors.length)) {
        throw new CommandError(`No palette colour at index ${index}`);
      }
      const roles = { ...palette.roles };
      if (index === null) delete roles[role];
      else roles[role] = index;
      return { ...document, palette: { ...palette, roles } };
    },
  };
}
