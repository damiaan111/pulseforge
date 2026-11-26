// Lyrics in the document: commands that keep timings through edits (M8, lyrics-spec §2, §3, §5),
// parse/serialize round-trips, the render snapshot, and the checklist (§9).

import { describe, expect, it } from 'vitest';

import { TICKS_PER_SECOND } from '../../src/engine/core/time.ts';
import { detectVocalSegments } from '../../src/lyrics/vocal-segments.ts';
import { validateLyrics } from '../../src/lyrics/validate.ts';
import { createDocument } from '../../src/project/create.ts';
import type { LyricLine, ProjectDocument } from '../../src/project/document.ts';
import { History } from '../../src/project/history.ts';
import { createTestIdFactory } from '../../src/project/ids.ts';
import { loadDocument } from '../../src/project/load.ts';
import {
  applyAlignment, clearLineTimes, lyricsToText, materialiseWords, mergeWithNext, moveLines,
  setLineStyle, setLineTimes, setLinesLocked, setLyricsText, setWordTimes, splitLine,
} from '../../src/project/lyrics-commands.ts';
import { parseDocument } from '../../src/project/parse.ts';
import { stringifyDocument } from '../../src/project/serialize.ts';
import { toRenderProject } from '../../src/project/snapshot.ts';

const T = (s: number) => Math.round(s * TICKS_PER_SECOND);
const blank = () => createDocument({ timestamp: '2026-01-01T00:00:00.000Z', id: '01K5A0000000000000000000P0' });

function withText(text: string, ids = createTestIdFactory('1')): ProjectDocument {
  return setLyricsText(text, ids).apply(blank());
}

/** Times every line in order, one second each from `from`. */
function timed(document: ProjectDocument, from = 10): ProjectDocument {
  return document.lyrics.lines.reduce((doc, line, i) => setLineTimes(line.id, T(from + i), T(from + i + 0.9)).apply(doc), document);
}

const texts = (doc: ProjectDocument) => doc.lyrics.lines.map((l) => l.text);
const line = (doc: ProjectDocument, i: number) => doc.lyrics.lines[i] as LyricLine;

describe('setLyricsText', () => {
  it('builds lines and section markers from the editor text, reading back to the same text', () => {
    const doc = withText('[Verse]\nOne\nTwo\n\n[Chorus]\nThree');
    expect(texts(doc)).toEqual(['One', 'Two', 'Three']);
    expect(doc.lyrics.sections.map((s) => [s.label, s.beforeLineId])).toEqual([['Verse', line(doc, 0).id], ['Chorus', line(doc, 2).id]]);
    expect(lyricsToText(doc.lyrics)).toBe('[Verse]\nOne\nTwo\n\n[Chorus]\nThree');
    // Setting the same text again changes nothing — not even an undo step.
    expect(setLyricsText(lyricsToText(doc.lyrics)).apply(doc)).toBe(doc);
  });

  it('keeps the timings of unchanged lines when lines are inserted and removed', () => {
    const doc = timed(withText('One\nTwo\nThree'));
    const edited = setLyricsText('Zero\nOne\nThree\nFour', createTestIdFactory('2')).apply(doc);
    expect(texts(edited)).toEqual(['Zero', 'One', 'Three', 'Four']);
    expect(line(edited, 1)).toBe(line(doc, 0));
    expect(line(edited, 2)).toBe(line(doc, 2));
    expect(line(edited, 0).startTicks).toBe(null);
    expect(line(edited, 3).startTicks).toBe(null);
  });

  it('keeps id, times and lock of an edited line, and its word timings only if every word matches', () => {
    let doc = timed(withText('Hold me close tonight'));
    const id = line(doc, 0).id;
    doc = setWordTimes(id, 1, T(10.3), T(10.5), { newIds: createTestIdFactory('3') }).apply(doc);
    doc = setLinesLocked([id], true).apply(doc);

    // A typo fix that keeps every word keeps the word timings.
    const fixed = setLyricsText('Hold me close tonight!').apply(doc);
    expect(line(fixed, 0)).toMatchObject({ id, locked: true, startTicks: T(10) });
    expect(line(fixed, 0).words).toHaveLength(4);
    expect(line(fixed, 0).words[1]?.startTicks).toBe(T(10.3));

    // A changed word drops them: interpolation beats attaching a timing to the wrong word.
    const changed = setLyricsText('Hold me near tonight').apply(doc);
    expect(line(changed, 0)).toMatchObject({ id, startTicks: T(10), words: [] });
  });

  it('merges keystrokes into one undo step', () => {
    const history = new History(blank());
    history.run(setLyricsText('O'));
    history.run(setLyricsText('On'));
    history.run(setLyricsText('One'));
    expect(history.entries).toHaveLength(2);
    history.undo();
    expect(history.current.lyrics.lines).toHaveLength(0);
  });
});

