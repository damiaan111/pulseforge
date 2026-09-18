// Making and describing modulation bindings in the studio (M13, modulation-spec §10–§11).
//
// The evaluator (engine/core/modulation.ts) is the half that runs; this is the half a person
// touches: what a new binding looks like, which sources a parameter is offered first, the one-click
// recipes, how a target path reads in the UI, and when a binding is too weak to see. Pure, so the
// inspector and the matrix panel share one answer and the tests pin it down.
//
// Amounts are in the **parameter's own units** (the evaluator adds `amount × signal` to the base
// value), so defaults are fractions of the parameter's range: 25% of a 0..1 glow is 0.25, of a
// 0..128 bar count it is 32. A binding made on one parameter and pasted onto another would need
// rescaling for the same reason — which is why recipes are expressed as fractions, not numbers.

import type { ParamSpec } from '../engine/core/params.ts';
import { createBinding } from './create.ts';
import type { Layer, ModulationBinding, ProjectDocument } from './document.ts';
import { walkLayers } from './document.ts';

/** A source the studio offers, with the words it is offered in (modulation-spec §2). */
export interface SourceChoice {
  readonly type: string;
  readonly label: string;
  readonly hint: string;
  /** Reads an analysis stem (and so offers the stem picker). */
  readonly audio: boolean;
}

export const SOURCE_CHOICES: readonly SourceChoice[] = [
  { type: 'onset', label: 'Onsets', hint: 'Hits as they happen — kicks, snares, accents. Follows the playing, can misfire.', audio: true },
  { type: 'beat', label: 'Beat grid', hint: 'A pulse on every beat of the detected grid. Machine-regular, ignores what was actually played.', audio: true },
  { type: 'band', label: 'Frequency band', hint: 'Energy in one band — bass for weight, highs for sparkle.', audio: true },
  { type: 'rms', label: 'Loudness', hint: 'Smooth overall level: intensity and slow swells.', audio: true },
  { type: 'peak', label: 'Peak', hint: 'Faster loudness: sharper than RMS, still continuous.', audio: true },
  { type: 'centroid', label: 'Brightness', hint: 'Spectral centroid — how bright the sound is. Good for hue.', audio: true },
  { type: 'flux', label: 'Change', hint: 'How fast the spectrum is changing: busyness, texture, glitch.', audio: true },
  { type: 'lfo', label: 'LFO', hint: 'A steady wave, not the audio — keeps quiet moments alive.', audio: false },
  { type: 'noise', label: 'Drift', hint: 'Smooth seeded random wandering.', audio: false },
  { type: 'ramp', label: 'Ramp', hint: 'From one value to another over the whole track.', audio: false },
  { type: 'progress', label: 'Progress', hint: 'Zero at the start of the track, one at the end.', audio: false },
];

export const STEM_CHOICES = ['mix', 'drums', 'bass', 'vocals', 'other'] as const;

export const LFO_SHAPES = ['sine', 'triangle', 'saw', 'square', 'noise', 'sample-hold'] as const;

/** The numeric span a binding's amount is measured against. Discrete types count their steps. */
export function paramSpan(spec: ParamSpec): number {
  switch (spec.type) {
    case 'float':
      return (spec.softMax ?? spec.max) - (spec.softMin ?? spec.min);
    case 'int':
      return spec.max - spec.min;
    case 'bool':
      return 1;
    case 'enum':
      return Math.max(1, spec.options.length - 1);
    default:
      return 0;
  }
}

/** Whether a parameter can carry a binding at all: numeric or discrete, and not opted out. */
export function isModulatable(spec: ParamSpec): boolean {
  if (spec.modulatable === false) return false;
  return paramSpan(spec) > 0;
}

/**
 * Sources offered first for a parameter (modulation-spec §10: "a scale parameter offers drum
 * onset first; a hue parameter offers centroid"). Guessed from the key and label, which is what a
 * module author already chose to describe the parameter — no extra schema needed.
 */
export function suggestedSources(spec: ParamSpec): readonly string[] {
  const words = `${spec.key} ${spec.label}`.toLowerCase();
  if (/(scale|size|radius|swell|pulse|zoom|length|height|kick|punch)/.test(words)) return ['onset', 'beat', 'band', 'rms'];
  if (/(glow|intensity|bloom|bright|core|exposure|opacity|amount)/.test(words)) return ['rms', 'band', 'onset', 'peak'];
  if (/(hue|colou?r|tint|temperature)/.test(words)) return ['centroid', 'lfo', 'noise'];
  if (/(speed|spin|rotation|angle|drift|twist)/.test(words)) return ['rms', 'lfo', 'noise', 'onset'];
  if (/(glitch|chromatic|displace|noise|grain|jitter)/.test(words)) return ['flux', 'onset', 'peak'];
  return ['rms', 'onset', 'band', 'beat'];
}

