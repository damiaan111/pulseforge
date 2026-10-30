// core.text.lyrics — the project's lyrics on screen, with karaoke fill (M20; lyrics-spec §6–§7).
//
// What it draws comes from the project (`ctx.lyrics`: timed lines in timeline ticks); how it draws
// them is this layer's schema — every colour, size, window and fill mode is a parameter, so all of
// it is modulatable, per-aspect overridable and saved in presets (lyrics-spec §7, §13).
//
// **One raster per line, one mask per frame.** Each line is rasterised once per (text, style,
// resolution) and cached (§11): the karaoke fill is computed in the shader from a small per-word
// table — box, progress, pop — uploaded each frame, never by re-rasterising. The word-id map from
// the text layer tells each pixel which word it belongs to; rasterised words map onto lyric tokens
// by character offset, so a free-standing "—" fills with the word it follows.
//
// **The window (§6.3).** Lead lines (and instrumental notes) form the sequence: the current line
// sits at the layer's anchor and up to `lines − 1` upcoming lines stack below it at
// `nextOpacity`. When one line hands over to the next (the first leaves as the second appears —
// `lineWindows`), the advance mode animates it: `scroll` slides the stack up, `crossfade` blends
// the old and new windows, `cut` switches. When a line comes on out of an empty screen, or leaves
// into one, the entry and exit animations play instead — the same ones the text layer has.
//
// **Roles (D35).** With `roles: all`, backing and ad-lib lines are satellites: drawn beside the
// current line at their own offset, scale and opacity, and never pushed into the sequence where they
// would shove the lead line away. A layer set to one role shows only that role, as its own
// sequence — so backing vocals can have a layer of their own, styled independently.
//
// Everything is a closed-form function of `t` (CLAUDE.md #1): the window, the fill, the pop and the
// ball are recomputed from the frame time, never accumulated.

import { lineWindows, currentLineIndex, lyricTokens, wordProgress, wordSpans, type LineWindow, type RenderLyricLine, type RenderLyrics, type WordSpan } from '../core/lyrics.ts';
import type { ModuleDefinition, ModuleInstance, ModuleManifest, RenderContext } from '../core/module.ts';
import { num, str, type ParamValues } from '../core/params.ts';
import type { TextRaster, TextRequest } from '../core/text.ts';
import { FULLSCREEN_VERT, createProgram, drawFullscreenTriangle, uniformLocation } from '../render/gl.ts';
import {
  MAX_WORDS, TEXT_SAMPLING_GLSL, bindTexture, clamp01, createWordMaskPass, linearHex, releaseTextRaster,
  unbindTextures, uploadTextRaster, type UploadedText,
} from './text-gpu.ts';
import { TEXT_ANIMATIONS, textAnimation, type AnimationState } from './text.ts';

export const KARAOKE_FILLS = [
  { value: 'wipe', label: 'Wipe' },
  { value: 'wordSwap', label: 'Word swap' },
  { value: 'wordPop', label: 'Word pop' },
  { value: 'fillStroke', label: 'Fill the outline' },
  { value: 'gradientSweep', label: 'Gradient sweep' },
  { value: 'bouncingBall', label: 'Bouncing ball' },
  { value: 'none', label: 'None (line-timed only)' },
] as const;

const FILL_CODE: Readonly<Record<string, number>> = { none: 0, wipe: 1, wordSwap: 2, wordPop: 3, fillStroke: 4, gradientSweep: 5, bouncingBall: 6 };

