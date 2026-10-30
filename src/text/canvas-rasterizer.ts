// The browser TextRasterizer (engine/core/text.ts): Chromium's canvas 2D, fonts loaded from files.
//
// Used everywhere a frame is rendered — the studio preview, the export renderer, the frames
// harness — so preview and export rasterise with the same code, the same fonts and the same
// Chromium build.
//
// Determinism choices, each deliberate:
//  - **Fonts come from bytes, keyed by content hash**, registered as `FontFace`s under an internal
//    family name. Nothing is ever looked up by family name on the system, so an installed font with
//    the same name but a different version cannot change the output (PROJECT.md §8.13).
//  - **`willReadFrequently: true`** keeps the canvas CPU-backed. A GPU-accelerated 2D canvas can
//    rasterise differently between runs and drivers; the masks are read back anyway.
//  - **`textRendering: geometricPrecision`**, so glyph shapes scale with the size rather than
//    snapping to hinted pixel grids that differ between preview and export resolution.
//  - Layout is ours (layout.ts), never the DOM's.
//  - **Fallback is a chain of bundled fonts** after the layer's own and the default, so a Japanese
//    lyric or an emoji reads the same on any machine. A character none of them has is replaced
//    with a box *before* the canvas sees it: left alone, the canvas would find it in a system font,
//    which is the one thing the first rule exists to prevent. Shaping (Arabic joining, Indic
//    reordering) and bidirectional ordering are the canvas's own, through HarfBuzz.
//  - Emoji are **monochrome** (Noto Emoji): every text effect works on a coverage mask, and a colour
//    bitmap has none. An emoji takes the layer's colour, gradient and karaoke fill like a letter.

import type { TextRaster, TextRasterizer, TextRequest } from '../engine/core/text.ts';
import { parseCmap, type FontCoverage } from './cmap.ts';
import { layoutText } from './layout.ts';

/** Largest bitmap side. Past it the block is scaled down, and the raster says so. */
const MAX_SIDE = 8192;
/** Drawn for a character no font has. */
const NO_GLYPH = 0x25a1;
const MAX_REPORTED = 8;
/** Never drawn, so never looked up: joiners, variation selectors, and spaces of every width. */
const INVISIBLE = /[\s\p{Cf}\p{Cc}\p{Variation_Selector}]/u;

interface FontRegistry {
  add(face: FontFace): void;
}

function fontRegistry(): FontRegistry {
  const scope = globalThis as unknown as { document?: { fonts: FontRegistry }; fonts?: FontRegistry };
  const registry = scope.document?.fonts ?? scope.fonts;
  if (registry === undefined) throw new Error('No FontFaceSet in this context; text needs a window or worker with font support');
  return registry;
}

type Context2D = OffscreenCanvasRenderingContext2D & { letterSpacing: string; textRendering: string; fontKerning: string };

function context(canvas: OffscreenCanvas): Context2D {
  const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: true });
  if (ctx === null) throw new Error('canvas 2D is not available for text rendering');
  return ctx as Context2D;
}

export class CanvasTextRasterizer implements TextRasterizer {
  private readonly families = new Map<string, string>();
  /** By family. Null: a web font whose coverage cannot be read, so it is taken at its word. */
  private readonly coverage = new Map<string, FontCoverage | null>();
  private readonly fallbacks: string[] = [];
  private defaultFamily: string | undefined;
  private readonly measureCanvas = new OffscreenCanvas(1, 1);
  private readonly drawCanvas = new OffscreenCanvas(1, 1);

  /** Registers a font file's bytes under its content hash. Idempotent per hash. */
  async addFont(hash: string, bytes: Uint8Array): Promise<void> {
    if (this.families.has(hash)) return;
    const family = `pf-${hash.slice(0, 24)}`;
    // A copy: FontFace takes ownership of an ArrayBuffer, and a view into a shared one is not accepted.
    // Not `bytes.slice()`, which on a Node Buffer is a view of its pool, so a small font comes out
    // as the whole pool.
    const buffer = new Uint8Array(bytes).buffer;
    const face = new FontFace(family, buffer);
    await face.load();
    fontRegistry().add(face);
    this.families.set(hash, family);
    this.coverage.set(family, parseCmap(bytes));
  }

  /** Adds a font to the end of the fallback chain, tried after the layer's own and the default. */
  async addFallbackFont(hash: string, bytes: Uint8Array): Promise<void> {
    await this.addFont(hash, bytes);
    const family = this.families.get(hash) as string;
    if (!this.fallbacks.includes(family)) this.fallbacks.push(family);
  }

  /** The font used when a layer names none, or when the one it names is missing. */
  async setDefaultFont(hash: string, bytes: Uint8Array): Promise<void> {
    await this.addFont(hash, bytes);
    this.defaultFamily = this.families.get(hash);
  }

  get ready(): boolean {
    return this.defaultFamily !== undefined;
  }

  hasFont(hash: string): boolean {
    return this.families.has(hash);
  }

