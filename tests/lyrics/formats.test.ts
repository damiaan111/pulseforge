// Pasted text preparation (lyrics-spec §2.2) and timed-lyrics files in and out (§2.1, §10).

import { describe, expect, it } from 'vitest';

import { TICKS_PER_SECOND } from '../../src/engine/core/time.ts';
import {
  detectLyricsFormat, exportLyrics, importLyricsFile, LyricsFormatError, type ImportedLyrics,
} from '../../src/lyrics/formats.ts';
import { cleanLyricText, prepareLyricsText, splitLongLine } from '../../src/lyrics/prepare.ts';
import { createDocument } from '../../src/project/create.ts';
import { importLyrics } from '../../src/project/lyrics-commands.ts';
import { createTestIdFactory } from '../../src/project/ids.ts';
import type { Lyrics } from '../../src/project/document.ts';

const T = (s: number) => Math.round(s * TICKS_PER_SECOND);

describe('prepareLyricsText', () => {
  it('turns bracketed annotations into section markers rather than lines', () => {
    const prepared = prepareLyricsText('[Verse 1]\nFirst line\nSecond line\n\n[Chorus: Someone]\nHook line\n');
    expect(prepared.lines.map((l) => l.text)).toEqual(['First line', 'Second line', 'Hook line']);
    expect(prepared.sections).toEqual([{ label: 'Verse 1', beforeIndex: 0 }, { label: 'Chorus: Someone', beforeIndex: 2 }]);
  });

  it('strips repeat counts into ×N markers, standalone or trailing', () => {
    const prepared = prepareLyricsText('Hold on (x2)\nLet go x3\n(2x)\nEnd');
    expect(prepared.lines.map((l) => l.text)).toEqual(['Hold on', 'Let go', 'End']);
    expect(prepared.sections).toEqual([
      { label: '×2', beforeIndex: 0 },
      { label: '×3', beforeIndex: 1 },
      { label: '×2', beforeIndex: 2 },
    ]);
  });

  it('keeps a parenthesised sung line as a backing line, and a parenthesised section name as a marker', () => {
    const prepared = prepareLyricsText('(ooh, yeah)\n(Chorus)\nMain line (with a note)');
    expect(prepared.lines).toEqual([{ text: '(ooh, yeah)', role: 'backing' }, { text: 'Main line (with a note)', role: 'lead' }]);
    expect(prepared.sections).toEqual([{ label: 'Chorus', beforeIndex: 1 }]);
  });

  it('normalises exotic whitespace and zero-width characters', () => {
    expect(cleanLyricText(' a\u00A0\u00A0b\u200Bc\u3000d ')).toBe('a bc d');
  });

  it('splits a long line at the punctuation nearest its middle, else at a space', () => {
    expect(splitLongLine('I wanted more, but all I got was the rain', 30)).toEqual(['I wanted more,', 'but all I got was the rain']);
    expect(splitLongLine('one two three four five six', 15)).toEqual(['one two three', 'four five six']);
    expect(splitLongLine('short', 30)).toEqual(['short']);
    expect(splitLongLine('Supercalifragilisticexpialidocious', 10)).toEqual(['Supercalifragilisticexpialidocious']);
  });
});

