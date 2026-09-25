// Editing lyric timing on the timeline (lyrics-spec §5; M19 "drag-adjust"): the maths, pure.
//
// A drag is planned from the lyrics **as they were when the drag began** plus the total distance
// moved, and applied as absolute timings (`setLineTimings`) under one merge key. So a drag is one
// undo step however many pointer moves it took, and nothing compounds: moving 30 px and back
// leaves the line exactly where it started.
//
// What can be dragged:
//  - a line's body: the line and its words move (several selected lines move together); with
//    **ripple** everything from the earliest moved line on moves too — the fix when the whole
//    second half is uniformly late (§5);
//  - a line's start or end edge: the words rescale with the line, as `setLineTimes` does;
//  - the boundary between two words of a line: the later word's start and the earlier word's end,
//    both — the word blocks stay contiguous where they were.
//
// Snapping (§5, ui-spec §3): the moving edge lands on the nearest target within a few pixels —
// vocal onsets by default, the beat grid when asked, the edges of other lines, the playhead.

import { lyricTokens, wordSpans } from '../engine/core/lyrics.ts';
import { TICKS_PER_SECOND } from '../engine/core/time.ts';
import type { LyricLine, LyricWord, Lyrics } from '../project/document.ts';
import { nearestWithin, type LineTiming } from './tap.ts';

export type LyricDragKind = 'move' | 'start' | 'end' | 'word';

export interface LyricDrag {
  readonly kind: LyricDragKind;
  /** The line under the pointer. */
  readonly lineId: string;
  /** For `move`: every line that moves (the grabbed one and the rest of the selection). */
  readonly lineIds: readonly string[];
  /** For `word`: the boundary before this word (≥ 1). */
  readonly wordIndex: number;
  readonly ripple: boolean;
}

/** Nothing gets shorter than this by dragging: a zero-length line or word is always a mistake. */
export const MIN_DRAG_TICKS = Math.round(0.05 * TICKS_PER_SECOND);
const MIN_WORD_TICKS = Math.round(0.01 * TICKS_PER_SECOND);

type Timed = LyricLine & { readonly startTicks: number; readonly endTicks: number };
const isTimed = (line: LyricLine): line is Timed => line.startTicks !== null && line.endTicks !== null;

function rescale(words: readonly LyricWord[], a0: number, a1: number, b0: number, b1: number): readonly LyricWord[] {
  if (words.length === 0) return words;
  const map = (t: number) => (a1 === a0 ? b0 : Math.round(b0 + ((t - a0) * (b1 - b0)) / (a1 - a0)));
  return words.map((w) => ({ ...w, startTicks: map(w.startTicks), endTicks: Math.max(map(w.startTicks), map(w.endTicks)) }));
}

/** The line's words with times — explicit, or its interpolation made concrete (ids kept stable). */
function concreteWords(line: Timed): readonly LyricWord[] {
  const tokens = lyricTokens(line.text);
  if (line.words.length === tokens.length) return line.words;
  const spans = wordSpans({ id: line.id, text: line.text, startTicks: line.startTicks, endTicks: line.endTicks, role: line.role, words: [], style: null });
  return tokens.map((token, i) => ({
    // Deterministic ids for materialised words: the drag replans from scratch on every move, and a
    // fresh random id each time would make every merge a different document for no reason.
    id: `${line.id.slice(0, 20)}W${String(i).padStart(5, '0')}`.slice(0, 26),
    text: token.text,
    startTicks: Math.round((spans[i] as { start: number }).start * TICKS_PER_SECOND),
    endTicks: Math.round((spans[i] as { end: number }).end * TICKS_PER_SECOND),
    confidence: null,
    extra: {},
  }));
}

/** The time a drag moves, for snapping: a line's start (move, start), its end, or a word's start. */
export function dragEdgeTicks(lyrics: Lyrics, drag: LyricDrag): number | null {
  const line = lyrics.lines.find((l) => l.id === drag.lineId);
  if (line === undefined || !isTimed(line)) return null;
  if (drag.kind === 'end') return line.endTicks;
  if (drag.kind === 'word') return concreteWords(line)[drag.wordIndex]?.startTicks ?? null;
  return line.startTicks;
}

/**
 * The timings a drag produces, from the lyrics at the start of the drag and the total distance
 * moved. Empty when there is nothing to change.
 */
