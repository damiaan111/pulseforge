// Tap-to-sync (lyrics-spec §3; M19): the guaranteed path — no models, always works.
//
// Pure: the studio feeds in key presses as timeline ticks and gets back the timing changes to
// apply as one undoable command per tap. Everything that makes tapping usable lives here and is
// tested without a keyboard:
//
//  - **Where a tap lands.** The playback position when the handler ran, minus how old the key event
//    already was, minus the person's calibrated latency (D33) — both scaled by the playback rate,
//    because 100 ms of reaction at half speed is 50 ms of song.
//  - **Snapping.** To the nearest vocal-stem onset within a small window (on by default, usually
//    more accurate than the tap itself), or to the beat grid (off by default — vocals rarely sit
//    exactly on it, §3).
//  - **Three passes.** `starts`: a tap stamps the next line's start; holding the key marks its end
//    too, otherwise the end is estimated and pulled back to the next tap if that comes sooner.
//    `ends`: a tap ends the next timed line. `words`: taps stamp word starts within one line, and a
//    final tap ends the last word.
//  - **Undo one tap** (Backspace) restores exactly what the tap changed, and steps back.
//  - **Punch-in.** A session covers any range of lines; the rest are untouched.

import { lyricTokens } from '../engine/core/lyrics.ts';
import { TICKS_PER_SECOND } from '../engine/core/time.ts';
import type { LyricLine, LyricWord, Lyrics } from '../project/document.ts';
import { materialiseWords } from '../project/lyrics-commands.ts';

export type TapMode = 'starts' | 'ends' | 'words';

/** A hold at least this long is "I held it through the line", not a tap that lingered. */
export const HOLD_SECONDS = 0.35;

// ---------------------------------------------------------------------------
// Where a tap lands
// ---------------------------------------------------------------------------

/**
 * Timeline seconds a key press meant: the position when the handler ran, minus the event's age and
 * the person's latency, both in wall time and so scaled by the playback rate.
 */
export function tapPosition(positionSeconds: number, eventAgeMs: number, latencyMs: number, rate: number): number {
  return positionSeconds - ((Math.max(0, eventAgeMs) + latencyMs) / 1000) * rate;
}

/**
 * Onset times from an analysis `onset` feature (each onset is a decaying impulse, STATUS §4.4): the
 * local peaks above `minLevel`, at least `gapSeconds` apart (the higher one wins). Seconds in the
 * track's own time base.
 */
export function onsetPeaks(track: { readonly rate: number; readonly data: Float32Array }, minLevel = 0.35, gapSeconds = 0.06): number[] {
  const { data, rate } = track;
  const peaks: { t: number; v: number }[] = [];
  for (let i = 0; i < data.length; i += 1) {
    const v = data[i] as number;
    if (v < minLevel) continue;
    if (v <= (data[i - 1] ?? -Infinity) || v < (data[i + 1] ?? -Infinity)) continue;
    const t = i / rate;
    const last = peaks[peaks.length - 1];
    if (last !== undefined && t - last.t < gapSeconds) {
      if (v > last.v) peaks[peaks.length - 1] = { t, v };
      continue;
    }
    peaks.push({ t, v });
  }
  return peaks.map((p) => p.t);
}

/** The candidate nearest `t` within `window`, or null. `candidates` sorted ascending. */
export function nearestWithin(t: number, candidates: readonly number[], window: number): number | null {
  let lo = 0;
  let hi = candidates.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((candidates[mid] as number) < t) lo = mid + 1;
    else hi = mid;
  }
  let best: number | null = null;
  for (const i of [lo - 1, lo]) {
    const c = candidates[i];
    if (c === undefined || Math.abs(c - t) > window) continue;
    if (best === null || Math.abs(c - t) < Math.abs(best - t)) best = c;
  }
  return best;
}

