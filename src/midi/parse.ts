// Standard MIDI files, formats 0 and 1, read to notes in exact time (C3).
//
// A file counts in its own ticks; what those are in time depends on the tempo at each moment. The
// times here come from the tempo map as an exact integer sum, in BigInt, and are rounded once, to a
// project tick at 1/48000 s (CLAUDE.md constraint 5). Adding up float seconds per event would drift
// by more than a sample over a song, and a binding would land differently from a seek.
//
// Pure: bytes in, notes out. Everything the file holds that is not a note or a tempo is skipped.

import { TICKS_PER_SECOND } from '../engine/core/time.ts';

export interface ParsedNote {
  /** Project ticks from the start of the file. */
  readonly ticks: number;
  readonly endTicks: number;
  /** 0..127; 60 is middle C. */
  readonly note: number;
  /** 1..127. */
  readonly velocity: number;
  /** 0..15; the file's channel 1 is 0. */
  readonly channel: number;
}

export interface ParsedMidi {
  readonly format: 0 | 1;
  readonly trackCount: number;
  /** Sorted by time, then note, then channel. */
  readonly notes: readonly ParsedNote[];
  readonly tempoChanges: number;
  /** What was odd about the file and how it was read: said to the person, never swallowed. */
  readonly warnings: readonly string[];
}

export class MidiParseError extends Error {
  override readonly name = 'MidiParseError';
}

/** Microseconds a quarter note, until the file says otherwise (the SMF default, 120 bpm). */
const DEFAULT_TEMPO = 500_000;

interface TempoChange {
  readonly tick: number;
  readonly microsPerQuarter: number;
}

interface RawNote {
  readonly start: number;
  readonly end: number;
  readonly note: number;
  readonly velocity: number;
  readonly channel: number;
}

/** A cursor over the bytes that names what ran out. */
class Reader {
  position: number;
  private readonly bytes: Uint8Array;
  private readonly end: number;
  private readonly what: string;

  constructor(bytes: Uint8Array, position: number, end: number, what: string) {
    this.bytes = bytes;
    this.position = position;
    this.end = end;
    this.what = what;
  }

  get done(): boolean {
    return this.position >= this.end;
  }

  byte(): number {
    if (this.done) throw new MidiParseError(`The MIDI file is cut short in ${this.what}.`);
    return this.bytes[this.position++] as number;
  }

  /** The next byte, not consumed: running status has to look before it knows what it read. */
  peek(): number {
    if (this.done) throw new MidiParseError(`The MIDI file is cut short in ${this.what}.`);
    return this.bytes[this.position] as number;
  }

  skip(count: number): void {
    if (this.position + count > this.end) throw new MidiParseError(`The MIDI file is cut short in ${this.what}.`);
    this.position += count;
  }

  /** A variable-length quantity: at most four bytes, by the format's own rule. */
  vlq(): number {
    let value = 0;
    for (let i = 0; i < 4; i += 1) {
      const next = this.byte();
      value = value * 128 + (next & 0x7f);
      if ((next & 0x80) === 0) return value;
    }
    throw new MidiParseError(`The MIDI file has a malformed length in ${this.what}.`);
  }
}

const u16 = (bytes: Uint8Array, at: number) => ((bytes[at] as number) << 8) | (bytes[at + 1] as number);
const u32 = (bytes: Uint8Array, at: number) => ((bytes[at] as number) * 0x1000000) + (((bytes[at + 1] as number) << 16) | ((bytes[at + 2] as number) << 8) | (bytes[at + 3] as number));
const chunkId = (bytes: Uint8Array, at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));

/** One track's notes and tempos. Unterminated notes end with the track; stray note-offs are counted. */
function readTrack(reader: Reader, tempos: TempoChange[], notes: RawNote[], tally: { unterminated: number; stray: number }): void {
  let tick = 0;
  let status = 0;
  const held = new Map<number, { start: number; velocity: number }[]>();
  const release = (channel: number, note: number) => {
    const open = held.get(channel * 128 + note);
    const first = open?.shift();
    if (first === undefined) tally.stray += 1;
    else notes.push({ start: first.start, end: tick, note, velocity: first.velocity, channel });
  };

  while (!reader.done) {
    tick += reader.vlq();
    const first = reader.peek();
    if (first === 0xff) {
      reader.byte();
      const type = reader.byte();
      const length = reader.vlq();
      if (type === 0x2f) {
        reader.skip(length);
        break;
      }
      if (type === 0x51 && length === 3) {
        const microsPerQuarter = (reader.byte() << 16) | (reader.byte() << 8) | reader.byte();
        if (microsPerQuarter > 0) tempos.push({ tick, microsPerQuarter });
      } else {
        reader.skip(length);
      }
      status = 0; // A meta event cancels running status.
      continue;
    }
    if (first === 0xf0 || first === 0xf7) {
      reader.byte();
      reader.skip(reader.vlq());
      status = 0;
      continue;
    }
    if (first >= 0x80) {
      status = reader.byte();
    } else if (status === 0) {
      throw new MidiParseError('The MIDI file has a data byte with no status before it.');
    }
    const kind = status & 0xf0;
    const channel = status & 0x0f;
    if (kind === 0xc0 || kind === 0xd0) {
      reader.byte();
    } else if (kind === 0x90 || kind === 0x80) {
      const note = reader.byte() & 0x7f;
      const velocity = reader.byte() & 0x7f;
      // A note-on at velocity 0 is the common way of writing a note-off.
      if (kind === 0x90 && velocity > 0) {
        const key = channel * 128 + note;
        const open = held.get(key) ?? [];
        open.push({ start: tick, velocity });
        held.set(key, open);
      } else {
        release(channel, note);
      }
    } else if (kind === 0xa0 || kind === 0xb0 || kind === 0xe0) {
      reader.skip(2);
    } else {
      throw new MidiParseError(`The MIDI file has an unknown event (0x${status.toString(16)}).`);
    }
  }

  for (const [key, open] of held) {
    for (const entry of open) {
      notes.push({ start: entry.start, end: tick, note: key % 128, velocity: entry.velocity, channel: Math.floor(key / 128) });
      tally.unterminated += 1;
    }
  }
}

