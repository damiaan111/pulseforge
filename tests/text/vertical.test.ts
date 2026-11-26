// Vertical layout rules (src/text/vertical.ts), with a fake font: every character 10 px wide, ascent
// 8, descent 2, so a 10 px cell holds the font's box exactly.

import { describe, expect, it } from 'vitest';

import { layoutVertical, type VerticalOptions } from '../../src/text/vertical.ts';

const FONT = { measure: (text: string) => [...text].length * 10, ascent: 8, descent: 2 };
const OPTIONS: VerticalOptions = { sizePx: 10, lineHeight: 1.5, letterSpacingPx: 0, align: 'left', maxHeightPx: 1000, paddingPx: 4 };
const layout = (text: string, options: Partial<VerticalOptions> = {}) => layoutVertical(text, FONT, { ...OPTIONS, ...options });

describe('layoutVertical', () => {
  it('stacks characters down one column', () => {
    const v = layout('ABC');
    expect(v.glyphs.map((g) => [g.text, g.x, g.baseline])).toEqual([['A', 4, 12], ['B', 4, 22], ['C', 4, 32]]);
    expect(v.content).toEqual({ x: 4, y: 4, width: 10, height: 30 });
    expect([v.width, v.height]).toEqual([18, 38]);
  });

  it('reads columns from the right', () => {
    const v = layout('AB\nCD');
    expect(v.glyphs.find((g) => g.text === 'A')?.x).toBe(19);
    expect(v.glyphs.find((g) => g.text === 'C')?.x).toBe(4);
    expect(v.content.width).toBe(25);
  });

  it('keeps Latin words whole and wraps between them', () => {
    const v = layout('AB CD', { maxHeightPx: 30 });
    expect(v.words.map((w) => [w.text, w.line])).toEqual([['AB', 0], ['CD', 1]]);
    const long = layout('ABCDEF', { maxHeightPx: 30 });
    expect(long.words).toHaveLength(1);
    expect(long.content.height).toBe(60);
  });

  it('wraps between Chinese or Japanese characters, but not before closing punctuation', () => {
    const v = layout('日本語。', { maxHeightPx: 30 });
    expect(v.words.map((w) => [w.text, w.line])).toEqual([['日', 0], ['本', 0], ['語。', 1]]);
    expect(layout('日本語', { maxHeightPx: 20 }).lines).toHaveLength(2);
    expect(layout('日本', { maxHeightPx: 10 }).lines).toHaveLength(2);
    expect(layout('日。', { maxHeightPx: 10 }).lines).toHaveLength(1);
  });

  it('keeps offsets into the text, across paragraphs and spaces', () => {
    const text = 'AB CD\n日本';
    const v = layout(text);
    expect(v.words.map((w) => text.slice(w.start, w.start + w.text.length))).toEqual(['AB', 'CD', '日', '本']);
  });

  it('a space is half a cell, and letter spacing goes between cells only', () => {
    expect(layout('A B').content.height).toBe(25);
    expect(layout('AB', { letterSpacingPx: 3 }).content.height).toBe(23);
  });

  it('aligns along the column', () => {
    const top = layout('ABC\nD', { align: 'left' }).glyphs.at(-1)?.baseline;
    const middle = layout('ABC\nD', { align: 'center' }).glyphs.at(-1)?.baseline;
    const bottom = layout('ABC\nD', { align: 'right' }).glyphs.at(-1)?.baseline;
    expect([top, middle, bottom]).toEqual([12, 22, 32]);
  });

  it('turns what follows the column, and moves the small stops to the corner', () => {
    const v = layout('「ー日。');
    expect(v.glyphs.map((g) => g.rotated)).toEqual([true, true, false, false]);
    const stop = v.glyphs[3]!;
    expect(stop.x).toBeGreaterThan(v.glyphs[2]!.x);
    expect(stop.baseline).toBeLessThan(v.glyphs[2]!.baseline + 10);
  });

  it('keeps a grapheme together, and gives an invisible character no cell', () => {
    expect(layout('éA').glyphs.map((g) => g.text)).toEqual(['é', 'A']);
    expect(layout('👩‍🎤').glyphs).toHaveLength(1);
    expect(layout('A​B').glyphs.map((g) => g.text)).toEqual(['A', 'B']);
  });

  it('keeps a blank paragraph as an empty column', () => {
    expect(layout('A\n\nB').lines).toHaveLength(3);
  });
});
