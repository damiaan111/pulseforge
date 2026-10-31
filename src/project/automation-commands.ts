// Keyframe edits (S1, docs/keyframes-spec.md §5), each an undoable command (CLAUDE.md conventions).
//
// A track is found by its target; setting a key on a target with no track creates the track. At
// most one key per tick per track: setting a key where one exists updates it (keeping its id and
// easing), and moving a key onto another replaces that one — the key being moved is the one the
// user is holding. Keys stay sorted by ticks.

import { sampleCurve } from '../engine/core/modulation.ts';
import { ticksToSeconds } from '../engine/core/time.ts';
import type { Command } from './history.ts';
import type { AutomationTrack, Keyframe, KeyframeEasing, Layer, ModulationBinding, ProjectDocument } from './document.ts';
import { allBindings, describeTarget, parseTarget, targetBase, type SchemaLookup } from './modulation-authoring.ts';

export function trackFor(document: ProjectDocument, target: string): AutomationTrack | undefined {
  return document.automation.find((t) => t.target === target);
}

const sorted = (keys: readonly Keyframe[]) => [...keys].sort((a, b) => a.ticks - b.ticks);

function withTracks(document: ProjectDocument, fn: (track: AutomationTrack) => AutomationTrack | null): ProjectDocument {
  const automation: AutomationTrack[] = [];
  for (const track of document.automation) {
    const next = fn(track);
    if (next !== null) automation.push(next);
  }
  return { ...document, automation };
}

/**
 * A key at `ticks` with `value`: updates the key already there, or adds one (creating the track).
 * `mergeKey` makes a slider drag at one moment a single undo step.
 */
export function setKeyframe(
  target: string,
  ticks: number,
  value: Keyframe['value'],
  options: { readonly newId: () => string; readonly easing?: KeyframeEasing; readonly label?: string },
): Command {
  const at = Math.max(0, Math.round(ticks));
  return {
    label: options.label ?? 'Set keyframe',
    mergeKey: `keyframe:${target}:${at}`,
    apply: (document) => {
      const track = trackFor(document, target);
      if (track === undefined) {
        const created: AutomationTrack = {
          id: options.newId(), target, enabled: true, extra: {},
          keyframes: [{ id: options.newId(), ticks: at, value, easing: options.easing ?? 'linear', extra: {} }],
        };
        return { ...document, automation: [...document.automation, created] };
      }
      return withTracks(document, (t) => {
        if (t.id !== track.id) return t;
        const existing = t.keyframes.find((k) => k.ticks === at);
        const keyframes = existing !== undefined
          ? t.keyframes.map((k) => (k.id === existing.id ? { ...k, value, ...(options.easing === undefined ? {} : { easing: options.easing }) } : k))
          : sorted([...t.keyframes, { id: options.newId(), ticks: at, value, easing: options.easing ?? inheritedEasing(t.keyframes, at), extra: {} }]);
        return { ...t, keyframes };
      });
    },
  };
}

/** A new key between two takes the easing of the key before it, so inserting does not change the feel. */
function inheritedEasing(keys: readonly Keyframe[], ticks: number): KeyframeEasing {
  let before: Keyframe | undefined;
  for (const k of keys) if (k.ticks < ticks) before = k;
  return before?.easing ?? 'linear';
}

/** Removes keys by id; a track left with no keys is removed too (the base shows again). */
export function removeKeyframes(ids: readonly string[], label = ids.length === 1 ? 'Delete keyframe' : 'Delete keyframes'): Command {
  const gone = new Set(ids);
  return {
    label,
    apply: (document) => withTracks(document, (t) => {
      const keyframes = t.keyframes.filter((k) => !gone.has(k.id));
      if (keyframes.length === t.keyframes.length) return t;
      return keyframes.length === 0 ? null : { ...t, keyframes };
    }),
  };
}

/**
 * Moves keys by `deltaTicks` (a timeline drag; one undo step with `mergeKey`). Clamped at 0; a key
 * landing on another key's tick replaces it.
 */