/** Rounds num/den to the nearest whole number, exactly. */
const roundDivide = (num: bigint, den: bigint) => Number((2n * num + den) / (2n * den));

/**
 * File tick → project tick, by quarter notes and the tempo map. `elapsed` is the exact time at each
 * tempo change, as a whole number of (microseconds × division), so nothing is ever rounded twice.
 */
function quarterClock(division: number, changes: readonly TempoChange[]): (tick: number) => number {
  const sorted = [...changes].sort((a, b) => a.tick - b.tick);
  // Two tempos on one tick: the later in the list stands, by being the one that lasts.
  const map: TempoChange[] = [{ tick: 0, microsPerQuarter: DEFAULT_TEMPO }, ...sorted];
  const elapsed: bigint[] = [0n];
  for (let i = 1; i < map.length; i += 1) {
    const previous = map[i - 1] as TempoChange;
    elapsed.push((elapsed[i - 1] as bigint) + BigInt((map[i] as TempoChange).tick - previous.tick) * BigInt(previous.microsPerQuarter));
  }
  const denominator = 1_000_000n * BigInt(division);
  return (tick) => {
    let lo = 0;
    let hi = map.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((map[mid] as TempoChange).tick <= tick) lo = mid;
      else hi = mid - 1;
    }
    const at = map[lo] as TempoChange;
    const exact = (elapsed[lo] as bigint) + BigInt(tick - at.tick) * BigInt(at.microsPerQuarter);
    return roundDivide(exact * BigInt(TICKS_PER_SECOND), denominator);
  };
}

/** File tick → project tick for SMPTE time, where tempo has no say. -29 is 29.97 drop-frame. */
function smpteClock(framesPerSecond: number, ticksPerFrame: number): (tick: number) => number {
  const rate = framesPerSecond === 29 ? { num: 30_000n, den: 1_001n } : { num: BigInt(framesPerSecond), den: 1n };
  return (tick) => roundDivide(BigInt(tick) * BigInt(TICKS_PER_SECOND) * rate.den, rate.num * BigInt(ticksPerFrame));
}

export function parseMidi(bytes: Uint8Array): ParsedMidi {
  if (bytes.length < 14 || chunkId(bytes, 0) !== 'MThd') throw new MidiParseError('That is not a MIDI file: it has no MThd header.');
  const headerLength = u32(bytes, 4);
  if (headerLength < 6) throw new MidiParseError('The MIDI file\'s header is too short.');
  const format = u16(bytes, 8);
  if (format !== 0 && format !== 1) {
    throw new MidiParseError(format === 2
      ? 'This is a format 2 MIDI file: separate sequences, with no shared timeline to follow. Save it as format 0 or 1.'
      : `This MIDI file claims format ${format}, which is not a format.`);
  }
  const division = u16(bytes, 12);
  if (division === 0) throw new MidiParseError('The MIDI file\'s header gives no timing.');

  const tempos: TempoChange[] = [];
  const raw: RawNote[] = [];
  const tally = { unterminated: 0, stray: 0 };
  const warnings: string[] = [];
  let at = 8 + headerLength;
  let trackCount = 0;
  while (at + 8 <= bytes.length) {
    const length = u32(bytes, at + 4);
    if (chunkId(bytes, at) === 'MTrk') {
      trackCount += 1;
      if (at + 8 + length > bytes.length) throw new MidiParseError(`The MIDI file is cut short in track ${trackCount}.`);
      readTrack(new Reader(bytes, at + 8, at + 8 + length, `track ${trackCount}`), tempos, raw, tally);
    }
    at += 8 + length;
  }
  if (trackCount === 0) throw new MidiParseError('The MIDI file has no tracks.');
  const declared = u16(bytes, 10);
  if (declared !== trackCount) warnings.push(`The header says ${declared} tracks; ${trackCount} were read.`);
  if (tally.unterminated > 0) warnings.push(`${tally.unterminated} note${tally.unterminated === 1 ? '' : 's'} never ended, and end with their track.`);
  if (tally.stray > 0) warnings.push(`${tally.stray} note-off${tally.stray === 1 ? '' : 's'} had no note to end, and were ignored.`);

  const smpte = (division & 0x8000) !== 0;
  if (smpte && tempos.length > 0) warnings.push('This file counts in SMPTE time, so its tempo events have no effect.');
  const toTicks = smpte
    ? smpteClock(256 - (division >> 8), division & 0xff)
    : quarterClock(division, tempos);

  const notes = raw
    .map((n): ParsedNote => ({ ticks: toTicks(n.start), endTicks: toTicks(n.end), note: n.note, velocity: n.velocity, channel: n.channel }))
    .sort((a, b) => a.ticks - b.ticks || a.note - b.note || a.channel - b.channel || a.velocity - b.velocity || a.endTicks - b.endTicks);
  return { format, trackCount, notes, tempoChanges: tempos.length, warnings };
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/** "C4" for 60, the convention most DAWs show; middle C is the one worth getting right. */
export function noteName(note: number): string {
  return `${NOTE_NAMES[note % 12] as string}${Math.floor(note / 12) - 1}`;
}
