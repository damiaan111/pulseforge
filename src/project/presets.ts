// Presets (M25, module-spec §10, data-formats §3).
//
// A preset is a saved look: a layer's module and parameters, its effect chain, and — crucially —
// its modulations. A preset without its reactivity is a still image of something that was alive,
// which is why bindings travel with it.
//
// Three properties, each the answer to a specific way this goes wrong:
//
//  1. **Only non-defaults are stored.** A preset that records every parameter freezes that day's
//     defaults forever, so improving a module's default later cannot reach the presets people
//     already saved. Storing the difference means a preset says what it *means* — "bloom at 0.9"
//     — and inherits the rest.
//  2. **Modulation targets are relative.** Bindings inside a document address `layers.<id>...`,
//     and those ids are unique to the document they came from. A preset stores `self.params.x`
//     and rebinds on apply, so applying one twice gives two independent layers rather than two
//     bindings fighting over the original.
//  3. **Transient state never travels.** `bypass` and `solo` are UI state; `enabled` is not.
//     A preset that arrives with half its modulations silently bypassed is a bug report.
//
// Assets are **referenced, not embedded** (D6): the asset library owns the files, the preset
// names them. Presets stay small and a background used by twenty presets is stored once.

import {
  type AspectBucket,
  type DocumentBlendMode,
  type EffectSpec,
  type Layer,
  type ModulationBinding,
  type ModuleLayer,
  type Palette,
  type ProjectDocument,
  type Transform,
} from './document.ts';

export const PRESET_FORMAT_VERSION = 1;

/** The parameter defaults for one module, by key. Injected so this file stays free of the engine. */
export type ManifestLookup = (moduleId: string) => ManifestInfo | undefined;

export interface ManifestInfo {
  readonly version: string;
  readonly paramsSchemaVersion: number;
  readonly defaults: Readonly<Record<string, unknown>>;
}

export interface PresetModuleRef {
  readonly id: string;
  readonly version: string;
  readonly paramsSchemaVersion: number;
}

export interface PresetEffect {
  readonly module: string;
  readonly name: string;
  readonly enabled: boolean;
  /** Non-default values only. */
  readonly values: Readonly<Record<string, unknown>>;
  readonly paramsSchemaVersion: number;
}

/** A binding with its target rewritten relative to the preset root. */
export type PresetBinding = Omit<ModulationBinding, 'id' | 'target'> & { readonly target: string };

export interface LayerPreset {
  readonly formatVersion: number;
  readonly scope: 'layer';
  readonly name: string;
  readonly tags: readonly string[];
  readonly module: PresetModuleRef;
  readonly values: Readonly<Record<string, unknown>>;
  readonly effects: readonly PresetEffect[];
  readonly modulations: readonly PresetBinding[];
  readonly transform: Transform;
  readonly blend: DocumentBlendMode;
  readonly opacity: number;
  readonly aspectOverrides: Readonly<Partial<Record<AspectBucket, { transform: Partial<Omit<Transform, 'extra'>>; params: Readonly<Record<string, unknown>> }>>>;
}

export interface ProjectPreset {
  readonly formatVersion: number;
  readonly scope: 'project';
  readonly name: string;
  readonly tags: readonly string[];
  readonly palette: Palette;
  readonly layers: readonly LayerPreset[];
  readonly globalEffects: readonly PresetEffect[];
}

export type Preset = LayerPreset | ProjectPreset;

export class PresetError extends Error {
  readonly fixes: readonly string[];
  constructor(message: string, fixes: readonly string[] = []) {
    super(message);
    this.name = 'PresetError';
    this.fixes = fixes;
  }
}

/** Values that differ from the module's defaults. Unknown modules keep everything — dropping a
 * parameter we cannot check would quietly lose the one setting that mattered. */
export function nonDefaultValues(
  moduleId: string,
  params: Readonly<Record<string, unknown>>,
  manifests: ManifestLookup,
): Record<string, unknown> {
  const defaults = manifests(moduleId)?.defaults;
  if (defaults === undefined) return { ...params };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (!sameValue(defaults[key], value)) out[key] = value;
  }
  return out;
}

/**
 * Structural equality, **independent of key order**.
 *
 * A `JSON.stringify` comparison looks equivalent and is not: `{r,g,b}` and `{b,g,r}` are the
 * same colour and stringify differently, so an identical value rebuilt by a UI control would be
 * stored as a non-default. That quietly defeats the whole point of storing only non-defaults —
 * the value is then frozen against every future improvement to the module's default.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, i) => sameValue(value, b[i]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
}

/**
 * Capture a layer as a preset. Groups are refused: a group's meaning is its children's ids and
 * their relative geometry, which does not survive being lifted out of the document it came from.
 */
