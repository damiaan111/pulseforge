// Vertical layout for titles: characters top to bottom, columns right to left, as written in
// Japanese and Chinese. layout.ts is horizontal only, and the canvas has no vertical mode, so this
// places every character itself and the rasteriser draws them one at a time.
//
// Pure, like layout.ts, and tested the same way. The rules:
//  - Paragraphs split on `\n`, and each starts a new column. A column wraps at `maxHeightPx`, between
//    words, or between any two Chinese, Japanese or Korean characters; a word longer than a column
//    overflows, as it does across a line.
//  - Every character gets a square cell one em tall and stands upright in it, Latin too: there is no
//    sideways setting. Letter spacing goes between cells, a space is half a cell.
//  - Brackets, dashes and the long-vowel mark follow the column, so they are turned a quarter clockwise.
//    The small comma and full stop move to the cell's upper right, where vertical text sets them.
//  - `align` runs along the column: left is the top, right the bottom.
//  - Characters are drawn apart, so nothing joins or reorders across them: Arabic letters stay in
//    their isolated forms. A character is a whole grapheme, so an emoji sequence or a base with its
//    combining marks stays one.

import type { LayoutFont } from './layout.ts';

export interface VerticalOptions {
  readonly sizePx: number;
  /** Distance between columns, as a multiple of `sizePx`. */
  readonly lineHeight: number;
  readonly letterSpacingPx: number;
  readonly align: 'left' | 'center' | 'right';
  readonly maxHeightPx: number;
  readonly paddingPx: number;
}

export interface VerticalGlyph {
  readonly text: string;
  /** The canvas position to draw at, unless `rotated`. */
  readonly x: number;
  readonly baseline: number;
  /** The cell's centre: a rotated glyph turns about it. */
  readonly cx: number;
  readonly cy: number;
  readonly width: number;
  readonly rotated: boolean;
}

export interface VerticalLayout {
  readonly glyphs: readonly VerticalGlyph[];
  readonly lines: readonly { readonly x: number; readonly baseline: number; readonly width: number }[];
  readonly words: readonly { readonly text: string; readonly start: number; readonly line: number; readonly x: number; readonly top: number; readonly width: number; readonly height: number }[];
  readonly width: number;
  readonly height: number;
  readonly content: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

const SPACE_EM = 0.5;
const BREAKABLE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const NO_COLUMN_START = /^[、。，．・：；！？）］｝〕〉》」』】ーゝゞ々ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮ…‥]/u;
const FOLLOWS_COLUMN = /^[ー〜～…‥—–―（）［］｛｝〔〕〈〉《》「」『』【】〖〗(){}[\]<>_=-]/u;
const CORNER = /^[、。，．]/u;
const INVISIBLE = /^[\p{Cf}\p{Cc}]+$/u;

const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });

/** One run that stays together in a column: a word, or a single CJK character. */
interface Chunk {
  readonly text: string;
  readonly start: number;
  readonly cells: readonly string[];
  /** Follows the chunk before it with no space. */
  readonly glued: boolean;
}

function chunks(paragraph: string, offset: number): Chunk[] {
  const out: Chunk[] = [];
  const pattern = /\S+/g;
  for (let match = pattern.exec(paragraph); match !== null; match = pattern.exec(paragraph)) {
    let glued = false;
    let cells: string[] = [];
    let text = '';
    let start = offset + match.index;
    let at = start;
    const flush = () => {
      if (cells.length > 0) {
        out.push({ text, start, cells, glued });
        glued = true;
      }
      cells = [];
      text = '';
      start = at;
    };
    for (const { segment } of segmenter.segment(match[0])) {
      const previous = cells[cells.length - 1];
      const mayBreak = previous !== undefined && (BREAKABLE.test(segment) || BREAKABLE.test(previous)) && !NO_COLUMN_START.test(segment);
      if (mayBreak) flush();
      text += segment;
      at += segment.length;
      if (!INVISIBLE.test(segment)) cells.push(segment);
    }
    flush();
  }
  return out;
}

export function layoutVertical(source: string, font: LayoutFont, options: VerticalOptions): VerticalLayout {
  const { sizePx, letterSpacingPx, paddingPx: pad } = options;
  const cell = sizePx + letterSpacingPx;
  const gap = sizePx * SPACE_EM;
  const span = (chunk: Chunk) => chunk.cells.length * cell - letterSpacingPx;

  interface Column { chunks: Chunk[]; length: number }
  const columns: Column[] = [];
  let offset = 0;
  for (const paragraph of source.split('\n')) {
    let column: Column = { chunks: [], length: 0 };
    columns.push(column);
    for (const chunk of chunks(paragraph, offset)) {
      const before = column.chunks.length === 0 ? 0 : chunk.glued ? letterSpacingPx : gap;
      if (column.chunks.length > 0 && column.length + before + span(chunk) > options.maxHeightPx) {
        column = { chunks: [], length: 0 };
        columns.push(column);
        column.chunks.push(chunk);
        column.length = span(chunk);
      } else {
        column.chunks.push(chunk);
        column.length += before + span(chunk);
      }
    }
    offset += paragraph.length + 1;
  }

  const across = sizePx * options.lineHeight;
  const contentWidth = (columns.length - 1) * across + sizePx;
  const contentHeight = Math.max(sizePx, ...columns.map((c) => c.length));
  // Sits the font's own box in the middle of the square cell.
  const baselineInCell = (sizePx + font.ascent - font.descent) / 2;

  const glyphs: VerticalGlyph[] = [];
  const lines: { x: number; baseline: number; width: number }[] = [];
  const words: { text: string; start: number; line: number; x: number; top: number; width: number; height: number }[] = [];
  columns.forEach((column, index) => {
    const cx = pad + contentWidth - sizePx / 2 - index * across;
    const slack = contentHeight - column.length;
    let y = pad + (options.align === 'left' ? 0 : options.align === 'right' ? slack : slack / 2);
    lines.push({ x: cx - sizePx / 2, baseline: y + baselineInCell, width: column.length });
    column.chunks.forEach((chunk, i) => {
      if (i > 0) y += chunk.glued ? letterSpacingPx : gap;
      const top = y;
      for (const text of chunk.cells) {
        const width = font.measure(text);
        const corner = CORNER.test(text) ? sizePx * 0.6 : 0;
        glyphs.push({
          text, x: cx - width / 2 + corner, baseline: y + baselineInCell - corner, cx, cy: y + sizePx / 2, width, rotated: FOLLOWS_COLUMN.test(text),
        });
        y += cell;
      }
      y -= letterSpacingPx;
      words.push({ text: chunk.text, start: chunk.start, line: index, x: cx - sizePx / 2, top, width: sizePx, height: y - top });
    });
  });

  return {
    glyphs,
    lines,
    words,
    width: Math.ceil(contentWidth + pad * 2),
    height: Math.ceil(contentHeight + pad * 2),
    content: { x: pad, y: pad, width: contentWidth, height: contentHeight },
  };
}
