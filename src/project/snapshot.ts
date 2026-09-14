// Document → the immutable snapshot the engine renders.
//
// This is the only bridge between the editable document and `src/engine/`. The engine never
// sees a ProjectDocument: it sees a flat, resolved RenderProject, which is what makes headless
// rendering and golden-frame tests possible.
//
// Where the document asks for something this build's engine cannot yet draw — a mask, a blend
// mode the compositor lacks, a group's own transform — the request is **reported as a note,
// never dropped** (CLAUDE.md constraint 4). A caller that ignores the notes still gets a
// correct render of everything that is implemented; a caller that surfaces them tells the user
// exactly what is missing and why.

import { isIdentityTransform, type LayerTransform } from '../engine/core/layout.ts';
import type { ModulationBinding } from '../engine/core/modulation.ts';
import type { BlendMode, EffectSpec, LayerSpec, RenderProject } from '../engine/core/project.ts';
import {
  aspectBucket, walkLayers, type AspectBucket, type AspectOverride, type Layer,
  type EffectSpec as DocumentEffect, type ModulationBinding as DocumentBinding,
  type ProjectDocument,
} from './document.ts';

/** Something the document specifies that this engine build does not yet render. */
export interface SnapshotNote {
  readonly path: string;
  readonly detail: string;
}

export interface SnapshotResult {
  readonly project: RenderProject;
  readonly notes: readonly SnapshotNote[];
  /** Which aspect bucket's overrides apply to this canvas (PROJECT.md §8.11). */
  readonly aspect: AspectBucket;
}

/** Blend modes the compositor implements today; the rest fall back to `normal` with a note. */
const ENGINE_BLEND_MODES: readonly BlendMode[] = ['normal', 'add', 'screen'];

/** Document effect → engine effect: the id, the module and the stored params, nothing else. */
function toEngineEffect(effect: DocumentEffect): EffectSpec {
  return { id: effect.id, module: effect.module, enabled: effect.enabled, params: effect.params };
}

/**
 * Document binding → engine binding. The two are deliberately separate types: the engine may
 * not import `src/project/`, and the document's `extra` bags have no meaning past this point.
 * A source the engine does not recognise still arrives intact and is reported by the compiler.
 */
function toEngineBinding(binding: DocumentBinding): ModulationBinding {
  const { source } = binding;
  return {
    id: binding.id,
    enabled: binding.enabled,
    source: {
      type: source.type,
      stem: source.stem,
      band: source.band,
      shape: source.shape,
      rateHz: source.rateHz,
      phase: source.phase,
      syncDivision: source.syncDivision,
      noiseScale: source.noiseScale,
      octaves: source.octaves,
      from: source.from,
      to: source.to,
    },
    target: binding.target,
    inputRange: binding.inputRange,
    curve: { type: binding.curve.type, amount: binding.curve.amount },
    envelope: { attackMs: binding.envelope.attackMs, releaseMs: binding.envelope.releaseMs, mode: binding.envelope.mode },
    quantise: binding.quantise === null
      ? null
      : { division: binding.quantise.division, mode: binding.quantise.mode, swing: binding.quantise.swing, humanise: binding.quantise.humanise },
    lookAheadMs: binding.lookAheadMs,
    amount: binding.amount,
    offset: binding.offset,
    invert: binding.invert,
    mode: binding.mode,
    order: binding.order,
    clampOutput: binding.clampOutput,
  };
}

/**
 * Base → aspect override, step 2 of the value resolution pipeline (module-spec §5). The
 * override *replaces* the properties it declares and leaves the rest inheriting the base —
 * which is why `AspectOverride.transform` is a partial and not a whole transform.
 */
function resolveTransform(layer: Layer, override: AspectOverride | undefined): LayerTransform {
  const { extra: _extra, ...base } = layer.transform;
  return override === undefined ? base : { ...base, ...override.transform };
}