export function moveKeyframes(ids: readonly string[], deltaTicks: number, mergeKey?: string): Command {
  const moving = new Set(ids);
  const delta = Math.round(deltaTicks);
  return {
    label: ids.length === 1 ? 'Move keyframe' : 'Move keyframes',
    ...(mergeKey === undefined ? {} : { mergeKey }),
    apply: (document) => withTracks(document, (t) => {
      if (!t.keyframes.some((k) => moving.has(k.id))) return t;
      const moved = t.keyframes.filter((k) => moving.has(k.id)).map((k) => ({ ...k, ticks: Math.max(0, k.ticks + delta) }));
      const landed = new Set(moved.map((k) => k.ticks));
      const stay = t.keyframes.filter((k) => !moving.has(k.id) && !landed.has(k.ticks));
      // Two moved keys on one tick (clamped at 0): the later one wins.
      const byTick = new Map<number, Keyframe>();
      for (const k of moved) byTick.set(k.ticks, k);
      return { ...t, keyframes: sorted([...stay, ...byTick.values()]) };
    }),
  };
}

/** One key's time, typed in the editor. */
export function setKeyframeTime(id: string, ticks: number): Command {
  return {
    label: 'Set keyframe time',
    apply: (document) => {
      for (const t of document.automation) {
        const k = t.keyframes.find((key) => key.id === id);
        if (k !== undefined) return moveKeyframes([id], Math.max(0, Math.round(ticks)) - k.ticks).apply(document);
      }
      return document;
    },
  };
}

export function setKeyframeValue(id: string, value: Keyframe['value']): Command {
  return {
    label: 'Set keyframe value',
    mergeKey: `keyframe-value:${id}`,
    apply: (document) => withTracks(document, (t) => (t.keyframes.some((k) => k.id === id)
      ? { ...t, keyframes: t.keyframes.map((k) => (k.id === id ? { ...k, value } : k)) }
      : t)),
  };
}

export function setKeyframeEasing(ids: readonly string[], easing: KeyframeEasing): Command {
  const which = new Set(ids);
  return {
    label: 'Set easing',
    mergeKey: `easing:${[...which].sort().join(',')}`,
    apply: (document) => withTracks(document, (t) => (t.keyframes.some((k) => which.has(k.id))
      ? { ...t, keyframes: t.keyframes.map((k) => (which.has(k.id) ? { ...k, easing } : k)) }
      : t)),
  };
}

export function setTrackEnabled(trackId: string, enabled: boolean): Command {
  return {
    label: enabled ? 'Enable keyframes' : 'Disable keyframes',
    apply: (document) => withTracks(document, (t) => (t.id === trackId ? { ...t, enabled } : t)),
  };
}

export function removeTrack(trackId: string): Command {
  return {
    label: 'Remove keyframes',
    apply: (document) => withTracks(document, (t) => (t.id === trackId ? null : t)),
  };
}

// ---------------------------------------------------------------------------
// Arrangement curves → keyframes
// ---------------------------------------------------------------------------

/** The curve bindings the arranger writes, by label: ordinary bindings the timeline cannot edit. */
export const ARRANGEMENT_CURVE_LABELS: readonly string[] = ['Section intensity', 'Drop', 'Section presence', 'Fade'];

export interface CurveBake {
  readonly target: string;
  /** "Radial › Inner glow". */
  readonly label: string;
  readonly bindingIds: readonly string[];
  readonly keys: readonly { readonly ticks: number; readonly value: number }[];
}

export interface CurveBakePlan {
  readonly bakes: readonly CurveBake[];
  /** What stays a curve, and why: nothing is left out without saying so. */
  readonly skipped: readonly { readonly label: string; readonly reason: string }[];
}

/** A binding the keys can reproduce exactly: its signal is the curve itself, shaped by nothing. */
function plainCurve(b: ModulationBinding): boolean {
  return (b.mode === 'add' || b.mode === 'multiply') && !b.invert && b.curve.type === 'linear' && b.quantise === null && b.lookAheadMs === 0
    && b.envelope.attackMs === 0 && b.envelope.releaseMs === 0 && b.inputRange === 'auto' && b.source.points.length > 0;
}

/**
 * What baking the arrangement curves would do. Everything on one target merges into one track: the
 * value at each key is the base run through that target's curves in their engine order, at every
 * tick any of them has a point (between points they are all straight lines, so keys are exact).
 *
 * That reproduces the curves, not the whole result. Keys replace the base BEFORE modulation; these
 * curves ran AFTER whatever preceded them in the chain, so anything else on the target (an
 * audio-driven binding, say) is no longer scaled by the section once baked. The panel says so.
 */
