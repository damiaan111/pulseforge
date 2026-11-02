// Markers (S9): the commands keep them sorted and named, the helpers find stops and snap targets,
// and the file format leaves every pre-S9 project's bytes alone.

import { describe, expect, it } from 'vitest';

import { createDocument } from '../../src/project/create.ts';
import type { ProjectDocument } from '../../src/project/document.ts';
import {
  addMarker, defaultMarkerName, markerTicks, moveMarker, nearestTarget, neighbourStop, removeMarkers, renameMarker, setMarkerColor,
} from '../../src/project/markers.ts';
import { parseDocument } from '../../src/project/parse.ts';
import { stringifyDocument } from '../../src/project/serialize.ts';

const doc = (): ProjectDocument => createDocument({ id: '0000000000P000000000000001', timestamp: '2026-09-26T00:00:00.000Z' });
const M1 = '0000000000M000000000000001';
const M2 = '0000000000M000000000000002';
const M3 = '0000000000M000000000000003';

describe('marker commands', () => {
  it('adds markers sorted by time, with the next free default name', () => {
    let d = addMarker(96_000, { id: M1 }).apply(doc());
    d = addMarker(48_000, { id: M2 }).apply(d);
    expect(d.markers.map((m) => [m.id, m.ticks, m.name])).toEqual([[M2, 48_000, 'Marker 2'], [M1, 96_000, 'Marker 1']]);
    d = removeMarkers([M2]).apply(d);
    expect(addMarker(0, { id: M3 }).apply(d).markers[0]!.name).toBe('Marker 2');
    expect(defaultMarkerName([])).toBe('Marker 1');
  });

  it('moves (re-sorting), renames and recolours; a colour must be #rrggbb', () => {
    let d = addMarker(10, { id: M1, name: 'Drop' }).apply(doc());
    d = addMarker(20, { id: M2, name: 'Outro' }).apply(d);
    d = moveMarker(M1, 30).apply(d);
    expect(d.markers.map((m) => m.name)).toEqual(['Outro', 'Drop']);
    d = renameMarker(M1, 'Big drop').apply(d);
    d = setMarkerColor(M1, '#FF0000').apply(d);
    expect(d.markers[1]).toMatchObject({ name: 'Big drop', color: '#ff0000' });
    expect(() => setMarkerColor(M1, 'red')).toThrow(RangeError);
    expect(moveMarker(M1, -5).apply(d).markers[0]!.ticks).toBe(0);
  });

  it('a drag is one undo step: moves share their merge key', () => {
    expect(moveMarker(M1, 1, 'drag:1').mergeKey).toBe('drag:1');
    expect(renameMarker(M1, 'a').mergeKey).toBe(renameMarker(M1, 'ab').mergeKey);
  });
});

describe('marker helpers', () => {
  it('finds the next and previous stop, never the one it is on', () => {
    const stops = [100, 200, 200, 300];
    expect(neighbourStop(stops, 200, 1)).toBe(300);
    expect(neighbourStop(stops, 200, -1)).toBe(100);
    expect(neighbourStop(stops, 300, 1)).toBeNull();
    expect(neighbourStop(stops, 50, -1)).toBeNull();
  });

  it('snaps to the nearest target within the threshold', () => {
    expect(nearestTarget(105, [100, 108, 300], 10)).toBe(108);
    expect(nearestTarget(150, [100, 300], 10)).toBeNull();
  });

  it('leaves the dragged marker out of its own targets', () => {
    const d = addMarker(20, { id: M2 }).apply(addMarker(10, { id: M1 }).apply(doc()));
    expect(markerTicks(d, new Set([M1]))).toEqual([20]);
  });
});

describe('markers in the file', () => {
  it('a project without markers saves exactly as before S9', () => {
    expect(JSON.parse(stringifyDocument(doc())).markers).toBeUndefined();
  });

  it('round-trips; a bad colour falls back with an issue, and markers load sorted', () => {
    let d = addMarker(48_000, { id: M1, name: 'Verse', color: '#3ddc97' }).apply(doc());
    d = addMarker(0, { id: M2, name: 'Intro' }).apply(d);
    const back = parseDocument(JSON.parse(stringifyDocument(d)));
    expect(back.issues).toEqual([]);
    expect(stringifyDocument(back.document)).toBe(stringifyDocument(d));

    const raw = JSON.parse(stringifyDocument(d));
    raw.markers.reverse();
    raw.markers[0].color = 'green';
    const repaired = parseDocument(raw);
    expect(repaired.document.markers.map((m) => m.name)).toEqual(['Intro', 'Verse']);
    expect(repaired.document.markers[1]!.color).toBeNull();
    expect(repaired.issues).toHaveLength(1);
  });

  it('a marker id shared with something else is reported', () => {
    const d = addMarker(0, { id: M1 }).apply(addMarker(10, { id: M1 }).apply(doc()));
    const back = parseDocument(JSON.parse(stringifyDocument(d)));
    expect(back.issues.some((i) => i.path.startsWith('markers'))).toBe(true);
  });
});