function resolveParams(layer: Layer & { params: Readonly<Record<string, unknown>> }, override: AspectOverride | undefined): Readonly<Record<string, unknown>> {
  if (override === undefined || Object.keys(override.params).length === 0) return layer.params;
  return { ...layer.params, ...override.params };
}

/**
 * Flattens groups into the engine's flat layer list. Group *compositing* (M38 — children
 * rendered into one target, then the group's own transform, opacity, blend and effects applied
 * to that result) is still to come; until then a group's children render in place and the
 * group's own settings are reported rather than silently ignored.
 */
export function toRenderProject(document: ProjectDocument): SnapshotResult {
  const notes: SnapshotNote[] = [];
  const { canvas } = document;
  const aspect = aspectBucket(canvas.width, canvas.height);

  const anySoloed = [...walkLayers(document.layers)].some(({ layer }) => layer.soloed);

  const layers: LayerSpec[] = [];
  let index = 0;
  for (const { layer, parents } of walkLayers(document.layers)) {
    const path = `layers[${index}]`;
    index += 1;

    const override = layer.aspectOverrides[aspect];

    if (layer.kind === 'group') {
      if (layer.opacity !== 1 || layer.blend !== 'normal' || layer.effects.length > 0
        || !isIdentityTransform(resolveTransform(layer, override))) {
        notes.push({ path, detail: `group "${layer.name || layer.id}" has its own transform, opacity, blend or effects; group compositing (M38) is not implemented yet, so its children render in place` });
      }
      continue;
    }

    // A disabled group hides its children, which flattening would otherwise lose.
    const hiddenByParent = parents.some((parent) => !parent.enabled);
    const enabled = layer.enabled && !hiddenByParent && (!anySoloed || layer.soloed);

    if (parents.some((parent) => !isIdentityTransform(resolveTransform(parent, parent.aspectOverrides[aspect])))) {
      notes.push({ path, detail: 'a parent group has a transform; group transforms do not yet compose onto their children (M38)' });
    }
    if (layer.maskLayerId !== null) {
      notes.push({ path, detail: 'masking (S7) is not implemented; the layer renders unmasked' });
    }
    let blend: BlendMode = 'normal';
    if (ENGINE_BLEND_MODES.includes(layer.blend as BlendMode)) {
      blend = layer.blend as BlendMode;
    } else {
      notes.push({ path, detail: `blend mode "${layer.blend}" is not implemented by the compositor; rendering as normal` });
    }

    layers.push({
      id: layer.id,
      module: layer.module,
      enabled,
      opacity: layer.opacity,
      blend,
      params: resolveParams(layer, override),
      timeRange: { inTicks: layer.timeRange.inTicks, outTicks: layer.timeRange.outTicks },
      transform: resolveTransform(layer, override),
      modulations: layer.modulations.map(toEngineBinding),
      effects: layer.effects.map(toEngineEffect),
    });
  }

  const project: RenderProject = {
    schemaVersion: 0,
    seed: document.seed,
    canvas: {
      width: canvas.width,
      height: canvas.height,
      fps: canvas.fps,
      background: canvas.background,
    },
    audio: {
      leadInTicks: document.audio.leadInTicks,
      clipInTicks: document.audio.clipInTicks,
    },
    layers,
    durationTicks: timelineDurationTicks(document),
    globalModulations: document.globalModulations.map(toEngineBinding),
    globalEffects: document.globalEffects.map(toEngineEffect),
  };

  return { project, notes, aspect };
}

/**
 * Total frames to render: the audio clip plus its lead-in and lead-out (PROJECT.md §8.10).
 * Layers extending past the audio do not lengthen the video — the timeline is defined by the
 * audio placement, so an accidental long time range cannot silently produce a 40-minute export.
 */
export function timelineDurationTicks(document: ProjectDocument): number {
  const { audio } = document;
  const clipEnd = audio.clipOutTicks ?? audio.durationTicks;
  const clipLength = Math.max(0, clipEnd - audio.clipInTicks);
  return audio.leadInTicks + clipLength + audio.leadOutTicks;
}
