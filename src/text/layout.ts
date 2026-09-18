// Text layout without a DOM (PROJECT.md §8.13: "never rely on DOM layout; measure and lay out
// explicitly").
//
// Pure: it takes a `measure` function (the rasteriser passes the canvas's `measureText`), so the
// wrapping and positioning rules are tested in Node with a fake font. Everything a karaoke fill
// needs later — which word is where — is decided here, not guessed from pixels.
//
// Rules, stated so they can be relied on:
//  - Paragraphs split on `\n`; each is wrapped greedily at spaces to `maxWidth`.
//  - A single word wider than `maxWidth` gets a line of its own and overflows. Breaking inside
//    a word would change what the text says; overflowing only changes where it sits.
//  - Runs of spaces collapse to one between words; leading and trailing spaces are dropped. An
//    empty paragraph is kept as an empty line, so blank lines in a title survive.
//  - Line height is font-wide (ascent + descent), not per line, so lines with and without
//    descenders sit on an even rhythm.
//  - Letter spacing is added after every character, including the last on a line; alignment
//    measures lines *without* that trailing space, so centred text stays centred.

export interface LayoutFont {
  /** Advance width of a run of text at the layout size, letter spacing included. */
  measure(text: string): number;
  readonly ascent: number;
  readonly descent: number;
}

export interface LayoutOptions {
  readonly sizePx: number;
  readonly lineHeight: number;
  readonly letterSpacingPx: number;
  readonly align: 'left' | 'center' | 'right';
  readonly maxWidthPx: number;
  readonly paddingPx: number;
}

export interface LaidOutWord {
  readonly text: string;
  readonly start: number;
  readonly line: number;
  readonly x: number;
  readonly width: number;
}

export interface LaidOutLine {
  readonly text: string;
  readonly x: number;
  readonly baseline: number;
  readonly width: number;
  readonly top: number;
  readonly bottom: number;
}

export interface Layout {
  readonly lines: readonly LaidOutLine[];
  readonly words: readonly (LaidOutWord & { readonly top: number; readonly height: number })[];
  /** Bitmap size: content plus padding on every side. */
  readonly width: number;
  readonly height: number;
  readonly content: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

interface Token {
  readonly text: string;
  readonly start: number;
}

function tokens(paragraph: string, offset: number): Token[] {
  const out: Token[] = [];
  const pattern = /\S+/g;
  for (let match = pattern.exec(paragraph); match !== null; match = pattern.exec(paragraph)) {
    out.push({ text: match[0], start: offset + match.index });
  }
  return out;
}

export function layoutText(text: string, font: LayoutFont, options: LayoutOptions): Layout {
  const spacing = options.letterSpacingPx;
  // measure() includes spacing after the last character; visual width does not.
  const visual = (run: string) => (run === '' ? 0 : Math.max(0, font.measure(run) - spacing));
  const space = font.measure(' ');

  const rawLines: { text: string; words: Token[] }[] = [];
  let offset = 0;
  for (const paragraph of text.split('\n')) {
    const words = tokens(paragraph, offset);
    offset += paragraph.length + 1;
    if (words.length === 0) {
      rawLines.push({ text: '', words: [] });
      continue;
    }
    let current: Token[] = [];
    for (const word of words) {
      const candidate = [...current, word].map((w) => w.text).join(' ');
      if (current.length > 0 && visual(candidate) > options.maxWidthPx) {
        rawLines.push({ text: current.map((w) => w.text).join(' '), words: current });
        current = [word];
      } else {
        current.push(word);
      }
    }
    rawLines.push({ text: current.map((w) => w.text).join(' '), words: current });
  }

  const lineWidths = rawLines.map((line) => visual(line.text));
  const contentWidth = Math.max(0, ...lineWidths);
  const advance = options.sizePx * options.lineHeight;
  const contentHeight = rawLines.length === 0 ? 0 : (rawLines.length - 1) * advance + font.ascent + font.descent;
  const pad = options.paddingPx;

  const lines: LaidOutLine[] = [];
  const words: (LaidOutWord & { top: number; height: number })[] = [];
  rawLines.forEach((line, index) => {
    const width = lineWidths[index] ?? 0;
    const x = pad + (options.align === 'left' ? 0 : options.align === 'right' ? contentWidth - width : (contentWidth - width) / 2);
    const baseline = pad + font.ascent + index * advance;
    const top = baseline - font.ascent;
    const bottom = baseline + font.descent;
    lines.push({ text: line.text, x, baseline, width, top, bottom });
    let cursor = x;
    line.words.forEach((word, i) => {
      if (i > 0) cursor = x + font.measure(line.words.slice(0, i).map((w) => w.text).join(' ')) + space;
      words.push({ text: word.text, start: word.start, line: index, x: cursor, width: visual(word.text), top, height: bottom - top });
    });
  });

  return {
    lines,
    words,
    width: Math.ceil(contentWidth + pad * 2),
    height: Math.ceil(contentHeight + pad * 2),
    content: { x: pad, y: pad, width: contentWidth, height: contentHeight },
  };
}