/**
 * A new binding on `target`: the first suggested source, adding a quarter of the parameter's
 * range at full signal. Everything else is the evaluator's defaults — auto calibration, the
 * standard envelope and look-ahead (modulation-spec §7, D23/D51).
 */
export function defaultBinding(
  target: string,
  spec: ParamSpec,
  options: { readonly newId: () => string; readonly sourceType?: string; readonly order?: number },
): ModulationBinding {
  const sourceType = options.sourceType ?? suggestedSources(spec)[0] ?? 'rms';
  const binding = createBinding(target, {
    id: options.newId(),
    sourceType,
    amount: roundAmount(paramSpan(spec) * 0.25, spec),
    ...(options.order === undefined ? {} : { order: options.order }),
  });
  return sourceType === 'band' ? { ...binding, source: { ...binding.source, band: 'bass' } } : binding;
}

function roundAmount(value: number, spec: ParamSpec): number {
  if (spec.type === 'int' || spec.type === 'enum') return Math.max(1, Math.round(value));
  return Number(value.toPrecision(3));
}

// ---------------------------------------------------------------------------
// Recipes (modulation-spec §11)
// ---------------------------------------------------------------------------

export interface Recipe {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** A fully configured binding for `target`, scaled to its parameter. */
  make(target: string, spec: ParamSpec, newId: () => string): ModulationBinding;
}

function recipe(
  id: string,
  name: string,
  description: string,
  shape: (base: ModulationBinding, span: number) => ModulationBinding,
): Recipe {
  return {
    id,
    name,
    description,
    make(target, spec, newId) {
      const base = createBinding(target, { id: newId() });
      const made = shape(base, paramSpan(spec));
      return { ...made, amount: roundAmount(made.amount, spec), label: name };
    },
  };
}

/**
 * The gestures most bindings are, as one click. Sources are the mix until stems are wired into the
 * studio (M5); a recipe re-pointed at a stem later keeps everything else. The spec's structural and
 * lyric recipes (build riser, drop flash, lyric dim) wait for those sources.
 */
export const RECIPES: readonly Recipe[] = [
  recipe('kick-pump', 'Kick pump', 'A snappy push on every hit.', (b, span) => ({
    ...b,
    source: { ...b.source, type: 'onset' },
    curve: { ...b.curve, type: 'threshold', amount: 0.3 },
    envelope: { ...b.envelope, attackMs: 2, releaseMs: 90 },
    amount: span * 0.15,
  })),
  recipe('bass-glow', 'Bass glow', 'Swells with the low end.', (b, span) => ({
    ...b,
    source: { ...b.source, type: 'band', band: 'bass' },
    curve: { ...b.curve, type: 's-curve', amount: 0.5 },
    envelope: { ...b.envelope, attackMs: 30, releaseMs: 250 },
    amount: span * 0.4,
  })),
  recipe('level-bloom', 'Level bloom', 'Opens up as the track gets louder.', (b) => ({
    ...b,
    source: { ...b.source, type: 'rms' },
    curve: { ...b.curve, type: 'exp', amount: 0.5 },
    envelope: { ...b.envelope, attackMs: 40, releaseMs: 300 },
    mode: 'multiply',
    amount: 0.5,
  })),
  recipe('hat-sparkle', 'Hat sparkle', 'Flickers with the top end — hats and cymbals.', (b, span) => ({
    ...b,
    source: { ...b.source, type: 'band', band: 'brilliance' },
    curve: { ...b.curve, type: 'threshold', amount: 0.4 },
    envelope: { ...b.envelope, attackMs: 1, releaseMs: 60 },
    amount: span * 0.3,
  })),
  recipe('hue-drift', 'Hue drift', 'Follows the brightness of the sound, slowly.', (b, span) => ({
    ...b,
    source: { ...b.source, type: 'centroid' },
    envelope: { ...b.envelope, attackMs: 400, releaseMs: 1200, mode: 'linear' },
    amount: span * 0.2,
  })),
  recipe('beat-pulse', 'Beat pulse', 'A regular pulse locked to the beat grid.', (b, span) => ({
    ...b,
    source: { ...b.source, type: 'beat' },
    envelope: { ...b.envelope, attackMs: 1, releaseMs: 120 },
    amount: span * 0.2,
  })),
  recipe('breathing', 'Breathing', 'A slow wave that keeps still moments alive.', (b, span) => ({
    ...b,
    source: { ...b.source, type: 'lfo', shape: 'sine', rateHz: 0.25 },
    envelope: { ...b.envelope, attackMs: 0, releaseMs: 0 },
    lookAheadMs: 0,
    amount: span * 0.06,
    offset: -span * 0.03,
  })),
];

// ---------------------------------------------------------------------------
// Reading bindings back
// ---------------------------------------------------------------------------

