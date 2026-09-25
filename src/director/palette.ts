// Palette derivation (auto-director-spec §5.3, M17's roles).
//
// `generate-from-style`: a base hue from a style axis (the template says which, and over which
// arc of the wheel), a harmony rule to expand it, lightness and saturation from the track's
// energy and darkness, then the roles. Contrast is enforced last and always wins: text against
// the background must reach the template's minimum (WCAG 2 contrast ratio), and the primary must
// stand clear of the background, adjusting lightness until it does — "legibility outranks the
// palette's aesthetic intent, always". Both adjustments are logged.
//
// Colours are chosen in HSL because templates are written in its terms (hue ranges, saturation,
// lightness); contrast is measured in WCAG relative luminance, which is what legibility follows.

import { random01 } from '../engine/core/prng.ts';
import type { Palette } from '../project/document.ts';
import { PALETTE_ROLES, type PaletteRole } from '../project/palette.ts';
import type { StyleVector } from './digest.ts';
import type { Harmony, TemplatePalette } from './template.ts';

export interface Hsl {
  readonly h: number;
  readonly s: number;
  readonly l: number;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const wrap = (h: number) => ((h % 360) + 360) % 360;

export function hslToHex({ h, s, l }: Hsl): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = wrap(h) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  const hex = (v: number) => Math.round(clamp01(v + m) * 255).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

export function hexToHsl(hex: string): Hsl {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  const n = m === null ? 0 : parseInt(m[1] as string, 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s, l };
}

/** WCAG 2 relative luminance of an sRGB hex colour. */
export function relativeLuminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  const n = m === null ? 0 : parseInt(m[1] as string, 16);
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** WCAG 2 contrast ratio, 1..21. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** A plain name for a hue, for the decision log and the history strip. */
export function hueName(hex: string): string {
  const { h, s, l } = hexToHsl(hex);
  if (s < 0.12) return l > 0.6 ? 'white' : l < 0.25 ? 'black' : 'grey';
  const names: [number, string][] = [
    [15, 'red'], [40, 'orange'], [65, 'gold'], [90, 'lime'], [150, 'green'], [175, 'teal'], [200, 'cyan'],
    [235, 'blue'], [265, 'indigo'], [290, 'violet'], [320, 'magenta'], [345, 'pink'], [360, 'red'],
  ];
  return (names.find(([edge]) => h < edge) ?? names[0]!)[1];
}

/** Hue offsets of secondary and accent from the primary. */
const HARMONY: Record<Harmony, readonly [number, number]> = {
  analogous: [35, -35],
  complementary: [180, 30],
  triad: [120, 240],
  duotone: [180, 0],
  mono: [0, 0],
};

export interface GeneratedPalette {
  readonly palette: Palette;
  /** Plain-language notes for the decision log, including any contrast fix. */
  readonly notes: readonly string[];
  readonly data: Readonly<Record<string, unknown>>;
}

/**
 * A palette from the template's rule and the track's style. `seed` is the palette aspect's own
 * seed, so a palette lock reproduces it and a reroll moves only the hue within `hueJitter`.
 */
export function generatePalette(spec: TemplatePalette, style: StyleVector, seed: number, hueJitter: number): GeneratedPalette {
  const notes: string[] = [];
  const axis = style[spec.baseHue.from];
  const [h0, h1] = spec.baseHue.range;
  const jitter = (random01(seed, 'palette', 'hue') * 2 - 1) * hueJitter;
  const hue = wrap(h0 + (h1 - h0) * axis + jitter);
  const saturation = spec.saturation[0] + (spec.saturation[1] - spec.saturation[0]) * style.energy;
  const [offsetB, offsetC] = HARMONY[spec.harmony];
  const light = spec.mode === 'light';

  // Darker tracks sit on darker grounds; a light template's paper gets brighter with brighter tracks.
  const [b0, b1] = spec.background;
  const backgroundL = light ? b0 + (b1 - b0) * style.brightness : b1 - (b1 - b0) * style.darkness;

  const roles: Record<PaletteRole, Hsl> = {
    primary: { h: hue, s: saturation, l: light ? 0.42 : 0.58 },
    secondary: { h: hue + offsetB, s: saturation * 0.9, l: light ? 0.38 : spec.harmony === 'mono' ? 0.4 : 0.55 },
    accent: { h: hue + offsetC, s: saturation, l: light ? 0.48 : spec.harmony === 'duotone' || spec.harmony === 'mono' ? 0.74 : 0.62 },
    glow: { h: hue, s: Math.min(1, saturation + 0.05), l: light ? 0.55 : 0.72 },
    background: { h: hue + (spec.harmony === 'duotone' ? offsetB : 0), s: light ? 0.12 : saturation * 0.45, l: backgroundL },
    text: light ? { h: hue, s: 0.25, l: 0.1 } : { h: hue, s: 0.2, l: 0.95 },
    textShadow: light ? { h: hue, s: 0.1, l: 0.97 } : { h: hue, s: 0.3, l: 0.03 },
  };
  const hex: Record<PaletteRole, string> = Object.fromEntries(PALETTE_ROLES.map((role) => [role, hslToHex(roles[role])])) as Record<PaletteRole, string>;

  for (const [role, color] of Object.entries(spec.colors)) {
    if ((PALETTE_ROLES as readonly string[]).includes(role) && /^#[0-9a-f]{6}$/i.test(color) && spec.strategy === 'fixed') {
      hex[role as PaletteRole] = color.toLowerCase();
    }
  }

  // Legibility first: push text away from the background until it passes.
  const textBefore = contrastRatio(hex.text, hex.background);
  if (textBefore < spec.minTextContrast) {
    const fixed = separate(hex.text, hex.background, spec.minTextContrast, light ? -1 : 1);
    hex.text = fixed.moved;
    hex.background = fixed.anchor;
    notes.push(`Text contrast was ${textBefore.toFixed(1)}:1; lightened to ${contrastRatio(hex.text, hex.background).toFixed(1)}:1 (minimum ${spec.minTextContrast}:1).`);
  }
  // And the primary must read against the ground (§7 "minimum perceptual distance").
  const primaryBefore = contrastRatio(hex.primary, hex.background);
  if (primaryBefore < PRIMARY_MIN_CONTRAST) {
    const fixed = separate(hex.primary, hex.background, PRIMARY_MIN_CONTRAST, light ? -1 : 1);
    hex.primary = fixed.moved;
    hex.background = fixed.anchor;
    notes.push(`Primary was too close to the background (${primaryBefore.toFixed(1)}:1); pushed apart to ${contrastRatio(hex.primary, hex.background).toFixed(1)}:1.`);
  }

  notes.unshift(`${hueName(hex.primary)} primary (hue ${Math.round(hue)}° from ${spec.baseHue.from} ${axis.toFixed(2)}), ${spec.harmony} harmony, ${light ? 'light' : 'dark'} ground.`);
  return {
    palette: { colors: PALETTE_ROLES.map((role) => hex[role]), roles: Object.fromEntries(PALETTE_ROLES.map((role, i) => [role, i])), extra: {} },
    notes,
    data: { hue: Math.round(hue), saturation: Number(saturation.toFixed(3)), textContrast: Number(contrastRatio(hex.text, hex.background).toFixed(2)) },
  };
}

/** Primary against background: WCAG's figure for large graphics (1.4.11 non-text contrast). */
const PRIMARY_MIN_CONTRAST = 3;

/**
 * Moves `color`'s lightness in `direction` until it reaches `min` contrast against `anchor`; if
 * it runs out of room, moves the anchor the other way too. Always terminates.
 */
function separate(color: string, anchor: string, min: number, direction: 1 | -1): { moved: string; anchor: string } {
  let c = hexToHsl(color);
  let a = hexToHsl(anchor);
  for (let i = 0; i < 100 && contrastRatio(hslToHex(c), hslToHex(a)) < min; i += 1) {
    if ((direction > 0 && c.l < 0.99) || (direction < 0 && c.l > 0.01)) c = { ...c, l: clamp01(c.l + 0.02 * direction) };
    else a = { ...a, l: clamp01(a.l - 0.02 * direction) };
  }
  return { moved: hslToHex(c), anchor: hslToHex(a) };
}
