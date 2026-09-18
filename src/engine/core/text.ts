// Text as the engine sees it (PROJECT.md §8.13, M16, M32).
//
// The engine does not rasterise glyphs itself. A text layer asks a `TextRasterizer` — supplied by
// the host through `createEngine({ text })` — for coverage masks and metrics, and does everything
// visual (colour, gradient, stroke, shadow, glow, plate, animation) on the GPU from those masks.
//
// Why an interface and not code in here: glyph rasterisation needs a font engine, which in this
// app is Chromium's canvas 2D (§8.13). That is a DOM-side API, and `src/engine/` must stay free
// of the DOM (CLAUDE.md #2). The boundary also leaves room for the deferred S17 work — shaping,
// fallback chains, RTL — to replace the rasteriser without touching the module.
//
// Determinism rests on the rasteriser: the same request must give the same bytes. The browser
// implementation (src/text/canvas-rasterizer.ts) uses a software-backed canvas and fonts loaded
// from files by hash, never system font lookup by name.

/** A layout request. All lengths in output pixels; the module converts from canvas units. */
export interface TextRequest {
  readonly text: string;
  /** Content hash of a registered font, or null for the host's default font. */
  readonly fontHash: string | null;
  readonly sizePx: number;
  readonly letterSpacingPx: number;
  /** Baseline-to-baseline distance, as a multiple of `sizePx`. */
  readonly lineHeight: number;
  readonly align: 'left' | 'center' | 'right';
  /** Lines wrap at word boundaries to fit this width. A word longer than it overflows rather than breaks. */
  readonly maxWidthPx: number;
  /** Outline width; 0 for none (no stroke mask is produced). */
  readonly strokePx: number;
  /** Empty margin around the text inside the bitmap, so blur and shadow have room. */
  readonly paddingPx: number;
}

export interface TextBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A word's box in bitmap pixels (y down) — the per-word metrics karaoke needs (M32, lyrics-spec §8). */
export interface TextWord extends TextBox {
  readonly text: string;
  readonly line: number;
  /** Character offset of the word in the (case-transformed) text. */
  readonly start: number;
}

export interface TextLine {
  readonly x: number;
  readonly baseline: number;
  readonly width: number;
}

export interface TextRaster {
  /** Bitmap size, padding included. */
  readonly width: number;
  readonly height: number;
  /** A8 fill coverage, top row first. */
  readonly fill: Uint8Array;
  /** A8 outline coverage, or null when `strokePx` was 0. */
  readonly stroke: Uint8Array | null;
  /** The laid-out text without padding: what alignment and the background plate measure against. */
  readonly content: TextBox;
  readonly lines: readonly TextLine[];
  readonly words: readonly TextWord[];
  /** False when the requested font was not registered and the default was used instead. */
  readonly fontFound: boolean;
  /** True when the bitmap hit the size limit and the text was scaled down to fit. */
  readonly clamped: boolean;
}

export interface TextRasterizer {
  /**
   * False until the default font is registered. Font loading is asynchronous and the studio
   * preview starts before it finishes; a text layer then says so and draws nothing for that frame
   * rather than rasterising with whatever the system would substitute.
   */
  readonly ready: boolean;
  /** Whether a font with this content hash has been registered. */
  hasFont(hash: string): boolean;
  /** Synchronous: fonts are registered before rendering, so layout never waits. */
  rasterize(request: TextRequest): TextRaster;
}

/** What `RenderProject.assets` records for a font. */
export interface FontAssetRef {
  readonly kind: 'font';
  readonly hash: string;
  readonly name: string;
}