export function createLayerPreset(
  layer: Layer,
  manifests: ManifestLookup,
  options: { readonly name?: string; readonly tags?: readonly string[] } = {},
): LayerPreset {
  if (layer.kind !== 'module') {
    throw new PresetError('Group layers cannot be saved as presets.', [
      'Save one of its children instead',
      'Or save the whole project as a project preset',
    ]);
  }
  const info = manifests(layer.module);
  return {
    formatVersion: PRESET_FORMAT_VERSION,
    scope: 'layer',
    name: options.name ?? layer.name,
    tags: options.tags ?? [],
    module: {
      id: layer.module,
      version: info?.version ?? 'unknown',
      paramsSchemaVersion: layer.paramsSchemaVersion,
    },
    values: nonDefaultValues(layer.module, layer.params, manifests),
    effects: layer.effects.map((effect) => toPresetEffect(effect, manifests)),
    modulations: layer.modulations.map((binding) => toPresetBinding(binding, layer)),
    transform: layer.transform,
    blend: layer.blend,
    opacity: layer.opacity,
    aspectOverrides: Object.fromEntries(
      Object.entries(layer.aspectOverrides).map(([bucket, override]) => [
        bucket,
        { transform: override.transform, params: nonDefaultValues(layer.module, override.params, manifests) },
      ]),
    ),
  };
}

function toPresetEffect(effect: EffectSpec, manifests: ManifestLookup): PresetEffect {
  return {
    module: effect.module,
    name: effect.name,
    enabled: effect.enabled,
    values: nonDefaultValues(effect.module, effect.params, manifests),
    paramsSchemaVersion: effect.paramsSchemaVersion,
  };
}

/**
 * Rewrite a binding's target relative to its layer: `layers.<id>.params.x` → `self.params.x`,
 * and `layers.<id>.effects.<effectId>.params.y` → `self.effects.<index>.params.y`.
 *
 * Effects become **positional** on purpose — effect ids are regenerated on apply, so an id would
 * dangle, while "the second effect in the chain" survives the trip.
 */
function toPresetBinding(binding: ModulationBinding, layer: ModuleLayer): PresetBinding {
  const { id: _id, target, ...rest } = binding;
  return { ...rest, target: relativeTarget(target, layer) };
}

function relativeTarget(target: string, layer: ModuleLayer): string {
  const prefix = `layers.${layer.id}.`;
  if (!target.startsWith(prefix)) return target; // Points elsewhere; kept verbatim and reported on apply.
  const rest = target.slice(prefix.length);
  const effectMatch = /^effects\.([^.]+)\.(.*)$/.exec(rest);
  if (effectMatch === null) return `self.${rest}`;
  const index = layer.effects.findIndex((effect) => effect.id === effectMatch[1]);
  return index < 0 ? `self.${rest}` : `self.effects.${index}.${effectMatch[2]}`;
}

export interface ApplyOptions {
  /** Ids for the new layer, its effects and its bindings — never reused (data-formats §1.4). */
  readonly newId: () => string;
  readonly manifests: ManifestLookup;
  /** Keep the target layer's name instead of taking the preset's. */
  readonly keepName?: boolean;
  /** Apply only the look, leaving the target's modulations in place. */
  readonly styleOnly?: boolean;
  /**
   * The opposite of `styleOnly` (ui-spec §5 "apply partially"): keep the target layer exactly as
   * it is — module, values, effects, id — and take only the preset's modulations, rebound onto it.
   * Effect targets stay positional, so "the first effect's intensity" means the target's first.
   */
  readonly modulationsOnly?: boolean;
  /**
   * Keep the target layer's module and carry across only the values it shares by key
   * (module-spec §10). Without this, applying a preset replaces the module outright, which is
   * what "apply this preset" normally means; with it, "make my rings layer look like that".
   */
  readonly keepModule?: boolean;
}

export interface ApplyResult {
  readonly layer: ModuleLayer;
  /** What could not be carried across, in the UI's words. Never silent (CLAUDE.md constraint 4). */
  readonly notes: readonly string[];
}

/**
 * Apply a layer preset to an existing layer.
 *
 * Applying across module types is allowed and is the "replace module" case from module-spec §10:
 * values that share a key carry over, the rest fall back to the new module's defaults, and every
 * dropped key is reported rather than vanishing.
 */
