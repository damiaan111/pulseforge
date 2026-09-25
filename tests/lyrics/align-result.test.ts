// Aligner output → lyric timings, and the sanity pass (lyrics-spec §4).

import { describe, expect, it } from 'vitest';

import { TICKS_PER_SECOND } from '../../src/engine/core/time.ts';
import { alignedLineFrom, type AlignerWord } from '../../src/lyrics/align-result.ts';

const T = (s: number) => Math.round(s * TICKS_PER_SECOND);
const w = (word: string, start: number | null, end: number | null, score: number | null = 0.9): AlignerWord => ({ word, start, end, score });
const options = { placement: { leadInTicks: 0, clipInTicks: 0 } };

describe('alignedLineFrom', () => {
  it('turns aligner words into timeline ticks with confidence', () => {
    const outcome = alignedLineFrom('l', 'hold on tonight', [w('hold', 1, 1.3, 0.8), w('on', 1.3, 1.5, 0.6), w('tonight', 1.6, 2.2, 1)], {
      placement: { leadInTicks: T(2), clipInTicks: T(1) },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // Source 1 s with a 1 s trim and a 2 s lead-in is timeline 2 s.
    expect(outcome.line.startTicks).toBe(T(2));
    expect(outcome.line.words.map((x) => x.startTicks)).toEqual([T(2), T(2.3), T(2.6)]);
    expect(outcome.line.confidence).toBeCloseTo(0.8);
  });

  it('folds a free-standing punctuation run into the word before it', () => {
    const outcome = alignedLineFrom('l', 'go — now', [w('go', 1, 1.2), w('—', null, null, null), w('now', 1.5, 1.9)], options);
    expect(outcome.ok && outcome.line.words.map((x) => [x.text, x.startTicks, x.endTicks])).toEqual([['go —', T(1), T(1.2)], ['now', T(1.5), T(1.9)]]);
  });

  it('fills words the aligner could not place by length between their neighbours', () => {
    const outcome = alignedLineFrom('l', 'at 99 degrees', [w('at', 1, 1.2), w('99', null, null, null), w('degrees', 2, 2.5)], options);
    expect(outcome.ok && outcome.line.words[1]).toMatchObject({ startTicks: T(1.2), endTicks: T(2), confidence: null });
  });

  it('rejects a line that mostly failed, came out of order, or has no length', () => {
    expect(alignedLineFrom('l', 'a b c', [w('a', 1, 1.1), w('b', null, null), w('c', null, null)], options)).toMatchObject({ ok: false, reason: expect.stringContaining('only 1 of 3') });
    expect(alignedLineFrom('l', 'a b', [w('a', 2, 2.2), w('b', 1, 1.2)], options)).toMatchObject({ ok: false, reason: 'words came out of order' });
    expect(alignedLineFrom('l', 'a b', [w('a', 1, 1), w('b', 1.2, 1.4)], options)).toMatchObject({ ok: false, reason: expect.stringContaining('no length') });
  });

  it('rejects a line landing where no singing was detected', () => {
    const words = [w('a', 10, 10.5), w('b', 10.5, 11)];
    expect(alignedLineFrom('l', 'a b', words, { ...options, vocalSegments: [{ start: 0, end: 5 }] })).toMatchObject({ ok: false, reason: expect.stringContaining('no singing') });
    expect(alignedLineFrom('l', 'a b', words, { ...options, vocalSegments: [{ start: 9, end: 12 }] }).ok).toBe(true);
  });
});