export function planCurveBake(document: ProjectDocument, schemas: SchemaLookup): CurveBakePlan {
  const byTarget = new Map<string, ModulationBinding[]>();
  for (const { binding } of allBindings(document)) {
    if (!binding.enabled || binding.source.type !== 'curve' || !ARRANGEMENT_CURVE_LABELS.includes(binding.label ?? '')) continue;
    byTarget.set(binding.target, [...(byTarget.get(binding.target) ?? []), binding]);
  }
  const bakes: CurveBake[] = [];
  const skipped: { label: string; reason: string }[] = [];
  for (const [target, bindings] of byTarget) {
    const info = describeTarget(document, target, schemas);
    const skip = (reason: string) => skipped.push({ label: info.label, reason });
    if (info.problem !== null || info.spec === undefined) skip(info.problem ?? 'it is not a parameter');
    else if (info.spec.type !== 'float' && info.spec.type !== 'int') skip('it is not a number');
    else if (document.automation.some((t) => t.target === target)) skip('it already has keyframes, which baking would overwrite');
    else if (!bindings.every(plainCurve)) skip('a curve on it has its own shaping, which keyframes cannot reproduce');
    else if (hasAspectOverride(document, target)) skip('it has an aspect override, which keyframes would replace');
    else {
      const base = targetBase(document, target, info.spec);
      // The engine's own order (modulation.ts): by `order`, then by id.
      const chain = [...bindings].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const ticks = [...new Set(chain.flatMap((b) => b.source.points.map((p) => p.ticks)))].sort((a, b) => a - b);
      const keys = ticks.map((tick) => {
        const seconds = ticksToSeconds(tick);
        let value = base;
        for (const binding of chain) {
          let out = sampleCurve(binding.source.points, seconds) * binding.amount + binding.offset;
          if (binding.clampOutput !== null) out = Math.min(binding.clampOutput.max, Math.max(binding.clampOutput.min, out));
          value = binding.mode === 'add' ? value + out : value * (1 + out);
        }
        return { ticks: tick, value: Number(value.toPrecision(6)) };
      });
      bakes.push({ target, label: info.label, bindingIds: chain.map((b) => b.id), keys });
    }
  }
  return { bakes, skipped };
}

function hasAspectOverride(document: ProjectDocument, target: string): boolean {
  const path = parseTarget(target);
  if (path === undefined || path.effectId !== null || path.layerProperty === true) return false;
  const stack: readonly Layer[] = document.layers;
  const find = (layers: readonly Layer[]): Layer | undefined => {
    for (const layer of layers) {
      if (layer.id === path.layerId) return layer;
      const inner = layer.kind === 'group' ? find(layer.children) : undefined;
      if (inner !== undefined) return inner;
    }
    return undefined;
  };
  return Object.values(find(stack)?.aspectOverrides ?? {}).some((o) => o !== undefined && path.key in o.params);
}

function withoutBindings(layers: readonly Layer[], gone: ReadonlySet<string>): Layer[] {
  return layers.map((layer) => {
    const modulations = layer.modulations.some((b) => gone.has(b.id)) ? layer.modulations.filter((b) => !gone.has(b.id)) : layer.modulations;
    return layer.kind === 'group'
      ? { ...layer, modulations, children: withoutBindings(layer.children, gone) }
      : { ...layer, modulations };
  });
}

/** Bakes the arrangement curves to keyframe tracks, one track per target, as one undo step. */
export function bakeArrangementCurves(schemas: SchemaLookup, options: { readonly newId: () => string }): Command {
  return {
    label: 'Curves to keyframes',
    apply: (document) => {
      const { bakes } = planCurveBake(document, schemas);
      if (bakes.length === 0) return document;
      const gone = new Set(bakes.flatMap((b) => b.bindingIds));
      const tracks = bakes.map((bake): AutomationTrack => ({
        id: options.newId(),
        target: bake.target,
        enabled: true,
        keyframes: bake.keys.map((k) => ({ id: options.newId(), ticks: k.ticks, value: k.value, easing: 'linear', extra: {} })),
        extra: {},
      }));
      return {
        ...document,
        layers: withoutBindings(document.layers, gone),
        globalModulations: document.globalModulations.filter((b) => !gone.has(b.id)),
        automation: [...document.automation, ...tracks],
      };
    },
  };
}
