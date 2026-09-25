// Tap-to-sync (lyrics-spec §3): where a tap lands, snapping, and the three passes with one-tap undo.

import { describe, expect, it } from 'vitest';

import { TICKS_PER_SECOND } from '../../src/engine/core/time.ts';
import {
  beginTapSession, estimateLineSeconds, nearestWithin, nextTapLine, onsetPeaks, tapDown, tapFinished,
  tapPosition, tapUp, untap, type TapResult, type TapSession,
} from '../../src/lyrics/tap.ts';
import { createDocument } from '../../src/project/create.ts';
import type { ProjectDocument } from '../../src/project/document.ts';
import { createTestIdFactory } from '../../src/project/ids.ts';
import { setLineTimes, setLineTimings, setLyricsText } from '../../src/project/lyrics-commands.ts';

const T = (s: number) => Math.round(s * TICKS_PER_SECOND);

function lyricsDoc(text: string): ProjectDocument {
  return setLyricsText(text, createTestIdFactory('8')).apply(createDocument({ timestamp: '2026-01-01T00:00:00.000Z' }));
}

/** Applies a tap result to the document, as the studio does, and returns both. */
function apply(doc: ProjectDocument, result: TapResult): [ProjectDocument, TapSession] {
  return [result.changes.length === 0 ? doc : setLineTimings(result.changes).apply(doc), result.session];
}

const times = (doc: ProjectDocument) => doc.lyrics.lines.map((l) => [l.startTicks, l.endTicks]);

describe('where a tap lands', () => {
  it('subtracts the event age and the latency, scaled by the playback rate', () => {
    expect(tapPosition(10, 20, 100, 1)).toBeCloseTo(9.88);
    // At half speed, 120 ms of reaction is 60 ms of song.
    expect(tapPosition(10, 20, 100, 0.5)).toBeCloseTo(9.94);
  });

  it('finds onset peaks and snaps to the nearest within the window', () => {
    const data = new Float32Array(240);
    data[48] = 0.9; data[49] = 0.6; // a peak at 0.2 s
    data[120] = 0.5; data[122] = 0.8; // two within 60 ms: the higher wins, at 0.508 s
    data[200] = 0.2; // below the level
    const peaks = onsetPeaks({ rate: 240, data });
    expect(peaks).toEqual([0.2, 122 / 240]);
    expect(nearestWithin(0.26, peaks, 0.08)).toBe(0.2);
    expect(nearestWithin(0.35, peaks, 0.08)).toBe(null);
  });

  it('estimates an untapped end at about eight letters a second, within 1–8 s', () => {
    expect(estimateLineSeconds('Hi')).toBe(1);
    expect(estimateLineSeconds('Twenty letters here!')).toBeCloseTo(17 * 0.12);
    expect(estimateLineSeconds('x'.repeat(200))).toBe(8);
  });
});

describe('pass 1: line starts', () => {
  it('stamps each line in turn, and pulls an estimated end back to the next tap', () => {
    let doc = lyricsDoc('Hello there\nGeneral song line');
    let session = beginTapSession(doc.lyrics, 'starts');
    [doc, session] = apply(doc, tapDown(doc.lyrics, session, T(1)));
    expect(times(doc)[0]).toEqual([T(1), T(1 + estimateLineSeconds('Hello there'))]);
    [doc, session] = apply(doc, tapUp(doc.lyrics, session, T(1.1)));
    [doc, session] = apply(doc, tapDown(doc.lyrics, session, T(1.8)));
    expect(times(doc)).toEqual([[T(1), T(1.8)], [T(1.8), T(1.8 + estimateLineSeconds('General song line'))]]);
    expect(tapFinished(doc.lyrics, session)).toBe(true);
  });

  it('keeps an estimated end that the next tap does not reach — a gap is a gap', () => {
    let doc = lyricsDoc('One\nTwo');
    let session = beginTapSession(doc.lyrics, 'starts');
    [doc, session] = apply(doc, tapDown(doc.lyrics, session, T(1)));
    [doc] = apply(doc, tapDown(doc.lyrics, session, T(20)));
    expect(times(doc)[0]).toEqual([T(1), T(2)]);
  });

  it('marks the end when the key is held through the line', () => {
    let doc = lyricsDoc('Hold this one\nNext');
    let session = beginTapSession(doc.lyrics, 'starts');
    [doc, session] = apply(doc, tapDown(doc.lyrics, session, T(2)));
    [doc, session] = apply(doc, tapUp(doc.lyrics, session, T(3.4)));
    expect(times(doc)[0]).toEqual([T(2), T(3.4)]);
    // A later tap that comes after the held end leaves it alone.
    [doc] = apply(doc, tapDown(doc.lyrics, session, T(4)));
    expect(times(doc)[0]).toEqual([T(2), T(3.4)]);
  });

  it('undoes one tap at a time, restoring what it changed, and taps that line again', () => {
    let doc = lyricsDoc('One\nTwo');
    let session = beginTapSession(doc.lyrics, 'starts');
    [doc, session] = apply(doc, tapDown(doc.lyrics, session, T(1)));
    const afterFirst = times(doc);
    [doc, session] = apply(doc, tapDown(doc.lyrics, session, T(1.5)));
    [doc, session] = apply(doc, untap(session));
    expect(times(doc)).toEqual(afterFirst);
    expect(nextTapLine(doc.lyrics, session)?.text).toBe('Two');
    [doc, session] = apply(doc, untap(session));
    expect(times(doc)).toEqual([[null, null], [null, null]]);
    expect(untap(session).changes).toEqual([]);
  });

  it('re-tapping a timed line moves it with its length and words (punch-in)', () => {
    let doc = lyricsDoc('a\nb\nc');
    doc = setLineTimes(doc.lyrics.lines[1]!.id, T(10), T(12)).apply(doc);
    let session = beginTapSession(doc.lyrics, 'starts', [doc.lyrics.lines[1]!.id]);
    [doc, session] = apply(doc, tapDown(doc.lyrics, session, T(10.5)));
    expect(times(doc)).toEqual([[null, null], [T(10.5), T(12.5)], [null, null]]);
    expect(tapFinished(doc.lyrics, session)).toBe(true);
  });
});