export const lyricsManifest: ModuleManifest = {
  id: 'core.text.lyrics',
  version: '0.1.0',
  kind: 'text',
  name: 'Lyrics',
  description: 'The project’s lyrics, timed to the music: karaoke fill, next-line preview, scroll or crossfade between lines, roles for backing vocals and ad-libs',
  category: 'text',
  tags: ['lyrics', 'karaoke', 'text', 'typography'],
  capabilities: { needsAnalysis: false, needsInput: false, supportsAspect: true, stateful: false, gpuCost: 'low', expandsBounds: true },
  paramsSchemaVersion: 1,
  params: [
    { key: 'font', label: 'Font', group: 'Text', type: 'asset', accept: 'font', default: '', description: 'Empty uses the bundled Inter' },
    {
      key: 'case', label: 'Case', group: 'Text', type: 'enum', default: 'none',
      options: [{ value: 'none', label: 'As typed' }, { value: 'upper', label: 'UPPERCASE' }, { value: 'lower', label: 'lowercase' }],
    },
    // Not modulatable: size re-rasterises. Pulse lyrics with the layer's scale, or `wordActive` on glow.
    { key: 'size', label: 'Size', group: 'Text', type: 'float', default: 0.075, min: 0.01, max: 0.4, softMax: 0.2, space: 'canvas', aspectOverridable: true, modulatable: false },
    { key: 'letterSpacing', label: 'Tracking', group: 'Text', type: 'float', default: 0, min: -0.2, max: 1, softMax: 0.4, unit: 'em', modulatable: false },
    { key: 'lineHeight', label: 'Line height', group: 'Text', type: 'float', default: 1.1, min: 0.7, max: 3, modulatable: false, description: 'For a lyric line that wraps' },
    {
      key: 'align', label: 'Align', group: 'Text', type: 'enum', default: 'center',
      options: [{ value: 'left', label: 'Left' }, { value: 'center', label: 'Centre' }, { value: 'right', label: 'Right' }],
    },
    { key: 'maxWidth', label: 'Max width', group: 'Text', type: 'float', default: 0.84, min: 0.1, max: 1, aspectOverridable: true, modulatable: false, description: 'Wrap width, as a fraction of the canvas width; left and right alignment use it as the column' },

    {
      key: 'roles', label: 'Show', group: 'Lines', type: 'enum', default: 'all', modulatable: false,
      options: [
        { value: 'all', label: 'All (backing and ad-libs beside the lead)' },
        { value: 'lead', label: 'Lead only' },
        { value: 'backing', label: 'Backing only' },
        { value: 'adlib', label: 'Ad-libs only' },
      ],
    },
    { key: 'lines', label: 'Lines shown', group: 'Lines', type: 'int', default: 2, min: 1, max: 5, modulatable: false, description: 'The current line plus the upcoming ones' },
    { key: 'nextOpacity', label: 'Next-line opacity', group: 'Lines', type: 'float', default: 0.45, min: 0, max: 1, modulatable: true },
    { key: 'lineGap', label: 'Line gap', group: 'Lines', type: 'float', default: 0.45, min: 0, max: 3, unit: 'em' },
    {
      key: 'advance', label: 'Advance', group: 'Lines', type: 'enum', default: 'scroll', modulatable: false,
      options: [{ value: 'scroll', label: 'Scroll' }, { value: 'crossfade', label: 'Crossfade' }, { value: 'cut', label: 'Cut' }],
    },
    { key: 'advanceSeconds', label: 'Advance time', group: 'Lines', type: 'float', default: 0.3, min: 0, max: 2, unit: 's', visibleWhen: { param: 'advance', equals: 'scroll' } },
    { key: 'leadIn', label: 'Lead-in', group: 'Lines', type: 'float', default: 0.6, min: 0, max: 5, unit: 's', modulatable: false, description: 'A line appears this long before it is sung, when the gap allows' },
    { key: 'holdOut', label: 'Hold-out', group: 'Lines', type: 'float', default: 0.4, min: 0, max: 5, unit: 's', modulatable: false, description: 'A line stays this long after it ends, unless the next one needs the screen' },

    { key: 'fill', label: 'Karaoke', group: 'Karaoke', type: 'enum', default: 'wipe', options: KARAOKE_FILLS, modulatable: false },
    { key: 'upcoming', label: 'Upcoming', group: 'Karaoke', type: 'color', default: '#ffffff', paletteRole: 'text', modulatable: true },
    { key: 'active', label: 'Being sung', group: 'Karaoke', type: 'color', default: '#ff2d95', paletteRole: 'accent', modulatable: true },
    { key: 'sung', label: 'Sung', group: 'Karaoke', type: 'color', default: '#ff2d95', paletteRole: 'accent', modulatable: true },
    { key: 'softEdge', label: 'Soft edge', group: 'Karaoke', type: 'float', default: 0.1, min: 0, max: 2, softMax: 0.6, unit: 'em', description: 'Feather of the wipe; the gradient sweep uses at least one em' },
    { key: 'pop', label: 'Pop', group: 'Karaoke', type: 'float', default: 0.6, min: 0, max: 1, modulatable: true, visibleWhen: { param: 'fill', equals: 'wordPop' } },
    { key: 'ballColor', label: 'Ball colour', group: 'Karaoke', type: 'color', default: '#ffffff', paletteRole: 'accent', visibleWhen: { param: 'fill', equals: 'bouncingBall' } },
    { key: 'ballSize', label: 'Ball size', group: 'Karaoke', type: 'float', default: 0.16, min: 0.04, max: 0.6, unit: 'em', visibleWhen: { param: 'fill', equals: 'bouncingBall' } },

    { key: 'gradient', label: 'Gradient', group: 'Karaoke', type: 'bool', default: false, description: 'Tints the line from top to bottom, over whichever colour each word has reached' },
    { key: 'gradientColor', label: 'Gradient to', group: 'Karaoke', type: 'color', default: '#7f7fff', paletteRole: 'secondary', visibleWhen: { param: 'gradient', equals: true } },

    { key: 'strokeWidth', label: 'Outline', group: 'Outline', type: 'float', default: 0, min: 0, max: 0.3, softMax: 0.12, unit: 'em', modulatable: false, description: '“Fill the outline” uses at least 0.04 em' },
    { key: 'strokeColor', label: 'Outline colour', group: 'Outline', type: 'color', default: '#000000' },

    // On by default: thin bright type over a busy visual is the classic illegible combination (lyrics-spec §7).
    { key: 'shadow', label: 'Shadow', group: 'Shadow', type: 'float', default: 0.5, min: 0, max: 1, modulatable: true },
    { key: 'shadowColor', label: 'Shadow colour', group: 'Shadow', type: 'color', default: '#000000', paletteRole: 'textShadow' },
    { key: 'shadowDistance', label: 'Distance', group: 'Shadow', type: 'float', default: 0.04, min: 0, max: 0.5, unit: 'em' },
    { key: 'shadowAngle', label: 'Angle', group: 'Shadow', type: 'float', default: 120, min: 0, max: 360, unit: '°', advanced: true },
    { key: 'shadowSoftness', label: 'Softness', group: 'Shadow', type: 'float', default: 0.1, min: 0, max: 0.5, unit: 'em' },

    { key: 'glow', label: 'Glow', group: 'Glow', type: 'float', default: 0, min: 0, max: 3, softMax: 1.5, modulatable: true },
    { key: 'glowColor', label: 'Glow colour', group: 'Glow', type: 'color', default: '#ff2d95', paletteRole: 'glow' },
    { key: 'glowRadius', label: 'Radius', group: 'Glow', type: 'float', default: 0.25, min: 0.02, max: 1, unit: 'em' },

    { key: 'plate', label: 'Plate', group: 'Plate', type: 'bool', default: false, description: 'A rounded panel behind each line' },
    { key: 'plateColor', label: 'Plate colour', group: 'Plate', type: 'color', default: '#000000', visibleWhen: { param: 'plate', equals: true } },
    { key: 'plateOpacity', label: 'Plate opacity', group: 'Plate', type: 'float', default: 0.5, min: 0, max: 1, visibleWhen: { param: 'plate', equals: true } },
    { key: 'platePadding', label: 'Padding', group: 'Plate', type: 'float', default: 0.35, min: 0, max: 2, unit: 'em', visibleWhen: { param: 'plate', equals: true } },
    { key: 'plateRadius', label: 'Corner', group: 'Plate', type: 'float', default: 0.25, min: 0, max: 2, unit: 'em', visibleWhen: { param: 'plate', equals: true } },

    { key: 'animIn', label: 'In', group: 'Animation', type: 'enum', default: 'fade', options: TEXT_ANIMATIONS, modulatable: false, description: 'When a line appears out of an empty screen' },
    { key: 'animOut', label: 'Out', group: 'Animation', type: 'enum', default: 'fade', options: TEXT_ANIMATIONS, modulatable: false, description: 'When a line leaves into an empty screen' },
    { key: 'animSeconds', label: 'Duration', group: 'Animation', type: 'float', default: 0.3, min: 0, max: 5, softMax: 2, unit: 's' },

    { key: 'backingScale', label: 'Backing size', group: 'Roles', type: 'float', default: 0.72, min: 0.2, max: 2, modulatable: false, visibleWhen: { param: 'roles', equals: 'all' } },
    { key: 'backingOpacity', label: 'Backing opacity', group: 'Roles', type: 'float', default: 0.75, min: 0, max: 1, visibleWhen: { param: 'roles', equals: 'all' } },
    { key: 'backingOffset', label: 'Backing offset', group: 'Roles', type: 'float', default: 0, min: -10, max: 10, unit: 'em', description: 'From just below the lines shown; negative moves it up', visibleWhen: { param: 'roles', equals: 'all' } },
    { key: 'adlibScale', label: 'Ad-lib size', group: 'Roles', type: 'float', default: 0.7, min: 0.2, max: 2, modulatable: false, visibleWhen: { param: 'roles', equals: 'all' } },
    { key: 'adlibOpacity', label: 'Ad-lib opacity', group: 'Roles', type: 'float', default: 0.85, min: 0, max: 1, visibleWhen: { param: 'roles', equals: 'all' } },
    { key: 'adlibOffsetX', label: 'Ad-lib offset X', group: 'Roles', type: 'float', default: 0.28, min: -0.5, max: 0.5, description: 'Fraction of the canvas width', visibleWhen: { param: 'roles', equals: 'all' } },
    { key: 'adlibOffsetY', label: 'Ad-lib offset Y', group: 'Roles', type: 'float', default: -1, min: -10, max: 10, unit: 'em', visibleWhen: { param: 'roles', equals: 'all' } },
  ],
};

