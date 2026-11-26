// Which part of the song is which lyric line (M26; lyrics-spec §4 "Align, text provided").
//
// Forced alignment needs a rough window per line: aligning a three-minute song against all its text
// at once is slow and fragile. Whisper's transcript supplies the windows — but a transcript of sung
// vocals mishears words, skips repeats and adds ad-libs, so it cannot be used line by line.
// Instead the *words* of the lyrics are aligned to the *words* of the transcript as two sequences
// (global alignment, Needleman–Wunsch), scoring by how alike two words look — "flickered" and
// "flicker" match, "the" and "neon" do not. Each line's window is then the time span of the
// transcript words its own words matched, padded a little. A line with no match (a repeat Whisper
// skipped) is placed in the gap between its neighbours, by length; one that cannot be placed is
// reported, never guessed.
//
// Pure, in seconds of the audio the transcript was made from.

import { lyricTokens } from '../engine/core/lyrics.ts';
import { splitLongLine } from './prepare.ts';

export interface TranscriptWord {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export interface TranscriptSegment {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly words: readonly TranscriptWord[];
}

export interface LineToAlign {
  readonly id: string;
  readonly text: string;
}

export interface AlignWindow {
  readonly lineId: string;
  readonly text: string;
  readonly start: number;
  readonly end: number;
  /** How the window was found: matched transcript words, or placed between neighbours. */
  readonly how: 'matched' | 'interpolated';
}

export interface MatchResult {
  readonly windows: readonly AlignWindow[];
  /** Lines no window could be found for: tap them, or check the text. */
  readonly unplaced: readonly string[];
}

/** Letters and digits, lower case: what is sung, without punctuation or case. */
export function sungWord(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/** 0..1 — normalised Levenshtein similarity. */
export function wordSimilarity(a: string, b: string): number {
  if (a === b) return a === '' ? 0 : 1;
  if (a.length === 0 || b.length === 0) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min((previous[j] as number) + 1, (row[j - 1] as number) + 1, (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = row;
  }
  return 1 - (previous[b.length] as number) / Math.max(a.length, b.length);
}

const MATCH_THRESHOLD = 0.6;
const GAP = -0.4;
const MISMATCH = -1;

/**
 * Pairs (lyric word index, transcript word index) along the best global alignment, keeping only
 * pairs that look alike. Monotonic by construction: the order of the song is kept.
 */
export function alignWordSequences(lyric: readonly string[], heard: readonly string[]): [number, number][] {
  const n = lyric.length;
  const m = heard.length;
  const score = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  const move = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1)); // 1 diag, 2 up, 3 left
  for (let i = 1; i <= n; i += 1) {
    (score[i] as Float64Array)[0] = i * GAP;
    (move[i] as Uint8Array)[0] = 2;
  }
  for (let j = 1; j <= m; j += 1) {
    (score[0] as Float64Array)[j] = j * GAP;
    (move[0] as Uint8Array)[j] = 3;
  }
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      const sim = wordSimilarity(lyric[i - 1] as string, heard[j - 1] as string);
      const diag = ((score[i - 1] as Float64Array)[j - 1] as number) + (sim >= MATCH_THRESHOLD ? 1 + sim : MISMATCH);
      const up = ((score[i - 1] as Float64Array)[j] as number) + GAP;
      const left = ((score[i] as Float64Array)[j - 1] as number) + GAP;
      const best = Math.max(diag, up, left);
      (score[i] as Float64Array)[j] = best;
      (move[i] as Uint8Array)[j] = best === diag ? 1 : best === up ? 2 : 3;
    }
  }
  const pairs: [number, number][] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const step = (move[i] as Uint8Array)[j];
    if (step === 1) {
      if (wordSimilarity(lyric[i - 1] as string, heard[j - 1] as string) >= MATCH_THRESHOLD) pairs.push([i - 1, j - 1]);
      i -= 1;
      j -= 1;
    } else if (step === 2) {
      i -= 1;
    } else {
      j -= 1;
    }
  }
  return pairs.reverse();
}

export interface MatchOptions {
  /** Length of the audio, seconds: windows never leave it. */
  readonly duration: number;
  /** Added before and after each window, seconds: the aligner needs a little room. */
  readonly pad?: number;
}

