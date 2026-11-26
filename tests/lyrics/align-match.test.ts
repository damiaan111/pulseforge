// Matching lyric lines to a transcript (lyrics-spec §4): windows from word alignment, gaps filled,
// strays ignored; and a transcript cut into lines.

import { describe, expect, it } from 'vitest';

import {
  alignWordSequences, linesFromTranscript, matchLyricsToTranscript, sungWord, wordSimilarity,
  type TranscriptSegment, type TranscriptWord,
} from '../../src/lyrics/align-match.ts';

/** A transcript from "word@start" tokens, each word lasting 0.3 s. */
function transcript(spec: string): TranscriptSegment[] {
  const words: TranscriptWord[] = spec.split(/\s+/).filter((t) => t !== '').map((token) => {
    const [text, at] = token.split('@');
    return { text: text as string, start: Number(at), end: Number(at) + 0.3 };
  });
  return [{ start: words[0]?.start ?? 0, end: words[words.length - 1]?.end ?? 0, text: words.map((w) => w.text).join(' '), words }];
}

describe('word similarity and sequence alignment', () => {
  it('compares words as sung, forgiving small mishearings', () => {
    expect(sungWord("Don't!")).toBe('dont');
    expect(wordSimilarity('flicker', 'flickered')).toBeGreaterThan(0.6);
    expect(wordSimilarity('neon', 'the')).toBeLessThan(0.6);
  });

  it('keeps the order of the song and skips what the other side lacks', () => {
    const pairs = alignWordSequences(['hold', 'on', 'hold', 'on', 'tonight'], ['hold', 'on', 'yeah', 'tonight']);
    expect(pairs).toEqual([[0, 0], [1, 1], [4, 3]]);
  });
});

describe('matchLyricsToTranscript', () => {
  const lines = [
    { id: 'a', text: 'Neon lights are calling' },
    { id: 'b', text: 'Hold on tonight' },
    { id: 'c', text: 'We are the pulse' },
  ];

  it('windows each line from the transcript words it matched, padded', () => {
    const { windows, unplaced } = matchLyricsToTranscript(lines, transcript('neon@10 lights@10.4 are@10.8 kolling@11.1 hold@14 on@14.4 tonight@14.8 we@20 are@20.3 the@20.6 pulse@21'), { duration: 60, pad: 0.2 });
    expect(unplaced).toEqual([]);
    expect(windows.map((w) => [w.lineId, w.start, Number(w.end.toFixed(2)), w.how])).toEqual([
      ['a', 9.8, 11.6, 'matched'], ['b', 13.8, 15.3, 'matched'], ['c', 19.8, 21.5, 'matched'],
    ]);
  });

  it('places a line Whisper skipped in the gap between its neighbours', () => {
    const { windows } = matchLyricsToTranscript(lines, transcript('neon@10 lights@10.4 are@10.8 calling@11.1 we@20 are@20.3 the@20.6 pulse@21'), { duration: 60, pad: 0 });
    expect(windows[1]).toMatchObject({ lineId: 'b', how: 'interpolated' });
    expect(windows[1]!.start).toBeCloseTo(11.4);
    expect(windows[1]!.end).toBeCloseTo(20);
  });

  it('reports a line there is no room for rather than inventing a place', () => {
    const { unplaced } = matchLyricsToTranscript(lines, transcript('neon@10 lights@10.4 are@10.8 calling@11.1 we@11.5 are@11.6 the@11.7 pulse@11.8'), { duration: 60, pad: 0 });
    expect(unplaced).toEqual(['b']);
  });

  it('ignores a stray match far from the rest of the line', () => {
    const { windows } = matchLyricsToTranscript([{ id: 'x', text: 'the night is young' }], transcript('the@2 night@40 is@40.3 young@40.6'), { duration: 60, pad: 0 });
    expect(windows[0]?.start).toBe(40);
  });
});

describe('linesFromTranscript', () => {
  it('cuts a long segment where the singer breathes and where it grows too long', () => {
    const lines = linesFromTranscript(transcript('one@1 two@1.3 three@1.6 four@3 five@3.3'))
      .map((l) => ({ ...l, end: Number(l.end.toFixed(3)) }));
    expect(lines).toEqual([
      { text: 'one two three', start: 1, end: 1.9 },
      { text: 'four five', start: 3, end: 3.6 },
    ]);
    const long = linesFromTranscript(transcript('I@0 wanted@0.3 more,@0.6 but@0.9 all@1.2 I@1.5 ever@1.8 got@2.1 was@2.4 the@2.7 rain@3'), 32);
    expect(long.map((l) => l.text)).toEqual(['I wanted more,', 'but all I ever got was the rain']);
    expect(long[1]?.start).toBe(0.9);
  });

  it('joins a lone first word stranded seconds ahead of its phrase, and keeps a real one', () => {
    const stranded = linesFromTranscript(transcript('You@3 say@12 you@12.3 won\'t@12.6 come@12.9'));
    expect(stranded.map((l) => l.text)).toEqual(['You say you won\'t come']);
    expect(stranded[0]?.start).toBe(12);
    const shout = linesFromTranscript(transcript('Hey@3 say@5 you@5.3 will@5.6'));
    expect(shout.map((l) => l.text)).toEqual(['Hey', 'say you will']);
  });
});