describe('timing commands', () => {
  it('rescales explicit words with their line when its edges move', () => {
    let doc = timed(withText('a b'));
    const id = line(doc, 0).id;
    doc = setWordTimes(id, 0, T(10), T(10.2), { newIds: createTestIdFactory('3') }).apply(doc);
    doc = setLineTimes(id, T(20), T(21.8)).apply(doc);
    // "a b" over 10..10.9 interpolates "b" to 10.45; the line doubles in length from 20, so "b"
    // lands at 20.9 and the hand-set "a" stays at the line's start.
    expect(line(doc, 0).words.map((w) => w.startTicks)).toEqual([T(20), T(20.9)]);
  });

  it('moves lines with their words, and ripples everything after', () => {
    let doc = timed(withText('a\nb\nc'));
    doc = setWordTimes(line(doc, 1).id, 0, T(11), T(11.5), { newIds: createTestIdFactory('3') }).apply(doc);
    const moved = moveLines([line(doc, 1).id], T(0.5)).apply(doc);
    expect([line(moved, 0).startTicks, line(moved, 1).startTicks, line(moved, 2).startTicks]).toEqual([T(10), T(11.5), T(12)]);
    expect(line(moved, 1).words[0]?.startTicks).toBe(T(11.5));
    const rippled = moveLines([line(doc, 1).id], T(0.5), { ripple: true }).apply(doc);
    expect([line(rippled, 0).startTicks, line(rippled, 1).startTicks, line(rippled, 2).startTicks]).toEqual([T(10), T(11.5), T(12.5)]);
  });

  it('never moves a line before zero, keeping the spacing of what moves together', () => {
    const doc = timed(withText('a\nb'), 1);
    const moved = moveLines(doc.lyrics.lines.map((l) => l.id), T(-5)).apply(doc);
    expect([line(moved, 0).startTicks, line(moved, 1).startTicks]).toEqual([0, T(1)]);
  });

  it('materialises interpolated words before setting one, so the others stay put', () => {
    const doc = timed(withText('one two three'));
    const before = materialiseWords(line(doc, 0), createTestIdFactory('4'));
    const after = setWordTimes(line(doc, 0).id, 1, T(10.4), T(10.6), { newIds: createTestIdFactory('4') }).apply(doc);
    expect(line(after, 0).words.map((w) => w.startTicks)).toEqual([before[0]?.startTicks, T(10.4), before[2]?.startTicks]);
  });

  it('clears timings of unlocked lines only by default', () => {
    let doc = timed(withText('a\nb'));
    doc = setLinesLocked([line(doc, 0).id], true).apply(doc);
    const cleared = clearLineTimes().apply(doc);
    expect([line(cleared, 0).startTicks, line(cleared, 1).startTicks]).toEqual([T(10), null]);
  });
});