export function matchLyricsToTranscript(lines: readonly LineToAlign[], segments: readonly TranscriptSegment[], options: MatchOptions): MatchResult {
  const pad = options.pad ?? 0.35;
  const heard = segments.flatMap((s) => s.words).filter((w) => sungWord(w.text) !== '');
  const lyricWords: { line: number; text: string }[] = [];
  lines.forEach((line, index) => {
    for (const token of lyricTokens(line.text)) {
      const text = sungWord(token.text);
      if (text !== '') lyricWords.push({ line: index, text });
    }
  });
  const pairs = alignWordSequences(lyricWords.map((w) => w.text), heard.map((w) => sungWord(w.text)));

  // Per line, the transcript words its words matched — in the densest cluster, so one stray match
  // of a common word far away cannot stretch a window across a verse.
  const matched = lines.map(() => [] as TranscriptWord[]);
  for (const [li, hi] of pairs) (matched[(lyricWords[li] as { line: number }).line] as TranscriptWord[]).push(heard[hi] as TranscriptWord);
  const spans: ({ start: number; end: number } | null)[] = matched.map((words) => {
    if (words.length === 0) return null;
    const clusters: TranscriptWord[][] = [[words[0] as TranscriptWord]];
    for (let k = 1; k < words.length; k += 1) {
      const word = words[k] as TranscriptWord;
      const last = clusters[clusters.length - 1] as TranscriptWord[];
      if (word.start - (last[last.length - 1] as TranscriptWord).end > 4) clusters.push([word]);
      else last.push(word);
    }
    const best = clusters.reduce((a, b) => (b.length > a.length ? b : a));
    return { start: (best[0] as TranscriptWord).start, end: (best[best.length - 1] as TranscriptWord).end };
  });

  // Unmatched lines: shared out across the gap between the matched lines around them, by length.
  const placed = spans.map((span) => span);
  let index = 0;
  while (index < lines.length) {
    if (placed[index] !== null) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < lines.length && placed[end] === null) end += 1;
    const before = index > 0 ? (placed[index - 1] as { end: number }).end : 0;
    const after = end < lines.length ? (placed[end] as { start: number }).start : options.duration;
    const gap = after - before;
    const weights = lines.slice(index, end).map((l) => Math.max(1, sungWord(l.text).length));
    const total = weights.reduce((a, b) => a + b, 0);
    // Room for at least ~0.15 s a character: otherwise the lines are not in this gap at all.
    if (gap >= total * 0.15) {
      let cursor = before;
      for (let k = index; k < end; k += 1) {
        const length = (gap * (weights[k - index] as number)) / total;
        placed[k] = { start: cursor, end: cursor + length };
        cursor += length;
      }
    }
    index = end;
  }

  const windows: AlignWindow[] = [];
  const unplaced: string[] = [];
  lines.forEach((line, k) => {
    const span = placed[k];
    if (span === null || span === undefined) {
      unplaced.push(line.id);
      return;
    }
    windows.push({
      lineId: line.id,
      text: line.text,
      start: Math.max(0, span.start - pad),
      end: Math.min(options.duration, span.end + pad),
      how: spans[k] === null ? 'interpolated' : 'matched',
    });
  });
  return { windows, unplaced };
}

/**
 * Transcribe mode (no text given): the transcript as lines. Whisper's segments can run to 30 s, so
 * they are cut where the singer breathes (a pause over 0.6 s between words) and where a line grows
 * past ~42 characters, at its natural break.
 */
const LONE_WORD_GAP_SECONDS = 3;

export function linesFromTranscript(segments: readonly TranscriptSegment[], maxChars = 42): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  for (const segment of segments) {
    const words = segment.words.filter((w) => w.text.trim() !== '');
    if (words.length === 0) {
      const text = segment.text.trim();
      if (text !== '') out.push({ text, start: segment.start, end: segment.end });
      continue;
    }
    const phrases: TranscriptWord[][] = [[words[0] as TranscriptWord]];
    for (let k = 1; k < words.length; k += 1) {
      const word = words[k] as TranscriptWord;
      const last = phrases[phrases.length - 1] as TranscriptWord[];
      if (word.start - (last[last.length - 1] as TranscriptWord).end > 0.6) phrases.push([word]);
      else last.push(word);
    }
    // A lone first word seconds ahead of its phrase is the voice filter stretching a segment back
    // over wordless singing, not a line: the word belongs to what follows, and alignment times it.
    const lone = phrases[0] as TranscriptWord[];
    const following = phrases[1];
    if (lone.length === 1 && following !== undefined) {
      const start = (following[0] as TranscriptWord).start;
      if (start - (lone[0] as TranscriptWord).end > LONE_WORD_GAP_SECONDS) {
        following.unshift({ ...(lone[0] as TranscriptWord), start, end: start });
        phrases.shift();
      }
    }
    for (const phrase of phrases) {
      const text = phrase.map((w) => w.text.trim()).join(' ');
      const parts = splitLongLine(text, maxChars);
      // Times for split parts: by how many words each takes.
      let cursor = 0;
      for (const part of parts) {
        const count = part.split(/\s+/).filter((w) => w !== '').length;
        const first = phrase[cursor] as TranscriptWord;
        const last = phrase[Math.min(phrase.length - 1, cursor + count - 1)] as TranscriptWord;
        out.push({ text: part, start: first.start, end: last.end });
        cursor += count;
      }
    }
  }
  return out;
}