describe('import', () => {
  it('detects formats by extension, then by content', () => {
    expect(detectLyricsFormat('a.LRC', '')).toBe('lrc');
    expect(detectLyricsFormat('x.txt', 'WEBVTT\n')).toBe('vtt');
    expect(detectLyricsFormat('x.txt', '1\n00:00:01,000 --> 00:00:02,000\nhi')).toBe('srt');
    expect(detectLyricsFormat('x.txt', '[00:01.00]hi')).toBe('lrc');
    expect(detectLyricsFormat('x.txt', 'just words')).toBe(null);
    expect(() => importLyricsFile('x.txt', 'just words')).toThrow(LyricsFormatError);
  });

  it('reads LRC: repeats, metadata, offset, end markers and the end cap', () => {
    const imported = importLyricsFile('song.lrc', [
      '[ti:Song][ar:Someone]',
      '[offset:+500]',
      '[00:10.50][00:40.00]Chorus line',
      '[00:12.00]Short one',
      '[00:13.00]',
      '[00:30.00]After a long break with several words in it',
    ].join('\n'));
    expect(imported.metadata).toMatchObject({ ti: 'Song', ar: 'Someone', offset: '+500' });
    // Positive offset shows lyrics earlier: 10.50 → 10.00.
    expect(imported.lines.map((l) => [l.text, l.startTicks])).toEqual([
      ['Chorus line', T(10)],
      ['Short one', T(11.5)],
      ['After a long break with several words in it', T(29.5)],
      ['Chorus line', T(39.5)],
    ]);
    // An empty tag ends the line before it.
    expect(imported.lines[1]?.endTicks).toBe(T(12.5));
    // No end in LRC: the next start, but never more than max(3 s, 0.6 s × words) — not through the break.
    expect(imported.lines[0]?.endTicks).toBe(T(11.5));
    expect(imported.lines[2]?.endTicks).toBe(T(29.5 + 0.6 * 9));
  });

  it('reads enhanced LRC word tags, with a trailing tag as the exact end', () => {
    const imported = importLyricsFile('a.lrc', '[00:01.00]<00:01.00>Hello <00:01.60>bright <00:02.10>world <00:03.00>\n[00:05.00]Next');
    const [first] = imported.lines;
    expect(first?.text).toBe('Hello bright world');
    expect(first?.endTicks).toBe(T(3));
    expect(first?.words?.map((w) => [w.text, w.startTicks, w.endTicks])).toEqual([
      ['Hello', T(1), T(1.6)], ['bright', T(1.6), T(2.1)], ['world', T(2.1), T(3)],
    ]);
  });

  it('spreads a stamp covering several words across them by character count', () => {
    const imported = importLyricsFile('a.lrc', '[00:01.00]<00:01.00>ab cdef <00:02.00>g <00:03.00>');
    expect(imported.lines[0]?.words?.map((w) => w.startTicks)).toEqual([T(1), T(1 + 2 / 6), T(2)]);
  });

  it('reads SRT, joining the text lines of a cue and dropping tags', () => {
    const imported = importLyricsFile('a.srt', '1\n00:00:01,000 --> 00:00:03,500\n<i>First</i> half\nsecond half\n\n2\n00:00:04,000 --> 00:00:05,000\n{\\an8}Next\n');
    expect(imported.lines).toEqual([
      { text: 'First half second half', startTicks: T(1), endTicks: T(3.5), words: null },
      { text: 'Next', startTicks: T(4), endTicks: T(5), words: null },
    ]);
  });

  it('reads VTT with inline word timestamps and skips NOTE blocks', () => {
    const imported = importLyricsFile('a.vtt', 'WEBVTT\n\nNOTE made by hand\n\nintro\n00:01.000 --> 00:03.000 align:center\n<v Singer>Hello <00:00:01.800>there <00:00:02.400>friend\n');
    expect(imported.warnings).toEqual([]);
    expect(imported.lines[0]?.words?.map((w) => [w.text, w.startTicks, w.endTicks])).toEqual([
      ['Hello', T(1), T(1.8)], ['there', T(1.8), T(2.4)], ['friend', T(2.4), T(3)],
    ]);
  });

  it('reads TTML paragraphs and spans, absolute or relative', () => {
    const absolute = importLyricsFile('a.ttml', '<tt><body><div><p begin="00:00:10.000" end="00:00:12.000"><span begin="10.000s" end="10.500s">Hi</span> <span begin="10.5s" end="12s">you</span></p></div></body></tt>');
    expect(absolute.lines[0]?.words?.map((w) => w.startTicks)).toEqual([T(10), T(10.5)]);
    const relative = importLyricsFile('a.ttml', '<tt><body><p begin="10s" dur="2s">lead <span begin="0.5s">Hi</span> <span begin="1s">you</span> &amp; me</p></body></tt>');
    expect(relative.lines[0]?.text).toBe('lead Hi you & me');
    expect(relative.lines[0]?.endTicks).toBe(T(12));
    expect(relative.lines[0]?.words?.map((w) => w.startTicks)).toEqual([T(10), T(10.5), T(11), T(11.6)]); // '&' joins 'you'
  });
});

