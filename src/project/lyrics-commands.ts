// Lyrics edits as undoable commands (M8, lyrics-spec §2, §3, §5).
//
// The hard one is `setLyricsText`: the editor shows the lyrics as plain text, and every keystroke
// re-derives the lines from it. Re-deriving naively would throw away every timing on each
// keystroke — the tapping, the alignment, the hand corrections. So lines are **matched** old → new:
//
//  1. Lines whose text is unchanged (longest common subsequence) keep everything: id, times, words,
//     role, style, lock.
//  2. Between those anchors, an edited line pairs with the old line it most resembles, in order,
//     and keeps its id, times, role, style and lock. Its word timings survive only if every word of
//     the new text matches an old word; otherwise the line falls back to interpolation (§6.4)
//     rather than attaching a timing to the wrong word.
//  3. Anything else is new: a fresh id and no time.
//
// Every command is a pure function of the document; ids come from an injectable factory so tests
// are byte-stable. Times are integer ticks throughout (D10).

import { lyricTokens, wordSpans } from '../engine/core/lyrics.ts';
import { TICKS_PER_SECOND } from '../engine/core/time.ts';
import type { ImportedLyrics } from '../lyrics/formats.ts';
import { prepareLyricsText } from '../lyrics/prepare.ts';
import { CommandError } from './commands.ts';
import type { LyricLine, LyricLineStyle, LyricRole, Lyrics, LyricSection, LyricWord, ProjectDocument } from './document.ts';
import type { Command } from './history.ts';
import { newId } from './ids.ts';

type IdFactory = () => string;

function withLyrics(document: ProjectDocument, lyrics: Lyrics): ProjectDocument {
  return lyrics === document.lyrics ? document : { ...document, lyrics };
}

function lineIndex(lyrics: Lyrics, lineId: string): number {
  const index = lyrics.lines.findIndex((line) => line.id === lineId);
  if (index < 0) throw new CommandError(`no lyric line with id "${lineId}"`);
  return index;
}

function mapLines(lyrics: Lyrics, ids: ReadonlySet<string>, fn: (line: LyricLine) => LyricLine): Lyrics {
  let changed = false;
  const lines = lyrics.lines.map((line) => {
    if (!ids.has(line.id)) return line;
    const next = fn(line);
    if (next !== line) changed = true;
    return next;
  });
  return changed ? { ...lyrics, lines } : lyrics;
}

const clampTick = (ticks: number) => Math.max(0, Math.round(ticks));

// ---------------------------------------------------------------------------
// Text ⇄ lines
// ---------------------------------------------------------------------------

/**
 * The editor's text: one line per lyric line, each section marker as `[label]` on its own line with
 * a blank line before it. `prepareLyricsText` reads this back to the same lines and markers.
 */
export function lyricsToText(lyrics: Lyrics): string {
  const out: string[] = [];
  const before = new Map<string | null, LyricSection[]>();
  for (const section of lyrics.sections) {
    const key = section.beforeLineId !== null && lyrics.lines.some((l) => l.id === section.beforeLineId) ? section.beforeLineId : null;
    before.set(key, [...(before.get(key) ?? []), section]);
  }
  const markers = (key: string | null) => {
    for (const section of before.get(key) ?? []) {
      if (out.length > 0 && out[out.length - 1] !== '') out.push('');
      out.push(`[${section.label}]`);
    }
  };
  for (const line of lyrics.lines) {
    markers(line.id);
    out.push(line.text);
  }
  markers(null);
  return out.join('\n');
}