/** How long a line probably takes to sing when nobody said: about 8 letters a second, 1–8 s. */
export function estimateLineSeconds(text: string): number {
  const letters = [...text].filter((ch) => /[\p{L}\p{N}]/u.test(ch)).length;
  return Math.min(8, Math.max(1, letters * 0.12));
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** A line's timing as a tap sets it — and as an undo restores it. */
export interface LineTiming {
  readonly lineId: string;
  readonly startTicks: number | null;
  readonly endTicks: number | null;
  readonly words: readonly LyricWord[];
}

interface UndoStep {
  readonly restore: readonly LineTiming[];
  readonly index: number;
  readonly wordIndex: number;
  readonly provisional: readonly string[];
  readonly lastDown: { readonly lineId: string; readonly ticks: number } | null;
}

export interface TapSession {
  readonly mode: TapMode;
  /** The lines this session taps, in order. `words` mode taps the first. */
  readonly lineIds: readonly string[];
  /** The next line to tap (starts, ends). */
  readonly index: number;
  /** The next word to tap (words). */
  readonly wordIndex: number;
  /** Lines whose end was estimated rather than tapped: the next tap may pull it in. */
  readonly provisional: readonly string[];
  /** The last key-down in `starts` mode, so a long hold can mark that line's end. */
  readonly lastDown: { readonly lineId: string; readonly ticks: number } | null;
  readonly history: readonly UndoStep[];
}

export interface TapResult {
  readonly session: TapSession;
  /** Timings to write, as one command; empty when the tap did nothing. */
  readonly changes: readonly LineTiming[];
}

const secondsToTicks = (s: number) => Math.round(s * TICKS_PER_SECOND);

function timingOf(line: LyricLine): LineTiming {
  return { lineId: line.id, startTicks: line.startTicks, endTicks: line.endTicks, words: line.words };
}

function lineById(lyrics: Lyrics, id: string): LyricLine | undefined {
  return lyrics.lines.find((line) => line.id === id);
}

/**
 * A session over `lineIds` (a punch-in range), or over every line. `words` mode needs exactly one
 * timed line; the others need at least one line.
 */
export function beginTapSession(lyrics: Lyrics, mode: TapMode, lineIds?: readonly string[]): TapSession {
  const ids = (lineIds ?? lyrics.lines.map((l) => l.id)).filter((id) => lineById(lyrics, id) !== undefined);
  if (ids.length === 0) throw new Error('There are no lyric lines to tap. Add the lyrics text first.');
  if (mode === 'words') {
    const line = lineById(lyrics, ids[0] as string) as LyricLine;
    if (line.startTicks === null || line.endTicks === null) throw new Error(`“${line.text}” has no timing yet — tap its start first, then its words.`);
    if (lyricTokens(line.text).length === 0) throw new Error(`“${line.text}” has no words to tap.`);
  }
  return { mode, lineIds: mode === 'words' ? [ids[0] as string] : ids, index: 0, wordIndex: 0, provisional: [], lastDown: null, history: [] };
}

/** Whether a session has anything left to tap. */
export function tapFinished(lyrics: Lyrics, session: TapSession): boolean {
  if (session.mode === 'words') {
    const line = lineById(lyrics, session.lineIds[0] as string);
    return line === undefined || session.wordIndex > lyricTokens(line.text).length;
  }
  return session.index >= session.lineIds.length;
}

/** The line the next tap is for, if any. */
export function nextTapLine(lyrics: Lyrics, session: TapSession): LyricLine | undefined {
  if (session.mode === 'words') return lineById(lyrics, session.lineIds[0] as string);
  if (session.mode === 'ends') {
    for (let i = session.index; i < session.lineIds.length; i += 1) {
      const line = lineById(lyrics, session.lineIds[i] as string);
      if (line !== undefined && line.startTicks !== null) return line;
    }
    return undefined;
  }
  const id = session.lineIds[session.index];
  return id === undefined ? undefined : lineById(lyrics, id);
}

function step(session: TapSession, restore: readonly LineTiming[], next: Partial<TapSession>): TapSession {
  const undo: UndoStep = { restore, index: session.index, wordIndex: session.wordIndex, provisional: session.provisional, lastDown: session.lastDown };
  return { ...session, ...next, history: [...session.history, undo] };
}

/** A key went down at `ticks` (already corrected and snapped). */
export function tapDown(lyrics: Lyrics, session: TapSession, ticks: number, newIds?: () => string): TapResult {
  const t = Math.max(0, Math.round(ticks));
  if (tapFinished(lyrics, session)) return { session, changes: [] };

  if (session.mode === 'starts') {
    const line = nextTapLine(lyrics, session) as LyricLine;
    const changes: LineTiming[] = [];
    const restore: LineTiming[] = [timingOf(line)];
    // A line tapped again keeps its length and its words, moved; a new line gets an estimate.
    let end: number;
    let words: readonly LyricWord[];
    let provisional = session.provisional.filter((id) => id !== line.id);
    if (line.startTicks !== null && line.endTicks !== null) {
      const delta = t - line.startTicks;
      end = line.endTicks + delta;
      words = line.words.map((w) => ({ ...w, startTicks: Math.max(0, w.startTicks + delta), endTicks: Math.max(0, w.endTicks + delta) }));
    } else {
      end = t + secondsToTicks(estimateLineSeconds(line.text));
      words = [];
      provisional = [...provisional, line.id];
    }
    changes.push({ lineId: line.id, startTicks: t, endTicks: end, words });
    // The line tapped before this one ends here at the latest — whether its end was a guess or not,
    // this tap is the newer statement.
    const previousId = session.index > 0 ? session.lineIds[session.index - 1] : undefined;
    const previous = previousId === undefined ? undefined : lineById(lyrics, previousId);
    if (previous !== undefined && previous.startTicks !== null && previous.endTicks !== null && previous.endTicks > t) {
      restore.push(timingOf(previous));
      const clamped = Math.max(previous.startTicks, t);
      const kept = previous.words.filter((w) => w.startTicks < clamped).map((w) => ({ ...w, endTicks: Math.min(w.endTicks, clamped) }));
      changes.push({ lineId: previous.id, startTicks: previous.startTicks, endTicks: clamped, words: kept.length === previous.words.length ? kept : [] });
      provisional = provisional.filter((id) => id !== previous.id);
    }
    return { session: step(session, restore, { index: session.index + 1, provisional, lastDown: { lineId: line.id, ticks: t } }), changes };
  }

  if (session.mode === 'ends') {
    const line = nextTapLine(lyrics, session);
    if (line === undefined || line.startTicks === null) return { session: { ...session, index: session.lineIds.length }, changes: [] };
    const index = session.lineIds.indexOf(line.id);
    const end = Math.max(line.startTicks + secondsToTicks(0.1), t);
    const words = line.endTicks === null ? [] : rescale(line.words, line.startTicks, line.endTicks, line.startTicks, end);
    return {
      session: step(session, [timingOf(line)], { index: index + 1 }),
      changes: [{ lineId: line.id, startTicks: line.startTicks, endTicks: end, words }],
    };
  }

  // words
  const line = nextTapLine(lyrics, session) as LyricLine;
  const words = [...materialiseWords(line, newIds)];
  const k = session.wordIndex;
  let start = line.startTicks as number;
  let end = line.endTicks as number;
  if (k < words.length) {
    const word = words[k] as LyricWord;
    words[k] = { ...word, startTicks: t, endTicks: Math.max(t, k + 1 < words.length ? word.endTicks : end), confidence: null };
    if (k > 0) {
      const before = words[k - 1] as LyricWord;
      words[k - 1] = { ...before, endTicks: Math.max(before.startTicks, t) };
    }
    start = Math.min(start, t);
    end = Math.max(end, (words[k] as LyricWord).endTicks);
  } else {
    // One more tap after the last word: where it ends — and the line with it.
    const last = words[words.length - 1] as LyricWord;
    words[words.length - 1] = { ...last, endTicks: Math.max(last.startTicks, t) };
    end = Math.max(last.startTicks, t);
  }
  return {
    session: step(session, [timingOf(line)], { wordIndex: k + 1 }),
    changes: [{ lineId: line.id, startTicks: start, endTicks: end, words }],
  };
}

/**
 * The key came up at `ticks`. In `starts` mode a long hold marks the end of the line it started;
 * a short tap changes nothing.
 */
export function tapUp(lyrics: Lyrics, session: TapSession, ticks: number): TapResult {
  const down = session.lastDown;
  if (session.mode !== 'starts' || down === null) return { session, changes: [] };
  const t = Math.round(ticks);
  if (t - down.ticks < secondsToTicks(HOLD_SECONDS)) return { session: { ...session, lastDown: null }, changes: [] };
  const line = lineById(lyrics, down.lineId);
  if (line === undefined || line.startTicks === null) return { session: { ...session, lastDown: null }, changes: [] };
  const words = line.endTicks === null ? [] : rescale(line.words, line.startTicks, line.endTicks, line.startTicks, t);
  // No undo step of its own: the key-down's step restores the line as it was before the press,
  // so one Backspace undoes the whole press, hold included.
  return {
    session: { ...session, lastDown: null, provisional: session.provisional.filter((id) => id !== line.id) },
    changes: [{ lineId: line.id, startTicks: line.startTicks, endTicks: t, words }],
  };
}

/** Backspace: puts back what the last tap changed and steps back to tap it again. */
export function untap(session: TapSession): TapResult {
  const last = session.history[session.history.length - 1];
  if (last === undefined) return { session, changes: [] };
  return {
    session: { ...session, index: last.index, wordIndex: last.wordIndex, provisional: last.provisional, lastDown: last.lastDown, history: session.history.slice(0, -1) },
    changes: last.restore,
  };
}

function rescale(words: readonly LyricWord[], a0: number, a1: number, b0: number, b1: number): readonly LyricWord[] {
  if (words.length === 0) return words;
  const map = (t: number) => (a1 === a0 ? b0 : Math.round(b0 + ((t - a0) * (b1 - b0)) / (a1 - a0)));
  return words.map((w) => ({ ...w, startTicks: map(w.startTicks), endTicks: Math.max(map(w.startTicks), map(w.endTicks)) }));
}