describe('export and round-trip', () => {
  const ids = createTestIdFactory('9');
  const lyricsFrom = (imported: ImportedLyrics): Lyrics => importLyrics(imported, ids).apply(createDocument({ timestamp: '2026-01-01T00:00:00.000Z' })).lyrics;
  const sample = lyricsFrom({
    format: 'srt',
    metadata: {},
    warnings: [],
    lines: [
      { text: 'Hello bright world', startTicks: T(1.23), endTicks: T(3.01), words: [
        { text: 'Hello', startTicks: T(1.23), endTicks: T(1.6) },
        { text: 'bright', startTicks: T(1.7), endTicks: T(2.1) },
        { text: 'world', startTicks: T(2.1), endTicks: T(3.01) },
      ] },
      { text: 'Second line', startTicks: T(3.01), endTicks: T(5.5), words: null },
      { text: 'After a gap', startTicks: T(9), endTicks: T(11), words: null },
    ],
  });
  const times = (lyrics: Lyrics | ImportedLyrics) => lyrics.lines.map((l) => [l.text, l.startTicks, l.endTicks]);

  it('SRT and VTT round-trip line timings exactly (ms precision)', () => {
    expect(times(importLyricsFile('x.srt', exportLyrics(sample, 'srt')))).toEqual(times(sample));
    const vtt = importLyricsFile('x.vtt', exportLyrics(sample, 'vtt'));
    expect(times(vtt)).toEqual(times(sample));
    // VTT carries the explicit word starts too.
    expect(vtt.lines[0]?.words?.map((w) => w.startTicks)).toEqual([T(1.23), T(1.7), T(2.1)]);
  });

  it('LRC round-trips starts and ends to the centisecond, using end markers only where needed', () => {
    const text = exportLyrics(sample, 'lrc', { title: 'Song' });
    expect(text).toContain('[ti:Song]');
    expect(text.split('\n').filter((l) => /^\[\d\d:\d\d\.\d\d\]$/.test(l))).toEqual(['[00:05.50]', '[00:11.00]']);
    expect(times(importLyricsFile('x.lrc', text))).toEqual(times(sample));
  });

  it('enhanced LRC round-trips word starts and the line end', () => {
    const back = importLyricsFile('x.lrc', exportLyrics(sample, 'elrc'));
    expect(back.lines[0]?.words?.map((w) => w.startTicks)).toEqual([T(1.23), T(1.7), T(2.1)]);
    expect(back.lines[0]?.endTicks).toBe(T(3.01));
  });

  it('writes ASS with \\k durations that add up to each line', () => {
    const ass = exportLyrics(sample, 'ass', { canvas: { width: 1080, height: 1920 } });
    expect(ass).toContain('PlayResX: 1080');
    const first = ass.split('\n').find((l) => l.startsWith('Dialogue:')) as string;
    expect(first).toContain('0:00:01.23,0:00:03.01');
    const ks = [...first.matchAll(/\\k(\d+)/g)].map((m) => Number(m[1]));
    expect(ks.reduce((a, b) => a + b, 0)).toBe(301 - 123);
  });

  it('exports nothing for untimed lines', () => {
    const untimed: Lyrics = { ...sample, lines: sample.lines.map((l) => ({ ...l, startTicks: null, endTicks: null })) };
    expect(exportLyrics(untimed, 'srt')).toBe('');
  });
});