const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
/** The karaoke pop's time constant: a word brightens and rises as it starts, then settles. */
const POP_SECONDS = 0.18;

// ---------------------------------------------------------------------------
// The layout, as pure data (tested without a GPU)
// ---------------------------------------------------------------------------

/** One line to draw this frame, before rasterisation. */
export interface LyricDraw {
  readonly line: RenderLyricLine;
  /** Which part of the layout it belongs to: the sequence, at a slot, or a role satellite. */
  readonly place: { readonly kind: 'slot'; readonly slot: number; readonly state: number } | { readonly kind: 'satellite'; readonly role: string; readonly stack: number };
  readonly alpha: number;
  /** Size multiplier for the role (the line's own style multiplies on top). */
  readonly roleScale: number;
  /** Entry/exit animation window for this line: when it came on (null: a hand-over) and leaves (null: hands over). */
  readonly enterAt: number | null;
  readonly exitAt: number | null;
}

export interface LayoutOptions {
  readonly roles: string;
  readonly lines: number;
  readonly nextOpacity: number;
  readonly advance: string;
  readonly advanceSeconds: number;
  readonly leadIn: number;
  readonly holdOut: number;
  readonly backingScale: number;
  readonly backingOpacity: number;
  readonly adlibScale: number;
  readonly adlibOpacity: number;
}

/** For a fractional slot in a stack of `visible` lines: 1 at the current slot, fading below and above. */
export function slotAlpha(slot: number, visible: number, nextOpacity: number): number {
  let alpha: number;
  if (slot < 0) alpha = Math.max(0, 1 + slot);
  else if (slot <= 1) alpha = 1 + (nextOpacity - 1) * slot;
  else alpha = nextOpacity;
  // A line scrolling in at the bottom fades in with the scroll.
  return alpha * clamp01(visible - slot);
}

/**
 * Where the window is at `t`: the index of the current line, fractional during a hand-over. A
 * hand-over is **centred on the boundary** — it starts half the advance time before the next line
 * is sung and ends half after — so the new line arrives at the anchor as its singing begins, rather
 * than filling its first word while still dimmed in the preview slot. Half is capped at 40 % of the
 * lines on either side, so short lines still get a complete (faster) move. Null: nothing on screen.
 */
export function windowCursor(windows: readonly LineWindow[], t: number, advanceSeconds: number): number | null {
  const k = currentLineIndex(windows, t);
  if (k < 0) return null;
  const halfAt = (i: number) => {
    const w = windows[i] as LineWindow;
    const before = windows[i - 1] as LineWindow;
    return Math.max(0, Math.min(advanceSeconds / 2, 0.4 * (w.disappear - w.appear), 0.4 * (before.disappear - before.appear)));
  };
  const w = windows[k] as LineWindow;
  if (w.handover) {
    const half = halfAt(k);
    if (half > 0 && t < w.appear + half) return k - 1 + easeInOut(clamp01((t - (w.appear - half)) / (2 * half)));
  }
  const next = windows[k + 1];
  if (next !== undefined && next.handover) {
    const half = halfAt(k + 1);
    if (half > 0 && t >= next.appear - half) return k + easeInOut(clamp01((t - (next.appear - half)) / (2 * half)));
  }
  return k;
}

interface Sequenced {
  readonly lines: readonly RenderLyricLine[];
  readonly windows: readonly LineWindow[];
}

/**
 * Which lines are on screen at `t`, where, and how visible. Pure: a function of the lyrics, the
 * layer's settings and `t`. Draws are in back-to-front order.
 */
export function layoutLyrics(lyrics: RenderLyrics, t: number, options: LayoutOptions, sequenced?: { sequence: Sequenced; satellites: readonly Sequenced[] }): LyricDraw[] {
  const plan = sequenced ?? planLyrics(lyrics, options);
  const draws: LyricDraw[] = [];
  const { lines, windows } = plan.sequence;
  const visible = Math.max(1, Math.round(options.lines));
  const cursor = windowCursor(windows, t, options.advance === 'cut' ? 0 : options.advanceSeconds);
  if (cursor !== null) {
    // Entry and exit animations belong to the line the window is built around: the one before a
    // hand-over's midpoint, the next one after it.
    const k = Math.min(windows.length - 1, Math.round(cursor));
    const w = windows[k] as LineWindow;
    const nextHandover = k + 1 < windows.length && (windows[k + 1] as LineWindow).handover;
    const enterAt = w.handover ? null : w.appear;
    const exitAt = nextHandover ? null : w.disappear;
    const floor = Math.floor(cursor);
    const e = cursor - floor;
    const states: { base: number; weight: number }[] = options.advance === 'scroll' || e === 0
      ? [{ base: cursor, weight: 1 }]
      : [{ base: floor, weight: 1 - e }, { base: floor + 1, weight: e }];
    states.forEach((state, stateIndex) => {
      const first = Math.floor(state.base);
      for (let j = Math.max(0, first); j <= Math.min(lines.length - 1, first + visible); j += 1) {
        const slot = j - state.base;
        const alpha = slotAlpha(slot, visible, options.nextOpacity) * state.weight;
        if (alpha <= 0 || slot <= -1 || slot >= visible) continue;
        draws.push({ line: lines[j] as RenderLyricLine, place: { kind: 'slot', slot, state: stateIndex }, alpha, roleScale: 1, enterAt, exitAt });
      }
    });
  }
  for (const satellite of plan.satellites) {
    let stack = 0;
    satellite.windows.forEach((w, i) => {
      if (t < w.appear || t >= w.disappear) return;
      const line = satellite.lines[i] as RenderLyricLine;
      const nextHandover = i + 1 < satellite.windows.length && (satellite.windows[i + 1] as LineWindow).handover;
      const backing = line.role === 'backing';
      draws.push({
        line,
        place: { kind: 'satellite', role: line.role, stack },
        alpha: backing ? options.backingOpacity : options.adlibOpacity,
        roleScale: backing ? options.backingScale : options.adlibScale,
        enterAt: w.handover ? null : w.appear,
        exitAt: nextHandover ? null : w.disappear,
      });
      stack += 1;
    });
  }
  return draws;
}

