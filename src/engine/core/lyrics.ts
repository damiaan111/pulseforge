// Lyric timing as the engine sees it (lyrics-spec §1, §6.4, §6.5; modulation-spec §2.4).
//
// The document's lyrics (src/project/document.ts) reach the engine as a `RenderLyrics`: only the
// lines that have times, in timeline ticks, sorted by start. Everything here is a closed-form
// function of `t` (CLAUDE.md #1) — which word is being sung, how far through it, when a line
// appears and disappears — so the karaoke layer and the lyric modulation sources agree with each
// other, and a seek agrees with a playthrough.
//
// **Tokens.** A line's words are its whitespace-separated runs, the same rule the text layout uses
// (src/text/layout.ts), with one addition from lyrics-spec §2.3: a run that is only punctuation
// ("—", "…", "!") attaches to the word before it, so it never fills as a word of its own.
// Hyphenated and elided forms ("don't", "rock-'n'-roll") are single runs already. Word timings in a
// line correspond to these tokens one to one; a line whose word list does not match its tokens is
// interpolated instead, never mis-assigned.

import { TICKS_PER_SECOND } from './time.ts';

/** lead · backing · adlib · instrumental-note (lyrics-spec §1). */
export type LyricRole = string;

/** Per-line style deviation (lyrics-spec §7, D38). Null fields inherit the layer's style. */
export interface LyricLineStyle {
  /** Multiplies the layer's text size. */
  readonly scale: number | null;
  /** Multiplies the line's opacity. */
  readonly opacity: number | null;
  /** Offset in em: right and down. */
  readonly offsetX: number | null;
  readonly offsetY: number | null;
  /** Replaces the layer's `upcoming` colour for this line (sRGB hex). */
  readonly color: string | null;
}

export interface RenderLyricWord {
  readonly startTicks: number;
  readonly endTicks: number;
}

export interface RenderLyricLine {
  readonly id: string;
  readonly text: string;
  readonly startTicks: number;
  readonly endTicks: number;
  readonly role: LyricRole;
  /** One per token of `text`, or empty to interpolate across the line (§6.4). */
  readonly words: readonly RenderLyricWord[];
  readonly style: LyricLineStyle | null;
}

