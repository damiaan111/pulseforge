// Singing a transcription left without words: found, so the person is told where to look.

import { describe, expect, it } from 'vitest';

import { uncoveredSinging } from '../../src/lyrics/vocal-segments.ts';

describe('uncoveredSinging', () => {
  it('finds a stretch of singing before, between and after the lines', () => {
    const singing = [{ start: 2, end: 30 }];
    const lines = [{ start: 10, end: 12 }, { start: 20, end: 22 }];
    expect(uncoveredSinging(singing, lines)).toEqual([
      { start: 2, end: 9.7 },
      { start: 12.3, end: 19.7 },
      { start: 22.3, end: 30 },
    ]);
  });

  it('lets a held note run past the end of its line, and ignores a breath', () => {
    expect(uncoveredSinging([{ start: 10, end: 12.2 }, { start: 15, end: 15.5 }], [{ start: 10, end: 12 }])).toEqual([]);
  });

  it('reports every segment when there are no lines at all', () => {
    expect(uncoveredSinging([{ start: 1, end: 3 }, { start: 5, end: 8 }], [])).toEqual([{ start: 1, end: 3 }, { start: 5, end: 8 }]);
  });
});