  rasterize(request: TextRequest): TextRaster {
    const named = request.fontHash === null ? undefined : this.families.get(request.fontHash);
    const family = named ?? this.defaultFamily;
    if (family === undefined) throw new Error('no default font registered with the text rasteriser');
    const fontFound = request.fontHash === null || named !== undefined;

    const stack = [...new Set([family, this.defaultFamily as string, ...this.fallbacks])];
    const { text, missing } = this.covered(request.text, stack);
    const drawn = text === request.text ? request : { ...request, text };
    const fonts = stack.map((name) => `"${name}"`).join(', ');

    let raster = this.render(drawn, fonts, 1);
    if (raster.width > MAX_SIDE || raster.height > MAX_SIDE) {
      const scale = MAX_SIDE / Math.max(raster.width, raster.height);
      raster = this.render(drawn, fonts, scale * 0.999);
      return { ...raster, fontFound, clamped: true, missingGlyphs: missing };
    }
    return { ...raster, fontFound, clamped: false, missingGlyphs: missing };
  }

  /**
   * The text with every character no font in the stack has replaced by a box. Same length, code
   * unit for code unit, because word offsets into the text must still hold: a character outside the
   * BMP becomes the box and a zero-width space.
   */
  private covered(text: string, stack: readonly string[]): { text: string; missing: readonly string[] } {
    const fonts = stack.map((family) => this.coverage.get(family));
    // An unreadable font might have anything, and it is the user's own choice: nothing is replaced.
    if (fonts.some((font) => font === null || font === undefined)) return { text, missing: [] };
    const known = fonts as readonly FontCoverage[];
    const box = String.fromCodePoint(known.some((font) => font.has(NO_GLYPH)) ? NO_GLYPH : 0x3f);
    const missing: string[] = [];
    let out = '';
    let changed = false;
    for (const ch of text) {
      const code = ch.codePointAt(0) as number;
      if (INVISIBLE.test(ch) || known.some((font) => font.has(code))) {
        out += ch;
        continue;
      }
      changed = true;
      out += ch.length === 1 ? box : `${box}\u200b`;
      if (missing.length < MAX_REPORTED && !missing.includes(ch)) missing.push(ch);
    }
    return { text: changed ? out : text, missing };
  }

  private setup(ctx: Context2D, fonts: string, sizePx: number, letterSpacingPx: number): void {
    ctx.font = `${sizePx}px ${fonts}`;
    ctx.letterSpacing = `${letterSpacingPx}px`;
    ctx.fontKerning = 'normal';
    ctx.textRendering = 'geometricPrecision';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  private render(request: TextRequest, fonts: string, scale: number): Omit<TextRaster, 'fontFound' | 'clamped'> {
    const sizePx = request.sizePx * scale;
    const letterSpacingPx = request.letterSpacingPx * scale;
    const strokePx = request.strokePx * scale;
    const measure = context(this.measureCanvas);
    this.setup(measure, fonts, sizePx, letterSpacingPx);
    const metrics = measure.measureText('Hg');

    const layout = layoutText(request.text, {
      measure: (text) => measure.measureText(text).width,
      ascent: metrics.fontBoundingBoxAscent,
      descent: metrics.fontBoundingBoxDescent,
    }, {
      sizePx,
      lineHeight: request.lineHeight,
      letterSpacingPx,
      align: request.align,
      maxWidthPx: request.maxWidthPx * scale,
      paddingPx: request.paddingPx * scale,
    });

    const width = Math.max(1, Math.min(MAX_SIDE * 2, layout.width));
    const height = Math.max(1, Math.min(MAX_SIDE * 2, layout.height));
    const base = {
      width,
      height,
      content: layout.content,
      lines: layout.lines.map((l) => ({ x: l.x, baseline: l.baseline, width: l.width, ...(l.rtl ? { rtl: true } : {}) })),
      words: layout.words.map((w) => ({ text: w.text, start: w.start, line: w.line, x: w.x, y: w.top, width: w.width, height: w.height, ...(w.rtl ? { rtl: true } : {}) })),
    };
    if (width > MAX_SIDE || height > MAX_SIDE) return { ...base, fill: new Uint8Array(0), stroke: null };

    this.drawCanvas.width = width;
    this.drawCanvas.height = height;
    const draw = context(this.drawCanvas);
    const alpha = (): Uint8Array => {
      const rgba = draw.getImageData(0, 0, width, height).data;
      const out = new Uint8Array(width * height);
      for (let i = 0; i < out.length; i += 1) out[i] = rgba[i * 4 + 3] ?? 0;
      return out;
    };

    draw.clearRect(0, 0, width, height);
    this.setup(draw, fonts, sizePx, letterSpacingPx);
    draw.fillStyle = '#ffffff';
    for (const line of layout.lines) {
      if (line.text === '') continue;
      draw.direction = line.rtl ? 'rtl' : 'ltr';
      draw.fillText(line.text, line.x, line.baseline);
    }
    const fill = alpha();

    let stroke: Uint8Array | null = null;
    if (strokePx > 0) {
      draw.clearRect(0, 0, width, height);
      this.setup(draw, fonts, sizePx, letterSpacingPx);
      draw.strokeStyle = '#ffffff';
      draw.lineJoin = 'round';
      draw.miterLimit = 2;
      // A canvas stroke is centred on the outline; twice the width puts `strokePx` outside the glyph.
      draw.lineWidth = strokePx * 2;
      for (const line of layout.lines) {
        if (line.text === '') continue;
        draw.direction = line.rtl ? 'rtl' : 'ltr';
        draw.strokeText(line.text, line.x, line.baseline);
      }
      stroke = alpha();
    }

    return { ...base, fill, stroke };
  }
}