export function applyLayerPreset(preset: LayerPreset, target: Layer, options: ApplyOptions): ApplyResult {
  if (preset.formatVersion !== PRESET_FORMAT_VERSION) {
    throw new PresetError(
      `This preset was written in format ${preset.formatVersion}; this build reads ${PRESET_FORMAT_VERSION}.`,
      ['Re-save it from a build that can read it'],
    );
  }
  if (target.kind !== 'module') {
    throw new PresetError('A layer preset cannot be applied to a group.', ['Select a layer inside the group']);
  }

  if (options.modulationsOnly === true) {
    const notes: string[] = [];
    if (target.module !== preset.module.id) {
      notes.push(`These modulations were made for ${preset.module.id}; on ${target.module}, any that aim at a parameter it does not have will not resolve.`);
    }
    const modulations = preset.modulations.map((binding) => resolveBinding(binding, target.id, target.effects, options.newId(), notes));
    return { layer: { ...target, modulations }, notes };
  }

  const notes: string[] = [];
  // Which module the result uses: the preset's, unless the caller asked to keep the target's.
  const moduleId = options.keepModule === true ? target.module : preset.module.id;
  const info = options.manifests(moduleId);
  if (info === undefined) {
    notes.push(`Module ${moduleId} is not installed; its parameters were kept but it will not render.`);
  } else if (moduleId === preset.module.id && info.paramsSchemaVersion !== preset.module.paramsSchemaVersion) {
    notes.push(
      `Preset was saved for ${preset.module.id} params v${preset.module.paramsSchemaVersion}; this build has v${info.paramsSchemaVersion}.`,
    );
  }

  let values: Record<string, unknown> = { ...preset.values };
  if (options.keepModule === true && info !== undefined) {
    // Keeping the target's module: carry only the keys it actually has, and say what was left.
    const kept: Record<string, unknown> = {};
    const dropped: string[] = [];
    for (const [key, value] of Object.entries(preset.values)) {
      if (key in info.defaults) kept[key] = value;
      else dropped.push(key);
    }
    values = kept;
    if (dropped.length > 0) notes.push(`Did not carry over ${dropped.join(', ')}: ${moduleId} has no such parameter.`);
  }

  const layerId = options.newId();
  const effects: EffectSpec[] = preset.effects.map((effect) => ({
    id: options.newId(),
    module: effect.module,
    name: effect.name,
    enabled: effect.enabled,
    params: { ...effect.values },
    paramsSchemaVersion: effect.paramsSchemaVersion,
    extra: {},
  }));

  const modulations = options.styleOnly === true
    ? target.modulations
    : preset.modulations.map((binding) => resolveBinding(binding, layerId, effects, options.newId(), notes));

  const layer: ModuleLayer = {
    ...target,
    kind: 'module',
    id: layerId,
    name: options.keepName === true ? target.name : preset.name,
    module: moduleId,
    params: values,
    paramsSchemaVersion: info?.paramsSchemaVersion ?? preset.module.paramsSchemaVersion,
    transform: preset.transform,
    blend: preset.blend,
    opacity: preset.opacity,
    effects,
    modulations,
    aspectOverrides: Object.fromEntries(
      Object.entries(preset.aspectOverrides).map(([bucket, override]) => [
        bucket,
        { transform: override.transform, params: { ...override.params }, extra: {} },
      ]),
    ),
  };
  return { layer, notes };
}

/** `self.…` back to `layers.<newId>.…`, with effect positions resolved to the new ids. */
function resolveBinding(
  binding: PresetBinding,
  layerId: string,
  effects: readonly EffectSpec[],
  bindingId: string,
  notes: string[],
): ModulationBinding {
  let target = binding.target;
  if (target.startsWith('self.')) {
    const rest = target.slice('self.'.length);
    const effectMatch = /^effects\.(\d+)\.(.*)$/.exec(rest);
    if (effectMatch === null) {
      target = `layers.${layerId}.${rest}`;
    } else {
      const effect = effects[Number(effectMatch[1])];
      if (effect === undefined) {
        notes.push(`A modulation pointed at effect ${effectMatch[1]}, which this preset does not contain.`);
        target = `layers.${layerId}.${rest}`;
      } else {
        target = `layers.${layerId}.effects.${effect.id}.${effectMatch[2]}`;
      }
    }
  } else {
    notes.push(`A modulation points outside the preset (${target}); it was kept as written and may not resolve.`);
  }
  return { ...binding, id: bindingId, target };
}