describe('pass 2: ends and words', () => {
  it('ends mode ends each timed line in turn, skipping untimed ones', () => {
    let doc = lyricsDoc('a\nuntimed\nc');
    doc = setLineTimes(doc.lyrics.lines[0]!.id, T(1), T(5)).apply(doc);
    doc = setLineTimes(doc.lyrics.lines[2]!.id, T(6), T(9)).apply(doc);
    let session = beginTapSession(doc.lyrics, 'ends');
    [doc, session] = apply(doc, tapDown(doc.lyrics, session, T(2.5)));
    expect(nextTapLine(doc.lyrics, session)?.text).toBe('c');
    [doc] = apply(doc, tapDown(doc.lyrics, session, T(7)));
    expect(times(doc)).toEqual([[T(1), T(2.5)], [null, null], [T(6), T(7)]]);
  });

  it('words mode stamps word starts, ends the one before, and a last tap ends the line', () => {
    let doc = lyricsDoc('one two three');
    doc = setLineTimes(doc.lyrics.lines[0]!.id, T(1), T(3)).apply(doc);
    let session = beginTapSession(doc.lyrics, 'words');
    const ids = createTestIdFactory('9');
    for (const s of [1.1, 1.6, 2.2, 3.3]) [doc, session] = apply(doc, tapDown(doc.lyrics, session, T(s), ids));
    const line = doc.lyrics.lines[0]!;
    expect(line.words.map((w) => [w.startTicks, w.endTicks])).toEqual([[T(1.1), T(1.6)], [T(1.6), T(2.2)], [T(2.2), T(3.3)]]);
    expect([line.startTicks, line.endTicks]).toEqual([T(1), T(3.3)]);
    expect(tapFinished(doc.lyrics, session)).toBe(true);
  });

  it('refuses words mode on an untimed line, and a session with no lines', () => {
    const doc = lyricsDoc('one two');
    expect(() => beginTapSession(doc.lyrics, 'words')).toThrow(/no timing/);
    expect(() => beginTapSession(lyricsDoc('').lyrics, 'starts')).toThrow(/no lyric lines/);
  });
});

describe('lyric timecodes', () => {
  it('formats to the hundredth and reads what people type', async () => {
    const { formatLyricTime, parseLyricTime } = await import('../../src/lyrics/timecode.ts');
    expect(formatLyricTime(T(62.354))).toBe('1:02.35');
    expect(formatLyricTime(null)).toBe('');
    expect(parseLyricTime('1:02.35')).toBe(T(62.35));
    expect(parseLyricTime('62,5')).toBe(T(62.5));
    expect(parseLyricTime('0:01:02.350')).toBe(T(62.35));
    expect(parseLyricTime('1:75')).toBe(null);
    expect(parseLyricTime('soon')).toBe(null);
    expect(parseLyricTime('  ')).toBe(undefined);
  });
});