describe('structure commands', () => {
  it('splits a timed line at a word, words going with their half', () => {
    const doc = timed(withText('one two three four'));
    const split = splitLine(line(doc, 0).id, 2, createTestIdFactory('5')).apply(doc);
    expect(texts(split)).toEqual(['one two', 'three four']);
    expect(line(split, 0).endTicks).toBe(line(split, 1).startTicks);
    expect(line(split, 0).startTicks).toBe(T(10));
    expect(line(split, 1).endTicks).toBe(T(10.9));
    expect(() => splitLine(line(doc, 0).id, 0).apply(doc)).toThrow();
  });

  it('merges a line with the next, spanning both and moving markers along', () => {
    const doc = timed(withText('one\n[Chorus]\ntwo\nthree'));
    const merged = mergeWithNext(line(doc, 0).id).apply(doc);
    expect(texts(merged)).toEqual(['one two', 'three']);
    expect([line(merged, 0).startTicks, line(merged, 0).endTicks]).toEqual([T(10), T(11.9)]);
    expect(merged.lyrics.sections[0]?.beforeLineId).toBe(line(merged, 1).id);
  });

  it('sets and clears per-line style', () => {
    const doc = withText('a');
    const styled = setLineStyle(line(doc, 0).id, { scale: 0.8 }).apply(doc);
    expect(line(styled, 0).style?.scale).toBe(0.8);
    expect(line(setLineStyle(line(doc, 0).id, { scale: null }).apply(styled), 0).style).toBe(null);
  });
});

describe('alignment', () => {
  it('fills unlocked lines only and reports what it skipped', () => {
    let doc = withText('one two\nthree');
    doc = setLinesLocked([line(doc, 1).id], true).apply(doc);
    const command = applyAlignment([
      { lineId: line(doc, 0).id, startTicks: T(1), endTicks: T(2), confidence: 0.9, words: [
        { text: 'one', startTicks: T(1), endTicks: T(1.4), confidence: 0.95 },
        { text: 'two', startTicks: T(1.5), endTicks: T(2), confidence: 0.3 },
      ] },
      { lineId: line(doc, 1).id, startTicks: T(3), endTicks: T(4), confidence: 0.9, words: [] },
      { lineId: 'gone', startTicks: 0, endTicks: 1, confidence: null, words: [] },
    ], createTestIdFactory('6'));
    const aligned = command.apply(doc);
    expect(command.skipped()).toBe(2);
    expect(aligned.lyrics.source).toBe('aligned');
    expect(line(aligned, 0).words.map((w) => [w.text, w.confidence])).toEqual([['one', 0.95], ['two', 0.3]]);
    expect(line(aligned, 1).startTicks).toBe(null);
  });
});

describe('the document', () => {
  it('round-trips lyrics through save and load, and omits them when empty', () => {
    expect(stringifyDocument(blank())).not.toContain('"lyrics"');
    let doc = timed(withText('[Intro]\nOne two\n(ooh)'));
    doc = setWordTimes(line(doc, 0).id, 1, T(10.5), T(10.8), { newIds: createTestIdFactory('7') }).apply(doc);
    doc = setLineStyle(line(doc, 1).id, { opacity: 0.5, color: '#ff0000' }).apply(doc);
    const text = stringifyDocument(doc);
    const loaded = loadDocument(text);
    expect(loaded.issues).toEqual([]);
    expect(loaded.document.lyrics).toEqual(doc.lyrics);
    expect(stringifyDocument(loaded.document)).toBe(text);
    expect(line(doc, 1).role).toBe('backing');
  });

  it('reports and repairs bad lyric values instead of refusing the file', () => {
    const raw = JSON.parse(stringifyDocument(timed(withText('a\nb')))) as { lyrics: { lines: Record<string, unknown>[] } };
    const first = raw.lyrics.lines[0] as Record<string, unknown>;
    first['endTicks'] = 5;
    first['text'] = 'two\nlines';
    first['role'] = 'choir';
    (raw.lyrics.lines[1] as Record<string, unknown>)['id'] = first['id'];
    const { document, issues } = parseDocument(raw);
    expect(document.lyrics.lines[0]).toMatchObject({ text: 'two lines', role: 'lead', endTicks: document.lyrics.lines[0]?.startTicks });
    expect(issues.map((i) => i.problem).sort()).toEqual(['duplicate-id', 'invalid-value', 'invalid-value', 'invalid-value']);
  });

  it('gives the engine timed lines only, in time order, and counts the rest', () => {
    let doc = withText('late\nearly\nuntimed');
    doc = setLineTimes(line(doc, 0).id, T(20), T(21)).apply(doc);
    doc = setLineTimes(line(doc, 1).id, T(5), T(6)).apply(doc);
    const { project } = toRenderProject(doc);
    expect(project.lyrics?.lines.map((l) => l.text)).toEqual(['early', 'late']);
    expect(project.lyrics?.untimedLines).toBe(1);
    expect(toRenderProject(blank()).project.lyrics).toBeUndefined();
  });
});