/** Capture the whole project: palette, every top-level module layer, and the global chain. */
export function createProjectPreset(
  document: ProjectDocument,
  manifests: ManifestLookup,
  options: { readonly name?: string; readonly tags?: readonly string[] } = {},
): ProjectPreset {
  const layers = document.layers
    .filter((layer): layer is ModuleLayer => layer.kind === 'module')
    .map((layer) => createLayerPreset(layer, manifests));
  return {
    formatVersion: PRESET_FORMAT_VERSION,
    scope: 'project',
    name: options.name ?? document.name,
    tags: options.tags ?? [],
    palette: document.palette,
    layers,
    globalEffects: document.globalEffects.map((effect) => toPresetEffect(effect, manifests)),
  };
}

export function stringifyPreset(preset: Preset): string {
  return `${JSON.stringify(preset, null, 2)}\n`;
}

/** Parse and validate enough to fail with a sentence rather than a type error later. */
export function parsePreset(raw: unknown): Preset {
  if (typeof raw !== 'object' || raw === null) throw new PresetError('This preset file is not a JSON object.');
  const preset = raw as Partial<Preset>;
  if (typeof preset.formatVersion !== 'number') throw new PresetError('This preset has no format version.');
  if (preset.formatVersion !== PRESET_FORMAT_VERSION) {
    throw new PresetError(
      `This preset was written in format ${preset.formatVersion}; this build reads ${PRESET_FORMAT_VERSION}.`,
      ['Re-save it from a build that can read it'],
    );
  }
  if (preset.scope !== 'layer' && preset.scope !== 'project') {
    throw new PresetError(`A preset must have scope "layer" or "project", not ${String(preset.scope)}.`);
  }
  return preset as Preset;
}

export interface ApplyProjectOptions extends Omit<ApplyOptions, 'keepModule' | 'keepName'> {
  /** Add the preset's layers above what is already there instead of replacing them. */
  readonly merge?: boolean;
  /** Keep the document's palette; by default the preset's palette is adopted. */
  readonly keepPalette?: boolean;
}

export interface ApplyProjectResult {
  readonly document: ProjectDocument;
  readonly notes: readonly string[];
}

/**
 * Apply a project preset to a document.
 *
 * The audio, canvas, seed and timing are **never touched**: a project preset is a look, and the
 * song it is applied to is not part of it. That is what makes "try this look on this track" a
 * single action — and applying a preset that silently retimed or re-canvassed the project would
 * be the kind of surprise no undo step fully repairs.
 */
export function applyProjectPreset(
  preset: ProjectPreset,
  document: ProjectDocument,
  options: ApplyProjectOptions,
): ApplyProjectResult {
  if (preset.formatVersion !== PRESET_FORMAT_VERSION) {
    throw new PresetError(
      `This preset was written in format ${preset.formatVersion}; this build reads ${PRESET_FORMAT_VERSION}.`,
      ['Re-save it from a build that can read it'],
    );
  }

  const notes: string[] = [];
  const layers: Layer[] = [];
  for (const layerPreset of preset.layers) {
    // Each layer preset needs a target to apply onto; a fresh layer of its own module is the
    // natural one, and `applyLayerPreset` then does the id generation and rebinding.
    const blank = blankLayerFor(layerPreset, options.newId());
    const applied = applyLayerPreset(layerPreset, blank, {
      newId: options.newId,
      manifests: options.manifests,
      ...(options.styleOnly === undefined ? {} : { styleOnly: options.styleOnly }),
    });
    layers.push(applied.layer);
    notes.push(...applied.notes);
  }

  const globalEffects = preset.globalEffects.map((effect) => ({
    id: options.newId(),
    module: effect.module,
    name: effect.name,
    enabled: effect.enabled,
    params: { ...effect.values },
    paramsSchemaVersion: effect.paramsSchemaVersion,
    extra: {},
  }));

  const document2: ProjectDocument = {
    ...document,
    palette: options.keepPalette === true ? document.palette : preset.palette,
    layers: options.merge === true ? [...document.layers, ...layers] : layers,
    globalEffects: options.merge === true ? [...document.globalEffects, ...globalEffects] : globalEffects,
  };
  return { document: document2, notes };
}

/** A minimal layer of the preset's module, used only as the target `applyLayerPreset` fills in. */
function blankLayerFor(preset: LayerPreset, id: string): ModuleLayer {
  return {
    kind: 'module',
    id,
    name: preset.name,
    module: preset.module.id,
    params: {},
    paramsSchemaVersion: preset.module.paramsSchemaVersion,
    enabled: true,
    locked: false,
    soloed: false,
    timeRange: { inTicks: 0, outTicks: null, extra: {} },
    transform: preset.transform,
    blend: preset.blend,
    opacity: preset.opacity,
    maskLayerId: null,
    effects: [],
    modulations: [],
    aspectOverrides: {},
    extra: {},
  };
}