export function planLyricDrag(lyrics: Lyrics, drag: LyricDrag, deltaTicks: number): LineTiming[] {
  const delta = Math.round(deltaTicks);
  const line = lyrics.lines.find((l) => l.id === drag.lineId);
  if (line === undefined || !isTimed(line)) return [];

  if (drag.kind === 'move') {
    let moving = lyrics.lines.filter((l): l is Timed => isTimed(l) && (drag.lineIds.includes(l.id) || l.id === drag.lineId));
    if (drag.ripple) {
      const from = Math.min(...moving.map((l) => l.startTicks));
      moving = lyrics.lines.filter((l): l is Timed => isTimed(l) && l.startTicks >= from);
    }
    // Clamped as a whole at 0, so lines moving together keep their spacing.
    const earliest = Math.min(...moving.map((l) => Math.min(l.startTicks, ...l.words.map((w) => w.startTicks))));
    const d = Math.max(-earliest, delta);
    return moving.map((l) => ({
      lineId: l.id,
      startTicks: l.startTicks + d,
      endTicks: l.endTicks + d,
      words: l.words.map((w) => ({ ...w, startTicks: w.startTicks + d, endTicks: w.endTicks + d })),
    }));
  }

  if (drag.kind === 'start') {
    const start = Math.min(line.endTicks - MIN_DRAG_TICKS, Math.max(0, line.startTicks + delta));
    return [{ lineId: line.id, startTicks: start, endTicks: line.endTicks, words: rescale(line.words, line.startTicks, line.endTicks, start, line.endTicks) }];
  }

  if (drag.kind === 'end') {
    const end = Math.max(line.startTicks + MIN_DRAG_TICKS, line.endTicks + delta);
    return [{ lineId: line.id, startTicks: line.startTicks, endTicks: end, words: rescale(line.words, line.startTicks, line.endTicks, line.startTicks, end) }];
  }

  // A word boundary: between word i−1 and word i.
  const words = [...concreteWords(line)];
  const i = drag.wordIndex;
  const before = words[i - 1];
  const after = words[i];
  if (before === undefined || after === undefined) return [];
  const limitHigh = (i + 1 < words.length ? (words[i + 1] as LyricWord).startTicks : line.endTicks) - MIN_WORD_TICKS;
  const at = Math.min(limitHigh, Math.max(before.startTicks + MIN_WORD_TICKS, after.startTicks + delta));
  words[i - 1] = { ...before, endTicks: at, confidence: null };
  words[i] = { ...after, startTicks: at, endTicks: Math.max(at, after.endTicks), confidence: null };
  return [{ lineId: line.id, startTicks: line.startTicks, endTicks: line.endTicks, words }];
}

/**
 * Snap targets for a drag, in ticks: other lines' edges (never the moving lines' own), the
 * playhead, and the given onsets and beats. Sorted.
 */
export function snapTargets(lyrics: Lyrics, drag: LyricDrag, extra: readonly number[]): number[] {
  const moving = new Set(drag.kind === 'move' ? [...drag.lineIds, drag.lineId] : []);
  const edges = lyrics.lines.filter((l): l is Timed => isTimed(l) && !moving.has(l.id) && l.id !== drag.lineId)
    .flatMap((l) => [l.startTicks, l.endTicks]);
  return [...edges, ...extra].sort((a, b) => a - b);
}

/**
 * The delta after snapping: the dragged edge's new time moved onto the nearest target within
 * `thresholdTicks`, or the delta unchanged.
 */
export function snapDelta(edgeTicks: number, deltaTicks: number, targets: readonly number[], thresholdTicks: number): number {
  const wanted = edgeTicks + deltaTicks;
  const hit = nearestWithin(wanted, targets, thresholdTicks);
  return hit === null ? deltaTicks : hit - edgeTicks;
}

/** The next or previous timed line from `lineId` in time order, for ↑/↓ on the timeline. */
export function neighbourLine(lyrics: Lyrics, lineId: string | null, direction: 1 | -1): LyricLine | undefined {
  const timed = lyrics.lines.filter(isTimed).sort((a, b) => a.startTicks - b.startTicks);
  if (timed.length === 0) return undefined;
  const index = lineId === null ? -1 : timed.findIndex((l) => l.id === lineId);
  if (index < 0) return direction === 1 ? timed[0] : timed[timed.length - 1];
  return timed[Math.min(timed.length - 1, Math.max(0, index + direction))];
}

/** The word of a line under a time, for "split at the playhead": the first word starting after it. */
export function splitIndexAt(line: LyricLine, ticks: number): number | null {
  if (!isTimed(line)) return null;
  const words = concreteWords(line);
  const index = words.findIndex((w) => w.startTicks >= ticks);
  return index >= 1 ? index : null;
}
