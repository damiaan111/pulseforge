// Aligner output → lyric timings, with the sanity pass (M26; lyrics-spec §4 "Output handling").
//
// The aligner returns one entry per whitespace run of the text it was given, each with a start,
// end and score — or none, for a run it could not place (digits and symbols are not in the
// alignment model's alphabet). This turns that into our words (lyricTokens: a run that is only
// punctuation belongs to the word before it), fills the unplaced ones in by length between their
// neighbours, and then **rejects** what is obviously broken rather than writing nonsense:
//
//  - most of the line could not be placed;
//  - words out of order, or a word of no length;
//  - no singing under the line (the vocal stem's detected segments), when those are known.
//
// A rejected line keeps whatever timing it had and is reported, so it can be timed by hand.
// Confidence is the mean word score — what the editor's heat and the checklist read.

import { lyricTokens } from '../engine/core/lyrics.ts';
import { TICKS_PER_SECOND, sourceToTimelineSeconds, type AudioPlacement } from '../engine/core/time.ts';
import type { AlignedLine, AlignedWord } from '../project/lyrics-commands.ts';
import { coveredSeconds, type VocalSegment } from './vocal-segments.ts';

export interface AlignerWord {
  readonly word: string;
  readonly start: number | null;
  readonly end: number | null;
  readonly score: number | null;
}

export type AlignOutcome =
  | { readonly ok: true; readonly line: AlignedLine }
  | { readonly ok: false; readonly lineId: string; readonly reason: string };

export interface ResultOptions {
  /** Maps the aligned audio's seconds onto the timeline. */
  readonly placement: AudioPlacement;
  /** Singing detected on the vocal stem, in **timeline** seconds. */
  readonly vocalSegments?: readonly VocalSegment[];
}

const MIN_WORD_SECONDS = 0.02;

/**
 * Whitespace runs of `text` → lyric tokens: the index of the token each run belongs to. A run with
 * no letter or digit joins the token before it (or the first token).
 */
function runToToken(text: string): number[] {
  const runs = text.split(/\s+/).filter((r) => r !== '');
  const tokens = lyricTokens(text);
  const map: number[] = [];
  let token = 0;
  let consumed = '';
  for (const run of runs) {
    const current = tokens[token];
    if (current === undefined) {
      map.push(tokens.length - 1);
      continue;
    }
    consumed = consumed === '' ? run : `${consumed} ${run}`;
    map.push(token);
    if (consumed.replace(/\s+/g, ' ') === current.text.replace(/\s+/g, ' ')) {
      token += 1;
      consumed = '';
    }
  }
  return map;
}

export function alignedLineFrom(lineId: string, text: string, words: readonly AlignerWord[], options: ResultOptions): AlignOutcome {
  const tokens = lyricTokens(text);
  if (tokens.length === 0) return { ok: false, lineId, reason: 'the line has no words' };
  const toToken = runToToken(text);
  // Per token: the earliest start, latest end and mean score of the runs in it.
  const spans = tokens.map(() => ({ start: null as number | null, end: null as number | null, scores: [] as number[] }));
  words.forEach((word, i) => {
    const t = toToken[i];
    if (t === undefined) return;
    const span = spans[t] as (typeof spans)[number];
    if (word.start !== null) span.start = span.start === null ? word.start : Math.min(span.start, word.start);
    if (word.end !== null) span.end = span.end === null ? word.end : Math.max(span.end, word.end);
    if (word.score !== null) span.scores.push(word.score);
  });
  const placed = spans.filter((s) => s.start !== null && s.end !== null).length;
  if (placed < Math.ceil(tokens.length / 2)) {
    return { ok: false, lineId, reason: `only ${placed} of ${tokens.length} words could be aligned` };
  }

  // Fill unplaced words by length between the placed ones around them.
  const weight = (i: number) => Math.max(1, [...(tokens[i] as { text: string }).text].filter((ch) => /[\p{L}\p{N}]/u.test(ch)).length);
  let i = 0;
  while (i < spans.length) {
    const span = spans[i] as (typeof spans)[number];
    if (span.start !== null && span.end !== null) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < spans.length && ((spans[j] as (typeof spans)[number]).start === null || (spans[j] as (typeof spans)[number]).end === null)) j += 1;
    const before = i > 0 ? ((spans[i - 1] as (typeof spans)[number]).end as number) : null;
    const after = j < spans.length ? ((spans[j] as (typeof spans)[number]).start as number) : null;
    const from = before ?? (after as number) - 0.25 * (j - i);
    const to = after ?? (before as number) + 0.25 * (j - i);
    const total = Array.from({ length: j - i }, (_, k) => weight(i + k)).reduce((a, b) => a + b, 0);
    let cursor = from;
    for (let k = i; k < j; k += 1) {
      const length = ((to - from) * weight(k)) / total;
      const target = spans[k] as (typeof spans)[number];
      target.start = cursor;
      target.end = cursor + length;
      cursor += length;
    }
    i = j;
  }

  for (let k = 0; k < spans.length; k += 1) {
    const span = spans[k] as { start: number; end: number };
    if (span.end - span.start < MIN_WORD_SECONDS) return { ok: false, lineId, reason: `“${(tokens[k] as { text: string }).text}” came out with no length` };
    if (k > 0 && span.start < (spans[k - 1] as { start: number }).start) return { ok: false, lineId, reason: 'words came out of order' };
  }

  const toTimeline = (s: number) => sourceToTimelineSeconds(s, options.placement);
  const lineStart = toTimeline((spans[0] as { start: number }).start);
  const lineEnd = toTimeline((spans[spans.length - 1] as { end: number }).end);
  if (options.vocalSegments !== undefined && lineEnd > lineStart) {
    const covered = coveredSeconds(options.vocalSegments, lineStart, lineEnd);
    if (covered / (lineEnd - lineStart) < 0.15) return { ok: false, lineId, reason: 'no singing was detected where it landed' };
  }

  const ticks = (s: number) => Math.round(toTimeline(s) * TICKS_PER_SECOND);
  const alignedWords: AlignedWord[] = spans.map((span, k) => ({
    text: (tokens[k] as { text: string }).text,
    startTicks: ticks(span.start as number),
    endTicks: ticks(span.end as number),
    confidence: span.scores.length === 0 ? null : span.scores.reduce((a, b) => a + b, 0) / span.scores.length,
  }));
  const scored = alignedWords.filter((w) => w.confidence !== null).map((w) => w.confidence as number);
  return {
    ok: true,
    line: {
      lineId,
      startTicks: (alignedWords[0] as AlignedWord).startTicks,
      endTicks: (alignedWords[alignedWords.length - 1] as AlignedWord).endTicks,
      words: alignedWords,
      confidence: scored.length === 0 ? null : scored.reduce((a, b) => a + b, 0) / scored.length,
    },
  };
}