export interface TargetPath {
  readonly layerId: string;
  /** Set for a parameter of an effect in the layer's chain. */
  readonly effectId: string | null;
  readonly key: string;
}

export function parseTarget(target: string): TargetPath | undefined {
  const effect = /^layers\.([^.]+)\.effects\.([^.]+)\.params\.(.+)$/.exec(target);
  if (effect !== null) return { layerId: effect[1]!, effectId: effect[2]!, key: effect[3]! };
  const param = /^layers\.([^.]+)\.params\.(.+)$/.exec(target);
  if (param !== null) return { layerId: param[1]!, effectId: null, key: param[2]! };
  return undefined;
}

export function layerParamTarget(layerId: string, key: string): string {
  return `layers.${layerId}.params.${key}`;
}

export function effectParamTarget(layerId: string, effectId: string, key: string): string {
  return `layers.${layerId}.effects.${effectId}.params.${key}`;
}

/** Module schemas by id, as the UI already holds them. */
export type SchemaLookup = (moduleId: string) => { readonly name: string; readonly params: readonly ParamSpec[] } | undefined;

export interface TargetInfo {
  /** "Bars › Bar count", "Bars › Bloom › Intensity". */
  readonly label: string;
  readonly spec: ParamSpec | undefined;
  /** Why the target does not resolve, when it does not. */
  readonly problem: string | null;
}

/** What a target path points at, in the UI's words — or why it points at nothing. */
export function describeTarget(document: ProjectDocument, target: string, schemas: SchemaLookup): TargetInfo {
  const path = parseTarget(target);
  if (path === undefined) return { label: target, spec: undefined, problem: 'not a parameter path this build understands' };
  const layer = findAnyLayer(document.layers, path.layerId);
  if (layer === undefined) return { label: target, spec: undefined, problem: 'its layer no longer exists' };
  const layerName = layer.name === '' ? '(unnamed)' : layer.name;
  if (path.effectId === null) {
    if (layer.kind !== 'module') return { label: `${layerName} › ${path.key}`, spec: undefined, problem: 'groups have no parameters' };
    const schema = schemas(layer.module);
    const spec = schema?.params.find((p) => p.key === path.key);
    return {
      label: `${layerName} › ${spec?.label ?? path.key}`,
      spec,
      problem: schema === undefined ? `module ${layer.module} is not installed` : spec === undefined ? `${schema.name} has no parameter "${path.key}"` : null,
    };
  }
  const effect = layer.effects.find((e) => e.id === path.effectId);
  if (effect === undefined) return { label: `${layerName} › effect › ${path.key}`, spec: undefined, problem: 'its effect was removed' };
  const schema = schemas(effect.module);
  const spec = schema?.params.find((p) => p.key === path.key);
  const effectName = effect.name !== '' ? effect.name : schema?.name ?? effect.module;
  return {
    label: `${layerName} › ${effectName} › ${spec?.label ?? path.key}`,
    spec,
    problem: schema === undefined ? `effect ${effect.module} is not installed` : spec === undefined ? `${effectName} has no parameter "${path.key}"` : null,
  };
}

function findAnyLayer(layers: readonly Layer[], id: string): Layer | undefined {
  for (const { layer } of walkLayers(layers)) if (layer.id === id) return layer;
  return undefined;
}

/** Every binding in the project, with the layer that stores it — the matrix panel's rows. */
export function allBindings(document: ProjectDocument): { readonly ownerId: string; readonly binding: ModulationBinding }[] {
  const rows: { ownerId: string; binding: ModulationBinding }[] = [];
  for (const { layer } of walkLayers(document.layers)) {
    for (const binding of layer.modulations) rows.push({ ownerId: layer.id, binding });
  }
  return rows;
}

/**
 * Too weak to see (modulation-spec §10 "dead-binding warnings"): at full signal it moves the
 * parameter by less than 1% of its range. An additive binding is measured by `amount`; a
 * multiplying one by the factor it applies. A replacing binding always shows.
 */
export function isImperceptible(binding: ModulationBinding, spec: ParamSpec | undefined): boolean {
  if (spec === undefined || binding.mode === 'replace') return false;
  if (binding.mode === 'multiply') return Math.abs(binding.amount) < 0.01;
  const span = paramSpan(spec);
  return span > 0 && Math.abs(binding.amount) < span * 0.01;
}

/** One line saying what drives a binding: "Onsets · drums", "Band bass · mix", "LFO sine 0.25 Hz". */
export function describeSource(binding: ModulationBinding): string {
  const { source } = binding;
  const choice = SOURCE_CHOICES.find((c) => c.type === source.type);
  const name = choice?.label ?? source.type;
  if (source.type === 'band') return `${source.band ?? '?'} band · ${source.stem}`;
  if (source.type === 'lfo') return `LFO ${source.shape} ${source.rateHz} Hz`;
  if (choice?.audio === true) return `${name} · ${source.stem}`;
  return name;
}