export interface RenderLyrics {
  /** Timed lines only, sorted by start, then by document order. */
  readonly lines: readonly RenderLyricLine[];
  /** Lines in the document that have no time yet — reported, not drawn. */
  readonly untimedLines: number;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export interface LyricToken {
  readonly text: string;
  /** Character range in the line's text, end exclusive. */
  readonly start: number;
  readonly end: number;
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * The words of a line (lyrics-spec §2.3). Whitespace runs split; a run with no letter or digit in
 * it joins the word before it (or, at the start of a line, the word after it).
 */
export function lyricTokens(text: string): readonly LyricToken[] {
  const runs: { text: string; start: number; end: number }[] = [];
  const pattern = /\S+/g;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    runs.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  }
  const out: { text: string; start: number; end: number }[] = [];
  let pendingLead: { start: number } | null = null;
  for (const run of runs) {
    const isWord = WORD_CHAR.test(run.text);
    if (!isWord && out.length > 0) {
      const last = out[out.length - 1] as { text: string; start: number; end: number };
      last.end = run.end;
      last.text = text.slice(last.start, last.end);
      continue;
    }
    if (!isWord) {
      // Punctuation before the first word: held until that word arrives.
      pendingLead ??= { start: run.start };
      continue;
    }
    const start = pendingLead?.start ?? run.start;
    pendingLead = null;
    out.push({ text: text.slice(start, run.end), start, end: run.end });
  }
  if (pendingLead !== null) {
    // A line that is only punctuation is one token, so it still has something to time.
    const first = runs[0] as { start: number };
    const last = runs[runs.length - 1] as { end: number };
    out.push({ text: text.slice(first.start, last.end), start: first.start, end: last.end });
  }
  return out;
}

/** Characters that take time to sing: letters and digits. Punctuation is free. */
function singingWeight(text: string): number {
  let n = 0;
  for (const ch of text) if (WORD_CHAR.test(ch)) n += 1;
  return Math.max(1, n);
}

// ---------------------------------------------------------------------------
// Word timing (lyrics-spec §6.4)
// ---------------------------------------------------------------------------

export interface WordSpan {
  /** Seconds, timeline time. */
  readonly start: number;
  readonly end: number;
}

const seconds = (ticks: number) => ticks / TICKS_PER_SECOND;

/**
 * When each token of a line is sung. Explicit word timings when the line has one per token;
 * otherwise the line's duration **distributed by character count** — "I" and "everything" should
 * not take the same time (§6.4), and it costs one line of arithmetic.
 */
export function wordSpans(line: RenderLyricLine): readonly WordSpan[] {
  const tokens = lyricTokens(line.text);
  if (line.words.length === tokens.length && tokens.length > 0) {
    return line.words.map((w) => ({ start: seconds(w.startTicks), end: seconds(Math.max(w.startTicks, w.endTicks)) }));
  }
  const start = seconds(line.startTicks);
  const end = seconds(Math.max(line.startTicks, line.endTicks));
  const weights = tokens.map((token) => singingWeight(token.text));
  const total = weights.reduce((a, b) => a + b, 0);
  const spans: WordSpan[] = [];
  let cursor = 0;
  for (const weight of weights) {
    const a = start + ((end - start) * cursor) / total;
    cursor += weight;
    const b = start + ((end - start) * cursor) / total;
    spans.push({ start: a, end: b });
  }
  return spans;
}

/**
 * Fill progress of one word at `t`: 0 before it, 1 after it, linear within. A gap between words
 * holds the finished word at 1 rather than filling into silence (§6.4) — which falls out of the
 * clamp.
 */
export function wordProgress(span: WordSpan, t: number): number {
  if (t <= span.start) return 0;
  if (t >= span.end) return 1;
  return (t - span.start) / (span.end - span.start);
}

// ---------------------------------------------------------------------------
// Line schedule (lyrics-spec §6.3, §6.5)
// ---------------------------------------------------------------------------

export interface LineWindow {
  /** When the line comes on screen and leaves it, in seconds. */
  readonly appear: number;
  readonly disappear: number;
  /**
   * True when the previous line in the sequence leaves exactly as this one comes on — a hand-over
   * that the layer's advance mode (cut, crossfade, scroll) animates. False when the line comes on
   * out of an empty screen, where its entry animation plays instead.
   */
  readonly handover: boolean;
}

/**
 * On-screen windows for a sequence of lines (sorted by start). A line appears `leadIn` before it is
 * sung and stays `holdOut` after — but **a lead-in longer than the gap to the previous line is
 * clamped, not overlapped** (§6.5), and a hold-out never runs past the next line's appearance, so
 * dense verses hand over cleanly instead of stacking.
 */
export function lineWindows(lines: readonly RenderLyricLine[], leadIn: number, holdOut: number): readonly LineWindow[] {
  const appear = lines.map((line, i) => {
    const start = seconds(line.startTicks);
    const previousEnd = i > 0 ? seconds((lines[i - 1] as RenderLyricLine).endTicks) : -Infinity;
    // Never later than the line's own start, even if it overlaps the one before.
    return Math.min(start, Math.max(start - Math.max(0, leadIn), previousEnd));
  });
  const disappear = lines.map((line, i) => {
    const end = seconds(Math.max(line.startTicks, line.endTicks));
    const nextAppear = i + 1 < lines.length ? (appear[i + 1] as number) : Infinity;
    return Math.max(end, Math.min(end + Math.max(0, holdOut), nextAppear));
  });
  return lines.map((_, i) => ({
    appear: appear[i] as number,
    disappear: disappear[i] as number,
    handover: i > 0 && (disappear[i - 1] as number) >= (appear[i] as number) - 1e-9,
  }));
}

/**
 * The line on screen at `t`: the last one that has appeared and not yet left, or -1. With
 * overlapping lines (a mis-tap, or two roles on one layer) the later one wins.
 */
export function currentLineIndex(windows: readonly LineWindow[], t: number): number {
  let found = -1;
  for (let i = 0; i < windows.length; i += 1) {
    const w = windows[i] as LineWindow;
    if (w.appear > t) break;
    if (t < w.disappear) found = i;
  }
  return found;
}

// ---------------------------------------------------------------------------
// Modulation sources (modulation-spec §2.4)
// ---------------------------------------------------------------------------

/** Roles that count as singing. An instrumental note ("(guitar solo)") is on screen, not sung. */
export function isSungRole(role: LyricRole): boolean {
  return role !== 'instrumental-note';
}

/** How long a `wordActive` impulse takes to fall to 1/e — short enough to read as an accent. */
export const WORD_IMPULSE_SECONDS = 0.08;

/**
 * The three lyric signals as samplers of `t`, built once per project: `lyricActive` (1 while a
 * sung line is being sung), `lineProgress` (0..1 through the most recent sung line containing `t`,
 * 0 outside lines) and `wordActive` (an impulse on every word start, decaying).
 */
export function lyricSignals(lyrics: RenderLyrics): {
  readonly lyricActive: (t: number) => number;
  readonly lineProgress: (t: number) => number;
  readonly wordActive: (t: number) => number;
} {
  const sung = lyrics.lines.filter((line) => isSungRole(line.role));
  const spans = sung.map((line) => ({ start: seconds(line.startTicks), end: seconds(Math.max(line.startTicks, line.endTicks)) }));
  const starts = sung.flatMap((line) => wordSpans(line).map((span) => span.start)).sort((a, b) => a - b);

  const containing = (t: number): number => {
    let found = -1;
    for (let i = 0; i < spans.length; i += 1) {
      const span = spans[i] as WordSpan;
      if (span.start > t) break;
      if (t < span.end) found = i;
    }
    return found;
  };
  /** Index of the last start ≤ t, or -1. */
  const lastStart = (t: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((starts[mid] as number) <= t) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  };

  return {
    lyricActive: (t) => (containing(t) >= 0 ? 1 : 0),
    lineProgress: (t) => {
      const i = containing(t);
      return i < 0 ? 0 : wordProgress(spans[i] as WordSpan, t);
    },
    wordActive: (t) => {
      const i = lastStart(t);
      if (i < 0) return 0;
      const age = t - (starts[i] as number);
      return age > WORD_IMPULSE_SECONDS * 12 ? 0 : Math.exp(-age / WORD_IMPULSE_SECONDS);
    },
  };
}
