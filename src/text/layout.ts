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
//  - Chinese and Japanese have no spaces to wrap at, so a line may break between any two of their
//    characters, except where typography forbids it (kinsoku): closing punctuation and small kana
//    never start a line, opening punctuation never ends one. Thai is not segmented: it would need
//    a dictionary, so a Thai phrase wraps at its spaces like any other.
//  - A paragraph's direction is that of its first strong character. Words are shaped and ordered by
//    the canvas (HarfBuzz and the bidi algorithm); this file only has to agree on where each word
//    lands, which it does by ordering whole words, since a space ends any shaping or joining.

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
  /** Reads right to left; a karaoke fill sweeps this way. */
  readonly rtl: boolean;
}

export interface LaidOutLine {
  readonly text: string;
  readonly x: number;
  readonly baseline: number;
  readonly width: number;
  readonly top: number;
  readonly bottom: number;
  /** The paragraph's base direction. */
  readonly rtl: boolean;
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
  /** Follows the token before it with no space: the two halves of a run of Chinese, say. */
  readonly glued: boolean;
}

const RTL_LETTER = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;
const STRONG = /[\p{L}]/u;

const BREAKABLE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
/** Never at the start of a line. */
const NO_START = /[、。，．・：；！？）］｝〕〉》」』】〙〗ーゝゞ々ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶ…‥,.!?)\]}]/u;
/** Never at the end of a line. */
const NO_END = /[（［｛〔〈《「『【〘〖]/u;

/** The base direction of a paragraph: its first strong character decides (UAX #9, P2). */
export function isRtlText(text: string): boolean {
  for (const ch of text) {
    if (RTL_LETTER.test(ch)) return true;
    if (STRONG.test(ch)) return false;
  }
  return false;
}

/** One chunk between spaces, cut at the places a line may break inside it. */
function breakChunk(chunk: string): string[] {
  if (!BREAKABLE.test(chunk)) return [chunk];
  const parts: string[] = [];
  let current = '';
  let previous = '';
  for (const ch of chunk) {
    // A combining mark (a separate dakuten, say) stays on its base character.
    const mayBreak = current !== '' && !/\p{M}/u.test(ch) && (BREAKABLE.test(ch) || BREAKABLE.test(previous))
      && !NO_START.test(ch) && !NO_END.test(previous);
    if (mayBreak) {
      parts.push(current);
      current = '';
    }
    current += ch;
    previous = ch;
  }
  parts.push(current);
  return parts;
}

function tokens(paragraph: string, offset: number): Token[] {
  const out: Token[] = [];
  const pattern = /\S+/g;
  for (let match = pattern.exec(paragraph); match !== null; match = pattern.exec(paragraph)) {
    let start = offset + match.index;
    breakChunk(match[0]).forEach((text, i) => {
      out.push({ text, start, glued: i > 0 });
      start += text.length;
    });
  }
  return out;
}

function joined(line: readonly Token[]): string {
  return line.map((t, i) => (i > 0 && !t.glued ? ` ${t.text}` : t.text)).join('');
}

/**
 * The left-to-right order the words of a line appear in. Words take a direction from their first
 * strong letter, a run of one direction keeps together, and right-to-left content is reversed:
 * whole runs on a right-to-left line, words within a run for right-to-left text.
 */
export function visualOrder(directions: readonly boolean[], baseRtl: boolean): number[] {
  const runs: { rtl: boolean; words: number[] }[] = [];
  directions.forEach((rtl, i) => {
    const last = runs[runs.length - 1];
    if (last?.rtl === rtl) last.words.push(i);
    else runs.push({ rtl, words: [i] });
  });
  const ordered = runs.map((run) => (run.rtl ? [...run.words].reverse() : run.words));
  return (baseRtl ? ordered.reverse() : ordered).flat();
}

/**
 * True for a right-to-left word, `inherit` for one with no letters. A number goes with the letter
 * before it, which is the bidi algorithm's result at word level: after right-to-left text a space
 * parts it from what follows, so "R 123 world" shows as "world 123 R", not "123 world R". The digits
 * themselves read forward whatever this says: the canvas draws them, this only places the word.
 */
function wordDirection(text: string, inherit: boolean): boolean {
  for (const ch of text) {
    if (RTL_LETTER.test(ch)) return true;
    if (STRONG.test(ch)) return false;
  }
  return inherit;
}

export function layoutText(text: string, font: LayoutFont, options: LayoutOptions): Layout {
  const spacing = options.letterSpacingPx;
  // measure() includes spacing after the last character; visual width does not.
  const visual = (run: string) => (run === '' ? 0 : Math.max(0, font.measure(run) - spacing));
  const space = font.measure(' ');

  const rawLines: { text: string; words: Token[]; rtl: boolean }[] = [];
  let offset = 0;
  for (const paragraph of text.split('\n')) {
    const words = tokens(paragraph, offset);
    offset += paragraph.length + 1;
    const rtl = isRtlText(paragraph);
    if (words.length === 0) {
      rawLines.push({ text: '', words: [], rtl });
      continue;
    }
    let current: Token[] = [];
    for (const word of words) {
      if (current.length > 0 && visual(joined([...current, word])) > options.maxWidthPx) {
        rawLines.push({ text: joined(current), words: current, rtl });
        current = [word];
      } else {
        current.push(word);
      }
    }
    rawLines.push({ text: joined(current), words: current, rtl });
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
    lines.push({ text: line.text, x, baseline, width, top, bottom, rtl: line.rtl });
    const directions: boolean[] = [];
    for (const word of line.words) directions.push(wordDirection(word.text, directions[directions.length - 1] ?? line.rtl));
    if (!line.rtl && !directions.includes(true)) {
      line.words.forEach((word, i) => {
        const before = line.words.slice(0, i);
        const cursor = i === 0 ? x : x + font.measure(joined(before)) + (word.glued ? 0 : space);
        words.push({ text: word.text, start: word.start, line: index, x: cursor, width: visual(word.text), rtl: false, top, height: bottom - top });
      });
      return;
    }
    // Any right-to-left content: positions come from the visual order, and `words` stays in
    // reading order, which is the order karaoke sings it.
    const placed = new Map<number, number>();
    let cursor = x;
    const order = visualOrder(directions, line.rtl);
    order.forEach((wordIndex, i) => {
      const word = line.words[wordIndex] as Token;
      placed.set(wordIndex, cursor);
      const next = order[i + 1];
      const nextWord = next === undefined ? undefined : line.words[next];
      // The gap between two words on screen is a space unless they are the two halves of one run.
      const glued = word.glued && next === wordIndex - 1 || nextWord?.glued === true && next === wordIndex + 1;
      cursor += visual(word.text) + (glued ? 0 : space);
    });
    line.words.forEach((word, i) => {
      words.push({ text: word.text, start: word.start, line: index, x: placed.get(i) as number, width: visual(word.text), rtl: directions[i] as boolean, top, height: bottom - top });
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