/** The sequence and satellites for a role filter, with their on-screen windows. Cacheable. */
export function planLyrics(lyrics: RenderLyrics, options: Pick<LayoutOptions, 'roles' | 'leadIn' | 'holdOut'>): { sequence: Sequenced; satellites: readonly Sequenced[] } {
  const pick = (roles: readonly string[]) => lyrics.lines.filter((line) => roles.includes(line.role));
  const withWindows = (lines: readonly RenderLyricLine[]): Sequenced => ({ lines, windows: lineWindows(lines, options.leadIn, options.holdOut) });
  switch (options.roles) {
    case 'lead':
      return { sequence: withWindows(pick(['lead', 'instrumental-note'])), satellites: [] };
    case 'backing':
      return { sequence: withWindows(pick(['backing'])), satellites: [] };
    case 'adlib':
      return { sequence: withWindows(pick(['adlib'])), satellites: [] };
    default:
      return {
        sequence: withWindows(pick(['lead', 'instrumental-note'])),
        satellites: [withWindows(pick(['backing'])), withWindows(pick(['adlib']))],
      };
  }
}

/**
 * Per rasterised word: its fill progress, given the line's token spans. A token covering several
 * rasterised words (a word and the punctuation attached to it) fills across them left to right.
 */
export function rasterWordProgress(raster: Pick<TextRaster, 'words'>, text: string, spans: readonly WordSpan[], t: number): Float32Array {
  const tokens = lyricTokens(text);
  const out = new Float32Array(raster.words.length);
  const tokenOf = raster.words.map((word) => tokens.findIndex((token) => word.start >= token.start && word.start < token.end));
  tokens.forEach((_, ti) => {
    const members = raster.words.map((word, wi) => ({ word, wi })).filter(({ wi }) => tokenOf[wi] === ti);
    if (members.length === 0) return;
    const span = spans[ti];
    const p = span === undefined ? 0 : wordProgress(span, t);
    const total = members.reduce((sum, { word }) => sum + Math.max(1e-6, word.width), 0);
    let before = 0;
    for (const { word, wi } of members) {
      const width = Math.max(1e-6, word.width);
      out[wi] = clamp01((p * total - before) / width);
      before += width;
    }
  });
  return out;
}

/**
 * Per text row, where the gradient sweep's front is: +∞ when every word on the row is sung, −∞ when
 * none has started, else the furthest point any word on it has filled to. A right-to-left row runs
 * the other way, so its signs and its "furthest" are mirrored.
 */
export function rowFronts(raster: Pick<TextRaster, 'words'> & Partial<Pick<TextRaster, 'lines'>>, progress: Float32Array): Map<number, number> {
  const rows = new Map<number, { done: boolean; started: boolean; front: number }>();
  raster.words.forEach((word, i) => {
    const p = progress[i] ?? 0;
    const rtl = raster.lines?.[word.line]?.rtl === true;
    const row = rows.get(word.line) ?? { done: true, started: false, front: rtl ? Infinity : -Infinity };
    row.done &&= p >= 1;
    if (p > 0) {
      row.started = true;
      const filled = Math.min(1, p) * word.width;
      row.front = rtl ? Math.min(row.front, word.x + word.width - filled) : Math.max(row.front, word.x + filled);
    }
    rows.set(word.line, row);
  });
  return new Map([...rows].map(([line, row]) => {
    const sign = raster.lines?.[line]?.rtl === true ? -1 : 1;
    return [line, row.done ? sign * Infinity : row.started ? row.front : -sign * Infinity];
  }));
}

/**
 * Vertical centres of a window's lines relative to the anchor (px, y down). Lines are spaced by
 * half their heights plus the gap; `slots` are consecutive and share one fraction (a scroll in
 * progress), and slot 0 — interpolated between the two lines that bracket it — sits at the anchor.
 */
export function stackOffsets(heights: readonly number[], slots: readonly number[], gap: number): number[] {
  const positions: number[] = [0];
  for (let i = 1; i < heights.length; i += 1) {
    positions.push((positions[i - 1] as number) + (heights[i - 1] as number) / 2 + gap + (heights[i] as number) / 2);
  }
  let anchor: number;
  const below = slots.findIndex((s, i) => s <= 0 && (i + 1 >= slots.length || (slots[i + 1] as number) > 0));
  if (below >= 0 && below + 1 < slots.length) {
    const s0 = slots[below] as number;
    const s1 = slots[below + 1] as number;
    const p0 = positions[below] as number;
    anchor = p0 + ((positions[below + 1] as number) - p0) * (-s0 / (s1 - s0));
  } else if (below >= 0) {
    anchor = positions[below] as number;
  } else {
    // Every line is below the anchor (only possible mid-scroll with the current line faded out).
    anchor = (positions[0] as number) - (slots[0] ?? 0) * ((heights[0] ?? 0) + gap);
  }
  return positions.map((p) => p - anchor);
}

// ---------------------------------------------------------------------------
// The GPU part
// ---------------------------------------------------------------------------

const FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 u_canvas;
uniform sampler2D u_mask;   // RG: fill, outline — mipmapped, per-word visibility already applied
uniform sampler2D u_ids;    // RG8: 1-based word id
uniform highp sampler2D u_words; // RGBA32F, row 0: start, end (end < start: right to left), progress, row sweep x; row 1: pop, lift px, row is right to left
uniform float u_wordCount;
uniform vec2 u_bitmap;
uniform vec2 u_origin;
uniform vec4 u_content;
uniform vec3 u_upcoming;    // linear
uniform vec3 u_active;
uniform vec3 u_sung;
uniform int u_fill;         // 0 none · 1 wipe · 2 swap · 3 pop · 4 fill-the-outline · 5 gradient · 6 ball
uniform float u_soft;       // px
uniform float u_sweep;      // px: the gradient sweep's feather, at least one em
uniform float u_popBright;
uniform vec3 u_strokeColor;
uniform vec4 u_gradient;    // tint at the bottom of the line (linear), on
uniform vec4 u_shadow;      // dx, dy (px), lod, opacity
uniform vec3 u_shadowColor;
uniform vec3 u_glowColor;
uniform vec2 u_glow;        // intensity, lod
uniform vec3 u_plateColor;
uniform vec3 u_plate;       // opacity, padding px, radius px
uniform vec4 u_anim;        // offset y px, scale, blur lod, opacity
uniform vec4 u_ball;        // x, y (bitmap px), radius px, opacity
uniform vec3 u_ballColor;
out vec4 outColor;

