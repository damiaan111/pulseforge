// Timeline markers (S9, ui-spec §3): named, coloured points that the timeline snaps to, the
// transport jumps between, an export can use as its range, and a binding can react to.
//
// Every edit is an undoable command (CLAUDE.md conventions); markers stay sorted by ticks. The
// helpers at the end are pure, for the timeline, the transport and the export dialog alike.

import type { Command } from './history.ts';
import type { Marker, ProjectDocument } from './document.ts';

const sorted = (markers: readonly Marker[]) => [...markers].sort((a, b) => a.ticks - b.ticks);

const HEX = /^#[0-9a-fA-F]{6}$/;

/** "Marker 3" — the first free number, so deleting one and adding another does not skip. */
export function defaultMarkerName(markers: readonly Marker[]): string {
  const used = new Set(markers.map((m) => m.name));
  for (let n = markers.length + 1; ; n += 1) {
    const name = `Marker ${n}`;
    if (!used.has(name)) return name;
  }
}

export function addMarker(ticks: number, options: { readonly id: string; readonly name?: string; readonly color?: string | null }): Command {
  const at = Math.max(0, Math.round(ticks));
  return {
    label: 'Add marker',
    apply: (document) => ({
      ...document,
      markers: sorted([...document.markers, {
        id: options.id,
        ticks: at,
        name: options.name ?? defaultMarkerName(document.markers),
        color: options.color != null && HEX.test(options.color) ? options.color.toLowerCase() : null,
        extra: {},
      }]),
    }),
  };
}

export function removeMarkers(ids: readonly string[]): Command {
  const gone = new Set(ids);
  return {
    label: ids.length === 1 ? 'Delete marker' : 'Delete markers',
    apply: (document) => ({ ...document, markers: document.markers.filter((m) => !gone.has(m.id)) }),
  };
}

/** A drag passes `mergeKey`, so the whole drag is one undo step. */
export function moveMarker(id: string, ticks: number, mergeKey?: string): Command {
  const at = Math.max(0, Math.round(ticks));
  return {
    label: 'Move marker',
    ...(mergeKey === undefined ? {} : { mergeKey }),
    apply: (document) => ({ ...document, markers: sorted(document.markers.map((m) => (m.id === id ? { ...m, ticks: at } : m))) }),
  };
}

export function renameMarker(id: string, name: string): Command {
  return {
    label: 'Rename marker',
    mergeKey: `marker-name:${id}`,
    apply: (document) => ({ ...document, markers: document.markers.map((m) => (m.id === id ? { ...m, name } : m)) }),
  };
}

export function setMarkerColor(id: string, color: string | null): Command {
  if (color !== null && !HEX.test(color)) throw new RangeError(`not a "#rrggbb" colour: ${color}`);
  return {
    label: 'Marker colour',
    apply: (document) => ({ ...document, markers: document.markers.map((m) => (m.id === id ? { ...m, color: color === null ? null : color.toLowerCase() } : m)) }),
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * The next (or previous) place to jump to from `ticks`: a marker, or — so the keys are useful on a
 * project with no markers yet — a section boundary. Strictly after (before) `ticks`, with a small
 * tolerance so jumping from a marker does not land on the same marker again.
 */
export function neighbourStop(stops: readonly number[], ticks: number, direction: 1 | -1, toleranceTicks = 1): number | null {
  const ordered = [...new Set(stops)].sort((a, b) => a - b);
  if (direction === 1) return ordered.find((t) => t > ticks + toleranceTicks) ?? null;
  for (let i = ordered.length - 1; i >= 0; i -= 1) if ((ordered[i] as number) < ticks - toleranceTicks) return ordered[i] as number;
  return null;
}

/** The nearest target within `thresholdTicks` of `wanted`, or null. */
export function nearestTarget(wanted: number, targets: readonly number[], thresholdTicks: number): number | null {
  let best: number | null = null;
  for (const t of targets) {
    if (Math.abs(t - wanted) <= thresholdTicks && (best === null || Math.abs(t - wanted) < Math.abs(best - wanted))) best = t;
  }
  return best;
}

/** Marker ticks, optionally leaving some out (the ones being dragged must not snap to themselves). */
export function markerTicks(document: Pick<ProjectDocument, 'markers'>, except: ReadonlySet<string> = new Set()): number[] {
  return document.markers.filter((m) => !except.has(m.id)).map((m) => m.ticks);
}
