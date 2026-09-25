// Keyframe edits (S1, docs/keyframes-spec.md §5), each an undoable command (CLAUDE.md conventions).
//
// A track is found by its target; setting a key on a target with no track creates the track. At
// most one key per tick per track: setting a key where one exists updates it (keeping its id and
// easing), and moving a key onto another replaces that one — the key being moved is the one the
// user is holding. Keys stay sorted by ticks.

import type { Command } from './history.ts';
import type { AutomationTrack, Keyframe, KeyframeEasing, ProjectDocument } from './document.ts';

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
