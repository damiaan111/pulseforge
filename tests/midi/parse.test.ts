// Standard MIDI files to notes in exact time (C3). The files are built here byte by byte, so what
// each test feeds the parser is visible in the test.

import { describe, expect, it } from 'vitest';

import { MidiParseError, noteName, parseMidi } from '../../src/midi/parse.ts';

const text = (s: string) => [...s].map((c) => c.charCodeAt(0));
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n: number) => [(n >>> 8) & 255, n & 255];

function vlq(n: number): number[] {
  const out = [n & 0x7f];
  let rest = n >>> 7;
  while (rest > 0) {
    out.unshift((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  return out;
}

const header = (format: number, tracks: number, division: number) => [...text('MThd'), ...u32(6), ...u16(format), ...u16(tracks), ...u16(division)];
const track = (...events: number[]) => [...text('MTrk'), ...u32(events.length + 4), ...events, 0, 0xff, 0x2f, 0];
const tempo = (micros: number) => [0xff, 0x51, 3, (micros >>> 16) & 255, (micros >>> 8) & 255, micros & 255];
const file = (...parts: number[][]) => new Uint8Array(parts.flat());

/** Delta, note-on; delta, note-off. */
const note = (delta: number, pitch: number, length: number, velocity = 100, channel = 0) => [...vlq(delta), 0x90 | channel, pitch, velocity, ...vlq(length), 0x80 | channel, pitch, 0];

describe('parseMidi', () => {
  it('reads format 0 at the default tempo: 120 bpm, a quarter note is half a second', () => {
    const midi = parseMidi(file(header(0, 1, 480), track(...note(0, 60, 480), ...note(480, 62, 240, 64, 9))));
    expect(midi.format).toBe(0);
    expect(midi.notes).toEqual([
      { ticks: 0, endTicks: 24_000, note: 60, velocity: 100, channel: 0 },
      { ticks: 48_000, endTicks: 60_000, note: 62, velocity: 64, channel: 9 },
    ]);
    expect(midi.warnings).toEqual([]);
  });

  it('merges format 1 tracks, taking the tempo map from any of them', () => {
    const conductor = track(0, ...tempo(1_000_000));
    const midi = parseMidi(file(header(1, 2, 96), conductor, track(...note(96, 36, 96))));
    expect(midi.trackCount).toBe(2);
    expect(midi.tempoChanges).toBe(1);
    expect(midi.notes).toEqual([{ ticks: 48_000, endTicks: 96_000, note: 36, velocity: 100, channel: 0 }]);
  });

  it('applies a tempo change only from where it happens', () => {
    // A quarter at 120 bpm (0.5 s), then 60 bpm: the next quarter takes a second.
    const midi = parseMidi(file(header(1, 2, 480), track(...vlq(480), ...tempo(1_000_000)), track(...note(480, 60, 480))));
    expect(midi.notes[0]).toMatchObject({ ticks: 24_000, endTicks: 72_000 });
  });

  it('stays exact across thousands of tempo changes, where adding seconds would drift', () => {
    // A third of a quarter at each of three tempos, three thousand times over. None of those steps is
    // a whole microsecond; the sum of all of them is exactly 1200 s.
    const events: number[] = [];
    for (let i = 0; i < 3_000; i += 1) events.push(i === 0 ? 0 : 1, ...tempo(500_000), 1, ...tempo(400_000), 1, ...tempo(300_000));
    const midi = parseMidi(file(header(0, 1, 3), track(...events, 1, 0x90, 60, 100, 1, 0x80, 60, 0)));
    expect(midi.tempoChanges).toBe(9_000);
    expect(midi.notes[0]?.ticks).toBe(1_200 * 48_000);
  });

  it('follows running status, including a note-on at velocity 0 as a note-off', () => {
    const midi = parseMidi(file(header(0, 1, 480), track(0, 0x90, 60, 100, ...vlq(240), 60, 0, 0, 64, 90, ...vlq(240), 64, 0)));
    expect(midi.notes).toEqual([
      { ticks: 0, endTicks: 12_000, note: 60, velocity: 100, channel: 0 },
      { ticks: 12_000, endTicks: 24_000, note: 64, velocity: 90, channel: 0 },
    ]);
  });

  it('skips what is not a note: controllers, programs, bends, sysex, text and unknown chunks', () => {
    const noise = [0, 0xb0, 7, 100, 0, 0xc0, 5, 0, 0xd0, 40, 0, 0xe0, 0, 64, 0, 0xa0, 60, 30, 0, 0xf0, 2, 1, 0xf7, 0, 0xff, 1, 3, 97, 98, 99];
    const midi = parseMidi(file(header(0, 1, 480), [...text('JUNK'), ...u32(3), 1, 2, 3], track(...noise, ...note(0, 60, 240))));
    expect(midi.notes).toHaveLength(1);
    expect(midi.warnings).toEqual([]);
  });

  it('reads a long delta time and a large file tick', () => {
    const midi = parseMidi(file(header(0, 1, 480), track(...note(0x0fffff, 60, 1))));
    expect(midi.notes[0]?.ticks).toBe(Math.round(0x0fffff / 480 * 24_000));
  });

  it('says so when notes never end, or an end has no note, and keeps what it can', () => {
    const midi = parseMidi(file(header(0, 1, 480), track(0, 0x90, 60, 100, ...vlq(240), 0x80, 61, 0, ...vlq(240), 0xc0, 1)));
    expect(midi.notes).toEqual([{ ticks: 0, endTicks: 24_000, note: 60, velocity: 100, channel: 0 }]);
    expect(midi.warnings).toEqual([expect.stringContaining('1 note never ended'), expect.stringContaining('1 note-off had no note')]);
  });

  it('pairs repeated notes first in, first out', () => {
    const midi = parseMidi(file(header(0, 1, 480), track(0, 0x90, 60, 10, ...vlq(240), 60, 20, ...vlq(240), 60, 0, ...vlq(240), 60, 0)));
    expect(midi.notes.map((n) => [n.ticks, n.endTicks, n.velocity])).toEqual([[0, 24_000, 10], [12_000, 36_000, 20]]);
  });

  it('counts SMPTE time from frames, with tempo having no say', () => {
    const smpte = 0x10000 - (25 << 8) + 40; // -25 fps, 40 ticks a frame: a tick is a millisecond.
    const midi = parseMidi(file(header(0, 1, smpte), track(0, ...tempo(1_000_000), ...note(1000, 60, 500))));
    expect(midi.notes[0]).toMatchObject({ ticks: 48_000, endTicks: 72_000 });
    expect(midi.warnings[0]).toContain('SMPTE');
  });

  it('treats -29 as 29.97 fps, not 29', () => {
    const smpte = 0x10000 - (29 << 8) + 1;
    const midi = parseMidi(file(header(0, 1, smpte), track(...note(30_000 * 1, 60, 0))));
    expect(midi.notes[0]?.ticks).toBe(Math.round((30_000 * 1_001 / 30_000) * 48_000));
  });

  it('refuses what it cannot read, and says why', () => {
    expect(() => parseMidi(new Uint8Array(20))).toThrow(/not a MIDI file/);
    expect(() => parseMidi(file(header(2, 1, 480), track()))).toThrow(/format 2/);
    expect(() => parseMidi(file(header(0, 1, 0), track()))).toThrow(/no timing/);
    expect(() => parseMidi(file(header(0, 0, 480)))).toThrow(/no tracks/);
    expect(() => parseMidi(file(header(0, 1, 480), track(0, 60, 100)))).toThrow(MidiParseError);
    const whole = file(header(0, 1, 480), track(...note(0, 60, 480)));
    expect(() => parseMidi(whole.subarray(0, whole.length - 6))).toThrow(/cut short in track 1/);
  });

  it('sorts by time, then pitch: a chord comes out the same whatever order it was written', () => {
    const midi = parseMidi(file(header(0, 1, 480), track(0, 0x90, 67, 90, 0, 0x90, 60, 90, ...vlq(240), 0x80, 67, 0, 0, 0x80, 60, 0)));
    expect(midi.notes.map((n) => n.note)).toEqual([60, 67]);
  });
});

describe('noteName', () => {
  it('calls 60 middle C, C4, and reaches both ends', () => {
    expect(noteName(60)).toBe('C4');
    expect(noteName(0)).toBe('C-1');
    expect(noteName(127)).toBe('G9');
    expect(noteName(61)).toBe('C#4');
  });
});
