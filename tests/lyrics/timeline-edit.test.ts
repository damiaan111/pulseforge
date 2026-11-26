// Editing lyric timing on the timeline (lyrics-spec §5): drags planned from the start state,
// snapping, ripple, word boundaries, navigation.

import { describe, expect, it } from 'vitest';

import { TICKS_PER_SECOND } from '../../src/engine/core/time.ts';
import {
  MIN_DRAG_TICKS, dragEdgeTicks, neighbourLine, planLyricDrag, snapDelta, snapTargets, splitIndexAt, type LyricDrag,
} from '../../src/lyrics/timeline-edit.ts';
import { createDocument } from '../../src/project/create.ts';
import type { ProjectDocument } from '../../src/project/document.ts';
import { History } from '../../src/project/history.ts';
import { createTestIdFactory, isValidId } from '../../src/project/ids.ts';
import { setLineTimes, setLineTimings, setLyricsText } from '../../src/project/lyrics-commands.ts';

const T = (s: number) => Math.round(s * TICKS_PER_SECOND);

function doc(): ProjectDocument {
  let d = setLyricsText('one two\nthree four\nfive', createTestIdFactory('7')).apply(createDocument({ timestamp: '2026-01-01T00:00:00.000Z' }));
  const [a, b, c] = d.lyrics.lines;
  d = setLineTimes(a!.id, T(1), T(2)).apply(d);
  d = setLineTimes(b!.id, T(3), T(4)).apply(d);
  d = setLineTimes(c!.id, T(10), T(11)).apply(d);
  return d;
}
const ids = (d: ProjectDocument) => d.lyrics.lines.map((l) => l.id);
const drag = (d: ProjectDocument, patch: Partial<LyricDrag>): LyricDrag => ({ kind: 'move', lineId: ids(d)[0]!, lineIds: [], wordIndex: 0, ripple: false, ...patch });

describe('planning a drag', () => {
  it('moves a line, or the selection, and ripples everything after', () => {
    const d = doc();
    expect(planLyricDrag(d.lyrics, drag(d, {}), T(0.5)).map((c) => c.startTicks)).toEqual([T(1.5)]);
    expect(planLyricDrag(d.lyrics, drag(d, { lineIds: ids(d).slice(0, 2) }), T(0.5)).map((c) => c.startTicks)).toEqual([T(1.5), T(3.5)]);
    const ripple = planLyricDrag(d.lyrics, drag(d, { lineId: ids(d)[1]!, ripple: true }), T(-0.5));
    expect(ripple.map((c) => c.startTicks)).toEqual([T(2.5), T(9.5)]);
  });

  it('clamps a move at 0 for the whole group', () => {
    const d = doc();
    const moved = planLyricDrag(d.lyrics, drag(d, { lineIds: ids(d).slice(0, 2) }), T(-5));
    expect(moved.map((c) => c.startTicks)).toEqual([0, T(2)]);
  });

  it('is planned from the start state, so a drag out and back changes nothing', () => {
    const d = doc();
    const history = new History(d);
    for (const delta of [T(0.3), T(0.8), 0]) history.run(setLineTimings(planLyricDrag(d.lyrics, drag(d, {}), delta), 'Move line', 'lyric-drag:1'));
    expect(history.entries).toHaveLength(2);
    expect(history.current.lyrics.lines[0]).toEqual(d.lyrics.lines[0]);
  });

  it('resizes edges without inverting the line', () => {
    const d = doc();
    expect(planLyricDrag(d.lyrics, drag(d, { kind: 'start' }), T(0.4))[0]).toMatchObject({ startTicks: T(1.4), endTicks: T(2) });
    expect(planLyricDrag(d.lyrics, drag(d, { kind: 'start' }), T(5))[0]?.startTicks).toBe(T(2) - MIN_DRAG_TICKS);
    expect(planLyricDrag(d.lyrics, drag(d, { kind: 'end' }), T(-5))[0]?.endTicks).toBe(T(1) + MIN_DRAG_TICKS);
  });

  it('moves a word boundary, keeping the words contiguous, with stable ids', () => {
    const d = doc();
    // "one two" over 1..2 s by characters: the boundary sits at 1.5 s.
    const [change] = planLyricDrag(d.lyrics, drag(d, { kind: 'word', wordIndex: 1 }), T(0.2));
    expect(change?.words.map((w) => [w.startTicks, w.endTicks])).toEqual([[T(1), T(1.7)], [T(1.7), T(2)]]);
    expect(change?.words.every((w) => isValidId(w.id))).toBe(true);
    expect(planLyricDrag(d.lyrics, drag(d, { kind: 'word', wordIndex: 1 }), T(0.2))[0]?.words[0]?.id).toBe(change?.words[0]?.id);
    // Never past its neighbours.
    expect(planLyricDrag(d.lyrics, drag(d, { kind: 'word', wordIndex: 1 }), T(9))[0]?.words[1]?.startTicks).toBeLessThan(T(2));
  });
});

describe('snapping and navigation', () => {
  it('snaps the moving edge to the nearest target in range, ignoring the moving lines', () => {
    const d = doc();
    const moving = drag(d, {});
    const targets = snapTargets(d.lyrics, moving, [T(1.62)]);
    expect(targets).not.toContain(T(1));
    expect(dragEdgeTicks(d.lyrics, moving)).toBe(T(1));
    expect(snapDelta(T(1), T(0.6), targets, T(0.05))).toBe(T(0.62));
    expect(snapDelta(T(1), T(0.3), targets, T(0.05))).toBe(T(0.3));
    // The end of a resize snaps to the next line's start.
    expect(snapDelta(T(2), T(0.97), snapTargets(d.lyrics, drag(d, { kind: 'end' }), []), T(0.05))).toBe(T(1));
  });

  it('steps between timed lines in time order, and finds where to split at the playhead', () => {
    const d = doc();
    expect(neighbourLine(d.lyrics, null, 1)?.text).toBe('one two');
    expect(neighbourLine(d.lyrics, ids(d)[0]!, 1)?.text).toBe('three four');
    expect(neighbourLine(d.lyrics, ids(d)[2]!, 1)?.text).toBe('five');
    expect(splitIndexAt(d.lyrics.lines[0]!, T(1.2))).toBe(1);
    expect(splitIndexAt(d.lyrics.lines[0]!, T(1.9))).toBe(null);
  });
});
