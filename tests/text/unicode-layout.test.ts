// Layout for scripts beyond Latin (S17), with the fake monospace font of layout.test.ts: every
// UTF-16 unit 10 px. And the coverage reader, against the real bundled fonts.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseCmap } from '../../src/text/cmap.ts';
import { isRtlText, layoutText, visualOrder, type LayoutFont, type LayoutOptions } from '../../src/text/layout.ts';
import { DEFAULT_FONT_FILE, FALLBACK_FONTS_DIR } from '../../setup/lib/paths.ts';

const mono: LayoutFont = { measure: (s) => s.length * 10, ascent: 8, descent: 2 };
const options = (overrides: Partial<LayoutOptions> = {}): LayoutOptions => ({
  sizePx: 10, lineHeight: 1.5, letterSpacingPx: 0, align: 'left', maxWidthPx: 1000, paddingPx: 0, ...overrides,
});

describe('Thai', () => {
  it('breaks between words, though it has no spaces', () => {
    const lines = layoutText('สวัสดีครับยินดีต้อนรับ', mono, options({ maxWidthPx: 100 })).lines.map((line) => line.text);
    expect(lines.join('')).toBe('สวัสดีครับยินดีต้อนรับ');
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]).toBe('สวัสดีครับ');
  });
});

describe('direction', () => {
  it('takes it from the first strong character', () => {
    expect(isRtlText('שלום world')).toBe(true);
    expect(isRtlText('world שלום')).toBe(false);
    expect(isRtlText('123 مرحبا')).toBe(true);
    expect(isRtlText('...')).toBe(false);
  });

  it('reverses right-to-left runs and keeps left-to-right ones reading forward', () => {
    expect(visualOrder([false, false], false)).toEqual([0, 1]);
    expect(visualOrder([true, true, true], true)).toEqual([2, 1, 0]);
    // English in a Hebrew line: the Hebrew reads from the right, the English stays in order.
    expect(visualOrder([true, false, false, true], true)).toEqual([3, 1, 2, 0]);
    // Hebrew in an English line: the line runs on, the Hebrew run is reversed inside it.
    expect(visualOrder([false, true, true, false], false)).toEqual([0, 2, 1, 3]);
  });
});

describe('right-to-left layout', () => {
  it('places the first word on the right, and keeps words in reading order', () => {
    const layout = layoutText('אב גד הו', mono, options());
    expect(layout.lines[0]?.rtl).toBe(true);
    expect(layout.words.map((w) => w.text)).toEqual(['אב', 'גד', 'הו']);
    expect(layout.words.map((w) => w.x)).toEqual([60, 30, 0]);
    expect(layout.words.every((w) => w.rtl)).toBe(true);
  });

  it('keeps an English phrase in order inside a Hebrew line', () => {
    const layout = layoutText('אב hi there גד', mono, options());
    const byText = Object.fromEntries(layout.words.map((w) => [w.text, w]));
    expect(byText['גד']?.x).toBe(0);
    expect(byText['hi']?.x).toBe(30);
    expect(byText['there']?.x).toBe(60);
    expect(byText['אב']?.x).toBe(120);
    expect(byText['hi']?.rtl).toBe(false);
  });

  it('puts a number with the letters before it, as the bidi algorithm does', () => {
    // On screen: world 123 אב. Checked against the canvas in unicode-gpu.test.ts.
    const after = layoutText('אב 123 world', mono, options());
    expect(Object.fromEntries(after.words.map((w) => [w.text, w.x]))).toEqual({ world: 0, 123: 60, אב: 100 });
    // Left-to-right base, Hebrew then a number: 123 אב.
    const inside = layoutText('hi אב 123', mono, options());
    expect(Object.fromEntries(inside.words.map((w) => [w.text, w.x]))).toEqual({ hi: 0, 123: 30, אב: 70 });
    // After a Latin word the number just follows it.
    const latin = layoutText('אב hi 123', mono, options());
    expect(Object.fromEntries(latin.words.map((w) => [w.text, w.x]))).toEqual({ hi: 0, 123: 30, אב: 70 });
  });

  it('lets punctuation on its own follow the word before it', () => {
    const layout = layoutText('אב ! גד', mono, options());
    expect(layout.words.find((w) => w.text === '!')?.rtl).toBe(true);
  });

  it('leaves plain left-to-right text exactly as before', () => {
    const layout = layoutText('hello big world', mono, options());
    expect(layout.words.map((w) => [w.x, w.rtl])).toEqual([[0, false], [60, false], [100, false]]);
  });
});

describe('Chinese and Japanese line breaks', () => {
  const texts = (text: string, maxWidthPx: number) => layoutText(text, mono, options({ maxWidthPx })).lines.map((l) => l.text);

  it('wraps between characters, with no spaces added', () => {
    expect(texts('一二三四五六', 30)).toEqual(['一二三', '四五六']);
    const layout = layoutText('一二三', mono, options());
    expect(layout.lines[0]?.text).toBe('一二三');
    expect(layout.words.map((w) => [w.text, w.x, w.start])).toEqual([['一', 0, 0], ['二', 10, 1], ['三', 20, 2]]);
  });

  it('never starts a line with closing punctuation or small kana', () => {
    expect(texts('一二三。四五', 30)).toEqual(['一二', '三。四', '五']);
    expect(texts('あいうっえ', 30)).toEqual(['あい', 'うっえ']);
  });

  it('never ends a line with opening punctuation', () => {
    expect(texts('一二「三四', 30)).toEqual(['一二', '「三四']);
  });

  it('breaks between a Latin word and Chinese, but never inside the Latin word', () => {
    expect(texts('Love愛情', 40)).toEqual(['Love', '愛情']);
  });

  it('keeps word offsets right past a character outside the BMP', () => {
    const layout = layoutText('𠮷野', mono, options());
    expect(layout.words.map((w) => w.start)).toEqual([0, 2]);
  });
});

const font = (name: string) => join(FALLBACK_FONTS_DIR, name);

describe.skipIf(!existsSync(font('NotoSansThai-Regular.ttf')))('coverage of the real fonts', () => {
  const covers = (file: string, text: string) => {
    const coverage = parseCmap(readFileSync(file));
    return [...text].map((ch) => coverage?.has(ch.codePointAt(0) as number));
  };

  it('reads format 4 and format 12 tables', () => {
    expect(covers(DEFAULT_FONT_FILE, 'Aéя□')).toEqual([true, true, true, true]);
    expect(covers(DEFAULT_FONT_FILE, 'ก語')).toEqual([false, false]);
    expect(covers(font('NotoSansThai-Regular.ttf'), 'ก')).toEqual([true]);
    expect(covers(font('NotoSansArabic-Regular.ttf'), 'م')).toEqual([true]);
    expect(covers(font('NotoSansHebrew-Regular.ttf'), 'ש')).toEqual([true]);
    expect(covers(font('NotoSansCJKjp-Regular.otf'), '語かカ한𠮷')).toEqual([true, true, true, true, true]);
    expect(covers(font('NotoEmoji[wght].ttf'), '😀🎵')).toEqual([true, true]);
  });

  it('says it cannot tell for a web font, or a file that is not a font', () => {
    expect(parseCmap(Uint8Array.from([0x77, 0x4f, 0x46, 0x46, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
    expect(parseCmap(new Uint8Array(4))).toBeNull();
    // A header that promises a table past the end of the file.
    expect(parseCmap(Uint8Array.from([0, 1, 0, 0, 0, 9, 0, 0, 0, 0, 0, 0]))).toBeNull();
  });
});
