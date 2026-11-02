// Text layout rules (src/text/layout.ts), with a monospace fake font: every character 10 px,
// ascent 8, descent 2, letter spacing added per character.

import { describe, expect, it } from 'vitest';

import { layoutText, type LayoutFont, type LayoutOptions } from '../../src/text/layout.ts';

const mono = (spacing = 0): LayoutFont => ({ measure: (s) => s.length * (10 + spacing), ascent: 8, descent: 2 });
const options = (overrides: Partial<LayoutOptions> = {}): LayoutOptions => ({
  sizePx: 10, lineHeight: 1.5, letterSpacingPx: 0, align: 'left', maxWidthPx: 1000, paddingPx: 0, ...overrides,
});

describe('layoutText', () => {
  it('lays out one line with word boxes and character offsets', () => {
    const layout = layoutText('hello big world', mono(), options());
    expect(layout.lines.map((l) => l.text)).toEqual(['hello big world']);
    expect(layout.words.map((w) => [w.text, w.start, w.x, w.width])).toEqual([
      ['hello', 0, 0, 50], ['big', 6, 60, 30], ['world', 10, 100, 50],
    ]);
    expect(layout.content).toEqual({ x: 0, y: 0, width: 150, height: 10 });
  });

  it('wraps greedily at spaces and lets a too-long word overflow on its own line', () => {
    const layout = layoutText('aa bb cc extraordinarily dd', mono(), options({ maxWidthPx: 50 }));
    expect(layout.lines.map((l) => l.text)).toEqual(['aa bb', 'cc', 'extraordinarily', 'dd']);
    expect(layout.content.width).toBe(150);
  });

  it('keeps blank lines and collapses spaces', () => {
    const layout = layoutText('  one   two \n\nthree', mono(), options());
    expect(layout.lines.map((l) => l.text)).toEqual(['one two', '', 'three']);
    expect(layout.words.map((w) => [w.text, w.line, w.start])).toEqual([['one', 0, 2], ['two', 0, 8], ['three', 2, 14]]);
    // Even rhythm: 3 lines, 15 px apart, plus ascent and descent.
    expect(layout.lines.map((l) => l.baseline)).toEqual([8, 23, 38]);
    expect(layout.content.height).toBe(40);
  });

  it('aligns lines against the widest, ignoring trailing letter spacing', () => {
    const layout = layoutText('abcd\nab', mono(2), options({ align: 'center', letterSpacingPx: 2 }));
    // "abcd" visual = 4×12 − 2 = 46; "ab" = 22; centred offset (46 − 22) / 2 = 12.
    expect(layout.lines.map((l) => [l.x, l.width])).toEqual([[0, 46], [12, 22]]);
    const right = layoutText('abcd\nab', mono(2), options({ align: 'right', letterSpacingPx: 2 }));
    expect(right.lines[1]!.x).toBe(24);
  });

  it('adds padding around the content', () => {
    const layout = layoutText('ab', mono(), options({ paddingPx: 7 }));
    expect([layout.width, layout.height]).toEqual([34, 24]);
    expect(layout.words[0]).toMatchObject({ x: 7, top: 7, height: 10 });
  });
});