describe('the checklist', () => {
  it('reports untimed, overlapping, too short, too long and too fast lines', () => {
    let doc = withText('a\nb\nc\nThis line has far too many characters for its time\ne\nf');
    const at = (i: number, s: number, e: number) => { doc = setLineTimes(line(doc, i).id, T(s), T(e)).apply(doc); };
    at(0, 1, 3);
    at(1, 2.5, 4); // overlaps a
    at(2, 5, 5.1); // too short
    at(3, 6, 7); // 43 letters in 1 s
    at(4, 8, 30); // too long
    const kinds = validateLyrics(doc.lyrics).map((c) => c.kind);
    expect(kinds).toEqual(expect.arrayContaining(['overlap', 'too-short', 'reading-speed', 'too-long', 'untimed']));
  });

  it('does not call a backing line over the lead an overlap', () => {
    let doc = withText('lead line\n(backing)');
    doc = setLineTimes(line(doc, 0).id, T(1), T(3)).apply(doc);
    doc = setLineTimes(line(doc, 1).id, T(2), T(4)).apply(doc);
    expect(validateLyrics(doc.lyrics).map((c) => c.kind)).not.toContain('overlap');
  });

  it('uses the vocal segments: a line with no singing, and singing with no line', () => {
    let doc = withText('sung\nmisplaced');
    doc = setLineTimes(line(doc, 0).id, T(1), T(3)).apply(doc);
    doc = setLineTimes(line(doc, 1).id, T(20), T(22)).apply(doc);
    const checks = validateLyrics(doc.lyrics, { vocalSegments: [{ start: 1, end: 3 }, { start: 10, end: 14 }] });
    expect(checks.find((c) => c.kind === 'no-singing')?.lineIds).toEqual([line(doc, 1).id]);
    expect(checks.find((c) => c.kind === 'unassigned-singing')?.atTicks).toBe(T(10));
  });
});

describe('vocal segments', () => {
  it('finds singing relative to the track, with hysteresis, dropping blips and bridging breaths', () => {
    const rate = 100;
    const levels = new Float32Array(1000).fill(0.1); // a bed of stem bleed
    const fill = (a: number, b: number, v: number) => levels.fill(v, a * rate, b * rate);
    fill(1, 3, 0.7);
    fill(3, 3.2, 0.35); // a dip in a held note: above the off threshold, stays one segment
    fill(3.2, 4, 0.7);
    fill(4, 4.2, 0.1); // a breath: bridged
    fill(4.2, 5, 0.7);
    fill(7, 7.1, 0.9); // a blip: dropped
    const segments = detectVocalSegments(levels, rate);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.start).toBeCloseTo(1);
    expect(segments[0]?.end).toBeCloseTo(5);
    expect(detectVocalSegments(new Float32Array(500).fill(0.02), rate)).toEqual([]);
  });
});