/** Normalised edit similarity 0..1 (Levenshtein), for pairing an edited line with its old self. */
function similarity(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) return 1;
  if (x.length === 0 || y.length === 0) return 0;
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= y.length; j += 1) {
      row[j] = Math.min((prev[j] as number) + 1, (row[j - 1] as number) + 1, (prev[j - 1] as number) + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return 1 - (prev[y.length] as number) / Math.max(x.length, y.length);
}

/** Pairs of indices (a, b) where `a[i] === b[j]`, in order, maximal (longest common subsequence). */
function lcsPairs<T>(a: readonly T[], b: readonly T[], equal: (x: T, y: T) => boolean): [number, number][] {
  const n = a.length;
  const m = b.length;
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      (table[i] as Uint32Array)[j] = equal(a[i] as T, b[j] as T)
        ? ((table[i + 1] as Uint32Array)[j + 1] as number) + 1
        : Math.max((table[i + 1] as Uint32Array)[j] as number, (table[i] as Uint32Array)[j + 1] as number);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (equal(a[i] as T, b[j] as T)) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (((table[i + 1] as Uint32Array)[j] as number) >= ((table[i] as Uint32Array)[j + 1] as number)) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

/** A word as sung: case and punctuation do not change what is sung, so they do not break a match. */
const sungForm = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/**
 * Word timings kept across a text edit, when every new word finds its old self (by sung form, so
 * fixing "tonight" to "Tonight!" keeps its timing); otherwise none.
 */
function carryWords(old: LyricLine, text: string): readonly LyricWord[] {
  if (old.words.length === 0) return [];
  const tokens = lyricTokens(text);
  const pairs = lcsPairs(old.words.map((w) => sungForm(w.text)), tokens.map((t) => sungForm(t.text)), (x, y) => x === y);
  if (pairs.length !== tokens.length) return [];
  return pairs.map(([i, j]) => {
    const word = old.words[i] as LyricWord;
    const token = tokens[j] as { text: string };
    return word.text === token.text ? word : { ...word, text: token.text };
  });
}

/**
 * Re-derives lines and markers from the editor text, keeping every timing that can be kept (see
 * the file header). Typing merges into one undo step.
 */
export function setLyricsText(text: string, newIds: IdFactory = newId): Command {
  return {
    label: 'Edit lyrics',
    mergeKey: 'lyrics:text',
    apply: (document) => {
      const old = document.lyrics;
      const prepared = prepareLyricsText(text);
      const next = prepared.lines;
      const matched = new Map<number, LyricLine>();
      const anchors = lcsPairs(old.lines.map((l) => l.text), next.map((l) => l.text), (a, b) => a === b);
      for (const [i, j] of anchors) matched.set(j, old.lines[i] as LyricLine);

      // Between anchors, pair edited lines with the most similar old line, in order.
      const bounds: [number, number][] = [[-1, -1], ...anchors, [old.lines.length, next.length]];
      for (let k = 0; k + 1 < bounds.length; k += 1) {
        const [oi, nj] = bounds[k] as [number, number];
        const [oe, ne] = bounds[k + 1] as [number, number];
        let cursor = oi + 1;
        for (let j = nj + 1; j < ne; j += 1) {
          const candidate = next[j] as { text: string };
          let best = -1;
          let bestScore = 0.5;
          for (let i = cursor; i < oe; i += 1) {
            const score = similarity((old.lines[i] as LyricLine).text, candidate.text);
            if (score >= bestScore) {
              best = i;
              bestScore = score;
            }
          }
          if (best >= 0) {
            const was = old.lines[best] as LyricLine;
            matched.set(j, { ...was, text: candidate.text, words: carryWords(was, candidate.text), confidence: null });
            cursor = best + 1;
          }
        }
      }

      const lines = next.map((line, j): LyricLine => matched.get(j) ?? {
        id: newIds(),
        text: line.text,
        startTicks: null,
        endTicks: null,
        words: [],
        role: line.role,
        style: null,
        confidence: null,
        locked: false,
        extra: {},
      });
      const sections = prepared.sections.map((section): LyricSection => {
        const beforeLineId = section.beforeIndex < lines.length ? (lines[section.beforeIndex] as LyricLine).id : null;
        const kept = old.sections.find((s) => s.label === section.label && s.beforeLineId === beforeLineId);
        return kept ?? { id: newIds(), label: section.label, beforeLineId, extra: {} };
      });
      const unchanged = lines.length === old.lines.length && lines.every((l, i) => l === old.lines[i])
        && sections.length === old.sections.length && sections.every((s, i) => s === old.sections[i]);
      return unchanged ? document : withLyrics(document, { ...old, lines, sections });
    },
  };
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

/** Word timings rescaled from a line's old span to its new one, so words move with their line. */
function rescaleWords(words: readonly LyricWord[], from: [number, number], to: [number, number]): readonly LyricWord[] {
  if (words.length === 0) return words;
  const [a0, a1] = from;
  const [b0, b1] = to;
  const map = (t: number) => (a1 === a0 ? b0 : clampTick(b0 + ((t - a0) * (b1 - b0)) / (a1 - a0)));
  return words.map((w) => ({ ...w, startTicks: map(w.startTicks), endTicks: Math.max(map(w.startTicks), map(w.endTicks)) }));
}

/**
 * Sets a line's start and end (tap-to-sync, the inspector, dragging an edge). Words move with the
 * line: rescaled from the old span to the new, so a hand-corrected word stays where it was relative
 * to its line. `null` clears a time; clearing either clears the words, which need a line to live in.
 */
export function setLineTimes(lineId: string, startTicks: number | null, endTicks: number | null, mergeKey?: string): Command {
  return {
    label: 'Set line timing',
    ...(mergeKey === undefined ? {} : { mergeKey }),
    apply: (document) => {
      const index = lineIndex(document.lyrics, lineId);
      const line = document.lyrics.lines[index] as LyricLine;
      const start = startTicks === null ? null : clampTick(startTicks);
      const end = endTicks === null ? null : Math.max(start ?? 0, clampTick(endTicks));
      if (start === line.startTicks && end === line.endTicks) return document;
      const words = start === null || end === null
        ? []
        : line.startTicks !== null && line.endTicks !== null
          ? rescaleWords(line.words, [line.startTicks, line.endTicks], [start, end])
          : line.words;
      return withLyrics(document, mapLines(document.lyrics, new Set([lineId]), (l) => ({ ...l, startTicks: start, endTicks: end, words })));
    },
  };
}

/**
 * Moves lines — and their words — by `deltaTicks` (drag, keyboard nudge). With `ripple`, every line
 * that starts at or after the earliest moved one moves too: the fix when the whole second half is
 * uniformly late (lyrics-spec §5). Nothing moves before 0; untimed lines are left alone.
 */
export function moveLines(lineIds: readonly string[], deltaTicks: number, options: { readonly ripple?: boolean; readonly mergeKey?: string } = {}): Command {
  return {
    label: options.ripple === true ? 'Ripple lines' : lineIds.length === 1 ? 'Move line' : 'Move lines',
    ...(options.mergeKey === undefined ? {} : { mergeKey: options.mergeKey }),
    apply: (document) => {
      const { lyrics } = document;
      for (const id of lineIds) lineIndex(lyrics, id);
      const chosen = lyrics.lines.filter((l) => lineIds.includes(l.id) && l.startTicks !== null);
      if (chosen.length === 0 || deltaTicks === 0) return document;
      let ids = new Set(chosen.map((l) => l.id));
      if (options.ripple === true) {
        const from = Math.min(...chosen.map((l) => l.startTicks as number));
        ids = new Set(lyrics.lines.filter((l) => l.startTicks !== null && l.startTicks >= from).map((l) => l.id));
      }
      const moving = lyrics.lines.filter((l) => ids.has(l.id));
      // Clamp the whole move, not each line, so lines keep their spacing at the start of the song.
      const earliest = Math.min(...moving.map((l) => Math.min(l.startTicks as number, ...l.words.map((w) => w.startTicks))));
      const delta = Math.max(-earliest, Math.round(deltaTicks));
      if (delta === 0) return document;
      return withLyrics(document, mapLines(lyrics, ids, (l) => ({
        ...l,
        startTicks: (l.startTicks as number) + delta,
        endTicks: l.endTicks === null ? null : l.endTicks + delta,
        words: l.words.map((w) => ({ ...w, startTicks: w.startTicks + delta, endTicks: w.endTicks + delta })),
      })));
    },
  };
}

/** The line's words as explicit timings — interpolated ones (§6.4) made concrete for editing. */
export function materialiseWords(line: LyricLine, newIds: IdFactory = newId): readonly LyricWord[] {
  const tokens = lyricTokens(line.text);
  if (line.words.length === tokens.length) return line.words;
  if (line.startTicks === null || line.endTicks === null) return [];
  const spans = wordSpans({ id: line.id, text: line.text, startTicks: line.startTicks, endTicks: line.endTicks, role: line.role, words: [], style: null });
  return tokens.map((token, i) => {
    const span = spans[i] as { start: number; end: number };
    return { id: newIds(), text: token.text, startTicks: clampTick(span.start * TICKS_PER_SECOND), endTicks: clampTick(span.end * TICKS_PER_SECOND), confidence: null, extra: {} };
  });
}

/**
 * Sets one word's timing (word blocks on the timeline, pass-2 word taps). A line with interpolated
 * words gets all its words made explicit first, so moving one word does not move the others. The
 * word's neighbours are not pushed; the validator reports words out of order.
 */
export function setWordTimes(lineId: string, wordIndex: number, startTicks: number, endTicks: number, options: { readonly mergeKey?: string; readonly newIds?: IdFactory } = {}): Command {
  return {
    label: 'Set word timing',
    ...(options.mergeKey === undefined ? {} : { mergeKey: options.mergeKey }),
    apply: (document) => {
      const index = lineIndex(document.lyrics, lineId);
      const line = document.lyrics.lines[index] as LyricLine;
      const words = [...materialiseWords(line, options.newIds)];
      const word = words[wordIndex];
      if (word === undefined) throw new CommandError(`line "${lineId}" has no word ${wordIndex} (it has ${words.length}${line.startTicks === null ? ', and no timing' : ''})`);
      const start = clampTick(startTicks);
      const end = Math.max(start, clampTick(endTicks));
      if (word.startTicks === start && word.endTicks === end && words.length === line.words.length) return document;
      words[wordIndex] = { ...word, startTicks: start, endTicks: end, confidence: null };
      // A word may pull its line's edges out; it never shrinks them.
      const lineStart = Math.min(line.startTicks ?? start, start);
      const lineEnd = Math.max(line.endTicks ?? end, end);
      return withLyrics(document, mapLines(document.lyrics, new Set([lineId]), (l) => ({ ...l, words, startTicks: lineStart, endTicks: lineEnd })));
    },
  };
}

/**
 * Writes line timings exactly as given — start, end and words together, for several lines as one
 * undo step. What tap-to-sync applies per tap (and restores per Backspace): the tap logic has
 * already decided every value, so nothing here rescales or infers.
 */
export function setLineTimings(
  changes: readonly { readonly lineId: string; readonly startTicks: number | null; readonly endTicks: number | null; readonly words: readonly LyricWord[] }[],
  label = 'Tap',
): Command {
  return {
    label,
    apply: (document) => {
      const byId = new Map(changes.map((c) => [c.lineId, c]));
      for (const id of byId.keys()) lineIndex(document.lyrics, id);
      return withLyrics(document, mapLines(document.lyrics, new Set(byId.keys()), (line) => {
        const c = byId.get(line.id) as (typeof changes)[number];
        const start = c.startTicks === null ? null : clampTick(c.startTicks);
        const end = c.endTicks === null ? null : Math.max(start ?? 0, clampTick(c.endTicks));
        if (start === line.startTicks && end === line.endTicks && c.words === line.words) return line;
        return { ...line, startTicks: start, endTicks: end, words: start === null || end === null ? [] : c.words };
      }));
    },
  };
}

/** Clears timings (and word timings) of the given lines, or of every unlocked line. */
export function clearLineTimes(lineIds?: readonly string[]): Command {
  return {
    label: 'Clear timings',
    apply: (document) => {
      const ids = new Set(lineIds ?? document.lyrics.lines.filter((l) => !l.locked).map((l) => l.id));
      return withLyrics(document, mapLines(document.lyrics, ids, (l) => (l.startTicks === null && l.endTicks === null && l.words.length === 0
        ? l
        : { ...l, startTicks: null, endTicks: null, words: [], confidence: null })));
    },
  };
}

// ---------------------------------------------------------------------------
// Line properties
// ---------------------------------------------------------------------------

export function setLinesLocked(lineIds: readonly string[], locked: boolean): Command {
  return {
    label: locked ? 'Lock lines' : 'Unlock lines',
    apply: (document) => withLyrics(document, mapLines(document.lyrics, new Set(lineIds), (l) => (l.locked === locked ? l : { ...l, locked }))),
  };
}

export function setLinesRole(lineIds: readonly string[], role: LyricRole): Command {
  return {
    label: 'Set line role',
    apply: (document) => withLyrics(document, mapLines(document.lyrics, new Set(lineIds), (l) => (l.role === role ? l : { ...l, role }))),
  };
}

/** Per-line style overrides (D38). `null` for a field clears it; an all-null style is removed. */
export function setLineStyle(lineId: string, patch: Partial<Omit<LyricLineStyle, 'extra'>>, mergeKey?: string): Command {
  return {
    label: 'Set line style',
    ...(mergeKey === undefined ? {} : { mergeKey }),
    apply: (document) => withLyrics(document, mapLines(document.lyrics, new Set([lineId]), (l) => {
      const base: LyricLineStyle = l.style ?? { scale: null, opacity: null, offsetX: null, offsetY: null, color: null, extra: {} };
      const style = { ...base, ...patch };
      const empty = style.scale === null && style.opacity === null && style.offsetX === null && style.offsetY === null && style.color === null
        && Object.keys(style.extra).length === 0;
      return { ...l, style: empty ? null : style };
    })),
  };
}

export function setLyricsLanguage(language: string): Command {
  return {
    label: 'Set lyrics language',
    apply: (document) => (document.lyrics.language === language ? document : withLyrics(document, { ...document.lyrics, language })),
  };
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

/**
 * Splits a line before word `atWord` (≥ 1). The first part keeps the id; timing splits at that
 * word's start, and explicit words go with their half.
 */
export function splitLine(lineId: string, atWord: number, newIds: IdFactory = newId): Command {
  return {
    label: 'Split line',
    apply: (document) => {
      const { lyrics } = document;
      const index = lineIndex(lyrics, lineId);
      const line = lyrics.lines[index] as LyricLine;
      const tokens = lyricTokens(line.text);
      if (atWord < 1 || atWord >= tokens.length) throw new CommandError(`cannot split "${line.text}" before word ${atWord}: it has ${tokens.length} words`);
      const cut = (tokens[atWord] as { start: number }).start;
      const words = materialiseWords(line, newIds);
      const at = line.startTicks === null || words.length === 0 ? null : (words[atWord] as LyricWord).startTicks;
      const keepWords = line.words.length === tokens.length;
      const first: LyricLine = {
        ...line,
        text: line.text.slice(0, cut).trim(),
        endTicks: at ?? line.endTicks,
        words: keepWords ? line.words.slice(0, atWord) : [],
        confidence: null,
      };
      const second: LyricLine = {
        ...line,
        id: newIds(),
        text: line.text.slice(cut).trim(),
        startTicks: at ?? (line.startTicks === null ? null : line.endTicks),
        words: keepWords ? line.words.slice(atWord) : [],
        confidence: null,
      };
      const lines = [...lyrics.lines.slice(0, index), first, second, ...lyrics.lines.slice(index + 1)];
      return withLyrics(document, { ...lyrics, lines });
    },
  };
}

/** Joins a line with the one after it in reading order. The first keeps its id; times span both. */
export function mergeWithNext(lineId: string): Command {
  return {
    label: 'Merge lines',
    apply: (document) => {
      const { lyrics } = document;
      const index = lineIndex(lyrics, lineId);
      const a = lyrics.lines[index] as LyricLine;
      const b = lyrics.lines[index + 1];
      if (b === undefined) throw new CommandError('the last line has no next line to merge with');
      const timed = a.startTicks !== null && a.endTicks !== null && b.startTicks !== null && b.endTicks !== null;
      const text = `${a.text} ${b.text}`.trim();
      const wordsComplete = a.words.length === lyricTokens(a.text).length && b.words.length === lyricTokens(b.text).length && a.words.length > 0 && b.words.length > 0;
      const merged: LyricLine = {
        ...a,
        text,
        startTicks: timed ? Math.min(a.startTicks as number, b.startTicks as number) : (a.startTicks ?? b.startTicks),
        endTicks: timed ? Math.max(a.endTicks as number, b.endTicks as number) : (a.endTicks ?? b.endTicks),
        words: timed && wordsComplete ? [...a.words, ...b.words] : [],
        confidence: null,
        locked: a.locked && b.locked,
      };
      const lines = [...lyrics.lines.slice(0, index), merged, ...lyrics.lines.slice(index + 2)];
      // A marker that preceded the swallowed line now precedes whatever followed it.
      const following = lyrics.lines[index + 2]?.id ?? null;
      const sections = lyrics.sections.map((s) => (s.beforeLineId === b.id ? { ...s, beforeLineId: following } : s));
      return withLyrics(document, { ...lyrics, lines, sections });
    },
  };
}

// ---------------------------------------------------------------------------
// Whole-lyrics replacements
// ---------------------------------------------------------------------------

/** An imported file (formats.ts) → the project's lyrics. Replaces the lines; keeps the language. */
export function importLyrics(imported: ImportedLyrics, newIds: IdFactory = newId): Command {
  return {
    label: `Import lyrics (.${imported.format})`,
    apply: (document) => {
      const lines = imported.lines.map((line): LyricLine => ({
        id: newIds(),
        text: line.text,
        startTicks: line.startTicks,
        endTicks: line.endTicks,
        words: (line.words ?? []).map((w) => ({ id: newIds(), text: w.text, startTicks: w.startTicks, endTicks: w.endTicks, confidence: null, extra: {} })),
        role: 'lead',
        style: null,
        confidence: null,
        locked: false,
        extra: {},
      }));
      return withLyrics(document, { ...document.lyrics, source: 'import', lines, sections: [] });
    },
  };
}

/** An aligned word, as the aligner reports it (M26). */
export interface AlignedWord {
  readonly text: string;
  readonly startTicks: number;
  readonly endTicks: number;
  readonly confidence: number | null;
}

export interface AlignedLine {
  readonly lineId: string;
  readonly startTicks: number;
  readonly endTicks: number;
  readonly words: readonly AlignedWord[];
  readonly confidence: number | null;
}

/**
 * Writes alignment results (lyrics-spec §4) — **unlocked lines only**, so re-running after
 * corrections never destroys them. A result for a line that no longer exists, or whose words no
 * longer match its text, is skipped and counted, never forced onto the line.
 */
export function applyAlignment(results: readonly AlignedLine[], newIds: IdFactory = newId): Command & { readonly skipped: () => number } {
  let skipped = 0;
  return {
    label: 'Align lyrics',
    skipped: () => skipped,
    apply: (document) => {
      skipped = 0;
      const byId = new Map(results.map((r) => [r.lineId, r]));
      let changed = false;
      const lines = document.lyrics.lines.map((line) => {
        const result = byId.get(line.id);
        if (result === undefined) return line;
        const tokens = lyricTokens(line.text);
        if (line.locked || (result.words.length > 0 && result.words.length !== tokens.length)) {
          skipped += 1;
          return line;
        }
        changed = true;
        return {
          ...line,
          startTicks: clampTick(result.startTicks),
          endTicks: Math.max(clampTick(result.startTicks), clampTick(result.endTicks)),
          words: result.words.map((w, i) => ({
            id: line.words[i]?.id ?? newIds(),
            text: (tokens[i] as { text: string }).text,
            startTicks: clampTick(w.startTicks),
            endTicks: Math.max(clampTick(w.startTicks), clampTick(w.endTicks)),
            confidence: w.confidence,
            extra: {},
          })),
          confidence: result.confidence,
        };
      });
      skipped += results.filter((r) => !document.lyrics.lines.some((l) => l.id === r.lineId)).length;
      return changed ? withLyrics(document, { ...document.lyrics, source: 'aligned', lines }) : document;
    },
  };
}