${TEXT_SAMPLING_GLSL}

float wordIdAt(vec2 uv) {
  if (inside(uv) < 0.5) return 0.0;
  ivec2 texel = ivec2(clamp(uv * u_bitmap, vec2(0.0), u_bitmap - 1.0));
  vec2 rg = texelFetch(u_ids, texel, 0).rg;
  return min(floor(rg.r * 255.0 + 0.5) + 256.0 * floor(rg.g * 255.0 + 0.5), u_wordCount);
}

void main() {
  vec2 p = vec2(gl_FragCoord.x, u_canvas.y - gl_FragCoord.y);
  vec2 center = u_origin + u_content.xy + u_content.zw * 0.5;
  vec2 q = center + (p - center - vec2(0.0, u_anim.x)) / u_anim.y;
  vec2 uv = (q - u_origin) / u_bitmap;
  float id = wordIdAt(uv);
  vec4 wa = texelFetch(u_words, ivec2(int(id), 0), 0);
  vec4 wb = texelFetch(u_words, ivec2(int(id), 1), 0);
  // A popping word rises: its glyphs are sampled from below this pixel.
  vec2 guv = (q + vec2(0.0, wb.y) - u_origin) / u_bitmap;
  float blur = u_anim.z;
  vec2 m = blur > 0.0 ? vec2(coverage(guv, blur)) * sign(maskAt(guv, blur)) : maskAt(guv, 0.0);
  float fillA = m.r;
  float strokeA = m.g;

  float x = q.x - u_origin.x;
  float progress = wa.z;
  vec3 target = progress >= 1.0 ? u_sung : u_active;
  float s = 0.0;
  if (u_fill == 1 || u_fill == 4) {
    float edge = mix(wa.x, wa.y, progress);
    float ahead = smoothstep(edge - u_soft, edge + u_soft, x);
    s = progress <= 0.0 ? 0.0 : progress >= 1.0 ? 1.0 : wa.y < wa.x ? ahead : 1.0 - ahead;
  } else if (u_fill == 2 || u_fill == 3 || u_fill == 6) {
    s = progress > 0.0 ? 1.0 : 0.0;
  } else if (u_fill == 5) {
    float across = wb.z > 0.5 ? x - wa.w : wa.w - x;
    s = smoothstep(-u_sweep, u_sweep, across);
    // Near the front the colour of singing, further back the colour of sung.
    target = mix(u_active, u_sung, clamp(across / (4.0 * u_sweep), 0.0, 1.0));
  }
  vec3 fillColor = mix(u_upcoming, target, s);
  if (u_fill == 3) fillColor = mix(fillColor, vec3(1.0), wb.x * u_popBright);
  // A tint rather than a colour: a wipe has to stay readable all the way down the line.
  if (u_gradient.w > 0.5) fillColor *= mix(vec3(1.0), u_gradient.rgb, clamp((q.y - u_origin.y - u_content.y) / u_content.w, 0.0, 1.0));
  // Fill the outline: the outline is always there, the fill pours in.
  if (u_fill == 4) fillA *= s;
  vec4 glyph = vec4(fillColor * fillA, fillA) + vec4(u_strokeColor * strokeA, strokeA) * (1.0 - fillA);

  vec4 color = vec4(0.0);
  if (u_plate.x > 0.0) {
    vec2 half_ = u_content.zw * 0.5 + u_plate.y;
    float d = roundedBox(p - center, half_ * u_anim.y, u_plate.z * u_anim.y);
    float a = (1.0 - smoothstep(-0.75, 0.75, d)) * u_plate.x;
    color = vec4(u_plateColor * a, a);
  }
  if (u_shadow.w > 0.0) {
    float sh = coverage(guv - u_shadow.xy / u_bitmap, max(u_shadow.z, blur)) * u_shadow.w;
    color = vec4(u_shadowColor * sh, sh) + color * (1.0 - sh);
  }
  if (u_glow.x > 0.0) {
    float halo = coverage(guv, u_glow.y) * 0.6 + coverage(guv, u_glow.y + 1.5) * 0.4;
    color.rgb += u_glowColor * halo * u_glow.x;
    color.a = min(1.0, color.a + halo * u_glow.x * 0.25);
  }
  color = glyph + color * (1.0 - glyph.a);
  if (u_ball.w > 0.0) {
    float d = length((q - u_origin) - u_ball.xy);
    float a = (1.0 - smoothstep(u_ball.z - 1.0, u_ball.z + 1.0, d)) * u_ball.w;
    color = vec4(u_ballColor * a, a) + color * (1.0 - a);
  }
  outColor = color * u_anim.w;
}
`;

/** How many line rasters stay uploaded: the window, its neighbours and a little lookahead (§11). */
const RASTER_CACHE = 24;

interface Placed {
  readonly draw: LyricDraw;
  readonly uploaded: UploadedText;
  readonly em: number;
  readonly text: string;
  readonly animation: AnimationState;
  /** Offset of this line's content centre from the layer's anchor, px (y down). */
  x: number;
  y: number;
}

function createLyrics(gl: WebGL2RenderingContext): ModuleInstance {
  const program = createProgram(gl, lyricsManifest.id, FULLSCREEN_VERT, FRAG);
  const maskPass = createWordMaskPass(gl, lyricsManifest.id);
  const names = [
    'u_canvas', 'u_mask', 'u_ids', 'u_words', 'u_wordCount', 'u_bitmap', 'u_origin', 'u_content',
    'u_upcoming', 'u_active', 'u_sung', 'u_fill', 'u_soft', 'u_sweep', 'u_popBright', 'u_strokeColor', 'u_gradient',
    'u_shadow', 'u_shadowColor', 'u_glowColor', 'u_glow', 'u_plateColor', 'u_plate', 'u_anim', 'u_ball', 'u_ballColor',
  ] as const;
  const u = Object.fromEntries(names.map((name) => [name, uniformLocation(gl, program, name)])) as Record<(typeof names)[number], WebGLUniformLocation>;
  const vao = gl.createVertexArray();
  const words = gl.createTexture();
  const rasters = new Map<string, UploadedText>();
  let plan: { key: string; lyrics: RenderLyrics; value: ReturnType<typeof planLyrics> } | undefined;

  const rasterFor = (key: string, make: () => TextRaster, strokePx: number, liftPx: number): UploadedText => {
    const hit = rasters.get(key);
    if (hit !== undefined) {
      // Most recently used goes to the back of the map's order.
      rasters.delete(key);
      rasters.set(key, hit);
      return hit;
    }
    const uploaded = uploadTextRaster(gl, key, make(), strokePx, liftPx);
    rasters.set(key, uploaded);
    while (rasters.size > RASTER_CACHE) {
      const [oldest, value] = rasters.entries().next().value as [string, UploadedText];
      releaseTextRaster(gl, value);
      rasters.delete(oldest);
    }
    return uploaded;
  };

  const uploadWords = (data: Float32Array, width: number) => {
    gl.bindTexture(gl.TEXTURE_2D, words);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, 2, 0, gl.RGBA, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindTexture(gl.TEXTURE_2D, null);
  };

  return {
    resize() {},

    render(ctx: RenderContext, params: ParamValues) {
      const rasterizer = ctx.text;
      if (rasterizer === undefined) {
        ctx.warn('lyrics: this renderer has no text rasteriser, so lyrics cannot be drawn');
        return;
      }
      if (!rasterizer.ready) {
        ctx.warn('lyrics: fonts are still loading');
        return;
      }
      const lyrics = ctx.lyrics;
      if (lyrics === undefined || lyrics.lines.length === 0) {
        ctx.warn(lyrics === undefined
          ? 'lyrics: the project has no lyrics yet — add them in the Lyrics panel'
          : `lyrics: none of the ${lyrics.untimedLines} lines has a time yet — tap, import or align them in the Lyrics panel`);
        return;
      }
      const t = ctx.time.t;
      const options: LayoutOptions = {
        roles: str(params, 'roles'),
        lines: num(params, 'lines'),
        nextOpacity: num(params, 'nextOpacity'),
        advance: str(params, 'advance'),
        advanceSeconds: num(params, 'advanceSeconds'),
        leadIn: num(params, 'leadIn'),
        holdOut: num(params, 'holdOut'),
        backingScale: num(params, 'backingScale'),
        backingOpacity: num(params, 'backingOpacity'),
        adlibScale: num(params, 'adlibScale'),
        adlibOpacity: num(params, 'adlibOpacity'),
      };
      const planKey = `${options.roles}|${options.leadIn}|${options.holdOut}`;
      if (plan === undefined || plan.lyrics !== lyrics || plan.key !== planKey) plan = { key: planKey, lyrics, value: planLyrics(lyrics, options) };
      const draws = layoutLyrics(lyrics, t, options, plan.value);
      if (draws.length === 0) return;

      const font = ctx.font(str(params, 'font'));
      if (font.missing !== undefined) ctx.warn(`lyrics: ${font.missing}; drawing with the default font`);
      const casing = str(params, 'case');
      const fill = str(params, 'fill');
      const fillCode = FILL_CODE[fill] ?? 1;
      const baseEm = Math.min(4000, Math.max(1, num(params, 'size') * ctx.canvas.referenceScale));
      const maxWidthPx = num(params, 'maxWidth') * ctx.canvas.width;
      const align = str(params, 'align') as TextRequest['align'];
      const glowOn = num(params, 'glow') > 0;
      const shadowOn = num(params, 'shadow') > 0;
      const pop = num(params, 'pop');

      // Rasterise (or find) every line first: uploading binds framebuffers, which must not happen
      // between setting up a draw and making it.
      const placed: Placed[] = draws.map((draw) => {
        const style = draw.line.style;
        const em = Math.min(4000, Math.max(1, baseEm * draw.roleScale * (style?.scale ?? 1)));
        const text = casing === 'upper' ? draw.line.text.toUpperCase() : casing === 'lower' ? draw.line.text.toLowerCase() : draw.line.text;
        const strokePx = Math.max(num(params, 'strokeWidth'), fill === 'fillStroke' ? 0.04 : 0) * em;
        const paddingPx = Math.ceil(Math.min(em * 3, Math.max(
          strokePx + 2,
          glowOn ? num(params, 'glowRadius') * em * 3 : 0,
          shadowOn ? (num(params, 'shadowDistance') + num(params, 'shadowSoftness') * 3) * em : 0,
          48,
        )));
        const request: TextRequest = {
          text,
          fontHash: font.hash,
          sizePx: em,
          letterSpacingPx: num(params, 'letterSpacing') * em,
          lineHeight: num(params, 'lineHeight'),
          align,
          maxWidthPx,
          strokePx,
          paddingPx,
        };
        const liftPx = fill === 'wordPop' ? Math.ceil(pop * 0.18 * em) : 0;
        const uploaded = rasterFor(`${JSON.stringify(request)}|${liftPx}`, () => rasterizer.rasterize(request), strokePx, liftPx);
        const animation = textAnimation(
          t,
          { inSeconds: draw.enterAt ?? -Infinity, outSeconds: draw.exitAt },
          str(params, 'animIn'),
          str(params, 'animOut'),
          num(params, 'animSeconds'),
          uploaded.raster.words.length,
        );
        return { draw, uploaded, em, text, animation, x: 0, y: 0 };
      });
      for (const p of placed) {
        if (!p.uploaded.raster.fontFound && font.missing === undefined) ctx.warn(`lyrics: font "${font.name}" could not be used; drawing with the default font`);
        const missingGlyphs = p.uploaded.raster.missingGlyphs ?? [];
        if (missingGlyphs.length > 0) ctx.warn(`lyrics: no font has ${missingGlyphs.join(' ')}; drawn as a box. Choose a font that does`);
        if (p.uploaded.raster.clamped) ctx.warn('lyrics: a line is larger than the maximum texture size and was scaled down');
      }

      // Stack positions: within each window state, line centres are spaced by their own heights
      // plus the gap, and the (fractional) current slot sits at the anchor.
      const gap = num(params, 'lineGap') * baseEm;
      const heightOf = (p: Placed) => p.uploaded.raster.content.height;
      const states = new Map<number, Placed[]>();
      for (const p of placed) {
        if (p.draw.place.kind === 'slot') states.set(p.draw.place.state, [...(states.get(p.draw.place.state) ?? []), p]);
      }
      for (const group of states.values()) {
        group.sort((a, b) => (a.draw.place as { slot: number }).slot - (b.draw.place as { slot: number }).slot);
        const offsets = stackOffsets(group.map(heightOf), group.map((p) => (p.draw.place as { slot: number }).slot), gap);
        group.forEach((p, i) => {
          p.y = offsets[i] as number;
        });
      }
      // Below the whole window — the current line and its previews, as actually laid out (a line
      // that wraps is taller) — so a backing line never lands on the next-line preview. A line
      // still scrolling in at the bottom does not count, or the backing line would bob with it.
      const visibleLines = Math.max(1, Math.round(num(params, 'lines')));
      const inWindow = placed.filter((p) => p.draw.place.kind === 'slot' && p.draw.place.slot <= visibleLines - 1);
      const windowBottom = inWindow.length > 0
        ? Math.max(...inWindow.map((p) => p.y + heightOf(p) / 2))
        : (visibleLines - 0.5) * (1.25 * baseEm + gap);
      const satellites = placed.filter((p) => p.draw.place.kind === 'satellite');
      for (const p of satellites) {
        const place = p.draw.place as { role: string; stack: number };
        const stackStep = (heightOf(p) + gap) * place.stack;
        if (place.role === 'backing') {
          p.y = windowBottom + gap + heightOf(p) / 2 + num(params, 'backingOffset') * baseEm + stackStep;
        } else {
          p.x = num(params, 'adlibOffsetX') * ctx.canvas.width;
          p.y = num(params, 'adlibOffsetY') * baseEm - stackStep;
        }
      }

      const upcoming = linearHex(str(params, 'upcoming'), '#ffffff');
      const active = linearHex(str(params, 'active'), '#ff2d95');
      const sung = linearHex(str(params, 'sung'), '#ff2d95');
      const sc = linearHex(str(params, 'strokeColor'), '#000000');
      const gradientTint = linearHex(str(params, 'gradientColor'), '#7f7fff');
      const shc = linearHex(str(params, 'shadowColor'), '#000000');
      const gc = linearHex(str(params, 'glowColor'), '#ff2d95');
      const pc = linearHex(str(params, 'plateColor'), '#000000');
      const bc = linearHex(str(params, 'ballColor'), '#ffffff');
      const angle = (num(params, 'shadowAngle') * Math.PI) / 180;
      const lodFor = (px: number) => Math.max(0, Math.log2(Math.max(1, px)));
      const cx = ctx.canvas.width / 2;
      const cy = ctx.canvas.height / 2;
      const safe = { x0: ctx.canvas.width * 0.05, y0: ctx.canvas.height * 0.05, x1: ctx.canvas.width * 0.95, y1: ctx.canvas.height * 0.95 };
      let unsafe: string | undefined;

      for (const p of placed) {
        const { raster } = p.uploaded;
        const style = p.draw.line.style;
        const alpha = clamp01(p.draw.alpha * (style?.opacity ?? 1)) * p.animation.opacity;
        if (alpha <= 0) continue;
        const spans = wordSpans(p.draw.line);
        const progress = rasterWordProgress(raster, p.text, spans, t);
        const wordCount = Math.min(MAX_WORDS, raster.words.length);

        // The per-word table: box, progress and the row's sweep front; pop and lift.
        const width = wordCount + 1;
        const table = new Float32Array(width * 2 * 4);
        const rows = rowFronts(raster, progress);
        const tokens = lyricTokens(p.text);
        for (let i = 0; i < wordCount; i += 1) {
          const word = raster.words[i] as TextRaster['words'][number];
          const o = (i + 1) * 4;
          const row = rows.get(word.line) ?? -Infinity;
          table[o] = word.rtl === true ? word.x + word.width : word.x;
          table[o + 1] = word.rtl === true ? word.x : word.x + word.width;
          table[o + 2] = progress[i] as number;
          table[o + 3] = Math.max(-1e6, Math.min(1e6, row));
          const ti = tokens.findIndex((token) => word.start >= token.start && word.start < token.end);
          const span = spans[ti];
          const age = span === undefined ? -1 : t - span.start;
          const popValue = fill === 'wordPop' && age >= 0 && age < POP_SECONDS * 8 ? Math.exp(-age / POP_SECONDS) * pop : 0;
          table[width * 4 + o] = popValue;
          table[width * 4 + o + 1] = popValue * 0.18 * p.em;
          table[width * 4 + o + 2] = raster.lines[word.line]?.rtl === true ? 1 : 0;
        }
        uploadWords(table, width);

        // The bouncing ball, on the current line: it lands on each word as it starts.
        let ball: [number, number, number, number] = [0, 0, 0, 0];
        if (fill === 'bouncingBall' && p.draw.place.kind === 'slot' && Math.abs(p.draw.place.slot) < 0.5 && tokens.length > 0) {
          const boxes = tokens.map((_, ti) => {
            const members = raster.words.filter((w) => tokens.findIndex((tk) => w.start >= tk.start && w.start < tk.end) === ti);
            if (members.length === 0) return null;
            const x0 = Math.min(...members.map((w) => w.x));
            const x1 = Math.max(...members.map((w) => w.x + w.width));
            return { c: (x0 + x1) / 2, top: Math.min(...members.map((w) => w.y)) };
          });
          const valid = boxes.map((b, i) => ({ b, s: spans[i] })).filter((e): e is { b: { c: number; top: number }; s: WordSpan } => e.b !== null && e.s !== undefined);
          if (valid.length > 0) {
            const hop = 0.6 * p.em;
            const radius = (num(params, 'ballSize') * p.em) / 2;
            let x: number;
            let top: number;
            let height = 0;
            const lastStarted = valid.reduce((acc, e, i) => (e.s.start <= t ? i : acc), -1);
            if (lastStarted < 0) {
              const first = valid[0] as (typeof valid)[number];
              const u2 = clamp01(1 - (first.s.start - t) / 0.4);
              x = first.b.c - (1 - u2) * p.em;
              top = first.b.top;
              height = Math.sin(Math.PI * (0.5 + u2 / 2)) * hop;
            } else if (lastStarted >= valid.length - 1) {
              const last = valid[valid.length - 1] as (typeof valid)[number];
              x = last.b.c;
              top = last.b.top;
            } else {
              const a = valid[lastStarted] as (typeof valid)[number];
              const b = valid[lastStarted + 1] as (typeof valid)[number];
              const u2 = clamp01((t - a.s.start) / Math.max(1e-6, b.s.start - a.s.start));
              x = a.b.c + (b.b.c - a.b.c) * u2;
              top = a.b.top + (b.b.top - a.b.top) * u2;
              height = Math.sin(Math.PI * u2) * hop;
            }
            ball = [x, top - 0.15 * p.em - radius - height, radius, 1];
          }
        }

        // Where the line sits: its content box centred on the anchor, or against the column edge.
        const contentCx = raster.content.x + raster.content.width / 2;
        const contentCy = raster.content.y + raster.content.height / 2;
        const columnX = align === 'left' ? cx - maxWidthPx / 2 + raster.content.width / 2 : align === 'right' ? cx + maxWidthPx / 2 - raster.content.width / 2 : cx;
        const dx = p.x + (style?.offsetX ?? 0) * p.em;
        const dy = p.y + (style?.offsetY ?? 0) * p.em;
        const originX = Math.round(columnX + dx - contentCx);
        const originY = Math.round(cy + dy - contentCy);

        // Scissor to the line's bitmap after animation, plus the ball's airspace: each line is a
        // full-screen triangle, and at 4K that is not free.
        const scale = Math.max(0.01, p.animation.scale);
        const centerX = originX + contentCx;
        const centerY = originY + contentCy;
        const offsetY = p.animation.offsetEm * p.em;
        const left = centerX + (originX - centerX) * scale;
        const right = centerX + (originX + raster.width - centerX) * scale;
        const top = centerY + (originY - centerY) * scale + offsetY - (fill === 'bouncingBall' ? 1.5 * p.em * scale : 0);
        const bottom = centerY + (originY + raster.height - centerY) * scale + offsetY;
        const sx = Math.max(0, Math.floor(left) - 2);
        const sy = Math.max(0, Math.floor(top) - 2);
        const sw = Math.min(ctx.canvas.width, Math.ceil(right) + 2) - sx;
        const sh = Math.min(ctx.canvas.height, Math.ceil(bottom) + 2) - sy;
        if (sw <= 0 || sh <= 0) continue;

        const contentLeft = centerX - (raster.content.width / 2) * scale;
        const contentRight = centerX + (raster.content.width / 2) * scale;
        const contentTop = centerY - (raster.content.height / 2) * scale + offsetY;
        const contentBottom = centerY + (raster.content.height / 2) * scale + offsetY;
        if (alpha > 0.5 && (contentLeft < safe.x0 || contentRight > safe.x1 || contentTop < safe.y0 || contentBottom > safe.y1)) unsafe = p.draw.line.text;

        const mask = p.animation.words !== null ? maskPass.apply(p.uploaded, p.animation.words) : p.uploaded.base;
        gl.bindFramebuffer(gl.FRAMEBUFFER, ctx.outputTarget.framebuffer);
        gl.viewport(0, 0, ctx.outputTarget.width, ctx.outputTarget.height);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(sx, ctx.canvas.height - (sy + sh), sw, sh);

        const up = style?.color != null ? linearHex(style.color, str(params, 'upcoming')) : upcoming;
        const shadowDistancePx = num(params, 'shadowDistance') * p.em;
        gl.useProgram(program);
        gl.uniform2f(u.u_canvas, ctx.canvas.width, ctx.canvas.height);
        gl.uniform1f(u.u_wordCount, wordCount);
        gl.uniform2f(u.u_bitmap, raster.width, raster.height);
        gl.uniform2f(u.u_origin, originX, originY);
        gl.uniform4f(u.u_content, raster.content.x, raster.content.y, raster.content.width, raster.content.height);
        gl.uniform3f(u.u_upcoming, up[0], up[1], up[2]);
        gl.uniform3f(u.u_active, active[0], active[1], active[2]);
        gl.uniform3f(u.u_sung, sung[0], sung[1], sung[2]);
        gl.uniform1i(u.u_fill, fillCode);
        gl.uniform1f(u.u_soft, num(params, 'softEdge') * p.em);
        gl.uniform1f(u.u_sweep, Math.max(num(params, 'softEdge'), 1) * p.em);
        gl.uniform1f(u.u_popBright, 0.5);
        gl.uniform3f(u.u_strokeColor, sc[0], sc[1], sc[2]);
        gl.uniform4f(u.u_gradient, gradientTint[0], gradientTint[1], gradientTint[2], params['gradient'] === true ? 1 : 0);
        gl.uniform4f(u.u_shadow, Math.cos(angle) * shadowDistancePx, Math.sin(angle) * shadowDistancePx, lodFor(num(params, 'shadowSoftness') * p.em), num(params, 'shadow'));
        gl.uniform3f(u.u_shadowColor, shc[0], shc[1], shc[2]);
        gl.uniform3f(u.u_glowColor, gc[0], gc[1], gc[2]);
        gl.uniform2f(u.u_glow, num(params, 'glow'), lodFor(num(params, 'glowRadius') * p.em));
        gl.uniform3f(u.u_plateColor, pc[0], pc[1], pc[2]);
        gl.uniform3f(u.u_plate, params['plate'] === true ? num(params, 'plateOpacity') : 0, num(params, 'platePadding') * p.em, num(params, 'plateRadius') * p.em);
        gl.uniform4f(u.u_anim, offsetY, scale, p.animation.blurLod, alpha);
        gl.uniform4f(u.u_ball, ball[0], ball[1], ball[2], ball[3]);
        gl.uniform3f(u.u_ballColor, bc[0], bc[1], bc[2]);
        bindTexture(gl, 0, mask, u.u_mask);
        bindTexture(gl, 1, p.uploaded.ids, u.u_ids);
        bindTexture(gl, 2, words, u.u_words);
        drawFullscreenTriangle(gl, vao);
        unbindTextures(gl, 3);
      }
      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.BLEND);
      gl.useProgram(null);
      if (unsafe !== undefined) ctx.warn(`lyrics: “${unsafe.length > 40 ? `${unsafe.slice(0, 39)}…` : unsafe}” runs outside the title-safe area at ${ctx.canvas.width}×${ctx.canvas.height}`);
    },

    dispose() {
      for (const uploaded of rasters.values()) releaseTextRaster(gl, uploaded);
      rasters.clear();
      maskPass.dispose();
      gl.deleteTexture(words);
      gl.deleteProgram(program);
      gl.deleteVertexArray(vao);
    },
  };
}

export const lyricsModule: ModuleDefinition = { manifest: lyricsManifest, create: createLyrics };
