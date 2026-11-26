// The engine's lyric timing (lyrics-spec §2.3, §6.4, §6.5; modulation-spec §2.4).

import { describe, expect, it } from 'vitest';

import {
  currentLineIndex, lineWindows, lyricSignals, lyricTokens, wordProgress, wordSpans,
  type RenderLyricLine,
} from '../../src/engine/core/lyrics.ts';
import { TICKS_PER_SECOND } from '../../src/engine/core/time.ts';

const T = (s: number) => Math.round(s * TICKS_PER_SECOND);
const line = (text: string, start: number, end: number, extra: Partial<RenderLyricLine> = {}): RenderLyricLine => ({
  id: text, text, startTicks: T(start), endTicks: T(end), role: 'lead', words: [], style: null, ...extra,
});

describe('lyricTokens', () => {
  it('splits on whitespace and keeps elisions and hyphens whole', () => {
    expect(lyricTokens("don't stop rock-'n'-roll").map((t) => t.text)).toEqual(["don't", 'stop', "rock-'n'-roll"]);
  });

  it('attaches free-standing punctuation to the word before it', () => {
    const tokens = lyricTokens('hold on — hold on !');
    expect(tokens.map((t) => t.text)).toEqual(['hold', 'on —', 'hold', 'on !']);
    // Ranges index the original text, so the renderer can map rasterised words onto tokens.
    expect(tokens[1]).toMatchObject({ start: 5, end: 9 });
  });

  it('gives leading punctuation to the first word, and a punctuation-only line one token', () => {
    expect(lyricTokens('… and then').map((t) => t.text)).toEqual(['… and', 'then']);
    expect(lyricTokens('! ?').map((t) => t.text)).toEqual(['! ?']);
    expect(lyricTokens('   ')).toEqual([]);
  });
});

describe('word timing', () => {
  it('distributes an untimed line by character count, not evenly', () => {
    const spans = wordSpans(line('I everything', 10, 11));
    // "I" is 1 character of 11: it gets 1/11 of the second.
    expect(spans[0]?.start).toBeCloseTo(10);
    expect(spans[0]?.end).toBeCloseTo(10 + 1 / 11);
    expect(spans[1]?.end).toBeCloseTo(11);
  });

  it('uses explicit word timings when there is one per token, and interpolates otherwise', () => {
    const words = [{ startTicks: T(1), endTicks: T(1.2) }, { startTicks: T(1.5), endTicks: T(2) }];
    expect(wordSpans(line('hello world', 1, 2, { words }))[1]).toEqual({ start: 1.5, end: 2 });
    const mismatched = wordSpans(line('hello big world', 1, 2, { words }));
    expect(mismatched).toHaveLength(3);
    expect(mismatched[1]?.start).toBeGreaterThan(1);
  });

  it('holds a finished word at 1 through a gap instead of filling into silence', () => {
    const span = { start: 1, end: 1.5 };
    expect(wordProgress(span, 0.9)).toBe(0);
    expect(wordProgress(span, 1.25)).toBeCloseTo(0.5);
    expect(wordProgress(span, 1.9)).toBe(1);
  });
});

describe('line windows', () => {
  it('shows a line lead-in early and hold-out late when there is room', () => {
    const [w] = lineWindows([line('a', 10, 12)], 0.5, 0.3);
    expect(w).toEqual({ appear: 9.5, disappear: 12.3, handover: false });
  });

  it('clamps a lead-in to the gap before it, and a hold-out to the next appearance', () => {
    const windows = lineWindows([line('a', 10, 12), line('b', 12.2, 14)], 0.5, 0.3);
    // b may not appear before a has finished; a leaves exactly when b appears: a hand-over.
    expect(windows[1]?.appear).toBeCloseTo(12);
    expect(windows[0]?.disappear).toBeCloseTo(12);
    expect(windows[1]?.handover).toBe(true);
  });

  it('marks an entry after a gap as not a hand-over', () => {
    const windows = lineWindows([line('a', 10, 12), line('b', 20, 22)], 0.5, 0.3);
    expect(windows[1]).toMatchObject({ appear: 19.5, handover: false });
  });

  it('never lets an overlapping line appear later than it starts', () => {
    const windows = lineWindows([line('a', 10, 13), line('b', 12, 14)], 0.5, 0.3);
    expect(windows[1]?.appear).toBeCloseTo(12);
  });

  it('finds the line on screen, the later one when two overlap', () => {
    const windows = lineWindows([line('a', 10, 12), line('b', 20, 22)], 0.5, 0.3);
    expect(currentLineIndex(windows, 5)).toBe(-1);
    expect(currentLineIndex(windows, 11)).toBe(0);
    expect(currentLineIndex(windows, 15)).toBe(-1);
    expect(currentLineIndex(windows, 19.6)).toBe(1);
  });
});

describe('lyric modulation signals', () => {
  const signals = lyricSignals({
    lines: [line('one two', 1, 2), line('(guitar solo)', 3, 5, { role: 'instrumental-note' }), line('three', 6, 7, { role: 'backing' })],
    untimedLines: 0,
  });

  it('lyricActive is 1 while a sung line is sung, not during an instrumental note', () => {
    expect(signals.lyricActive(0.5)).toBe(0);
    expect(signals.lyricActive(1.5)).toBe(1);
    expect(signals.lyricActive(4)).toBe(0);
    expect(signals.lyricActive(6.5)).toBe(1);
  });

  it('lineProgress runs 0..1 through the line and is 0 outside', () => {
    expect(signals.lineProgress(1.25)).toBeCloseTo(0.25);
    expect(signals.lineProgress(2.5)).toBe(0);
  });

  it('wordActive fires on each word start and decays', () => {
    // "one two" over 1..2 s by characters: "two" starts at 1.5 s.
    expect(signals.wordActive(1)).toBeCloseTo(1);
    expect(signals.wordActive(1.49)).toBeLessThan(0.01);
    expect(signals.wordActive(1.5)).toBeCloseTo(1);
    expect(signals.wordActive(0.5)).toBe(0);
  });

  it('is a pure function of t', () => {
    const a = [0.3, 1.7, 6.2].map((t) => [signals.lyricActive(t), signals.lineProgress(t), signals.wordActive(t)]);
    const b = [6.2, 1.7, 0.3].reverse().map((t) => [signals.lyricActive(t), signals.lineProgress(t), signals.wordActive(t)]);
    expect(a).toEqual(b);
  });
});
