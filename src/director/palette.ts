// Palette derivation (auto-director-spec §5.3, M17's roles).
//
// `generate-from-style`: a base hue from a style axis (the template says which, and over which
// arc of the wheel), a harmony rule to expand it, lightness and saturation from the track's
// energy and darkness, then the roles. Contrast is enforced last and always wins: text against
// the background must reach the template's minimum (WCAG 2 contrast ratio), and the primary must
// stand clear of the background, adjusting lightness until it does — "legibility outranks the
// palette's aesthetic intent, always". Both adjustments are logged.
//
// `derive-from-image`: the dominant colours of a picture, by saturation-weighted clustering, stand
// in for the style axis: the strongest gives the primary, the harmony rule places the others (on a
// colour of the picture where one is near enough, on the rule's own hue otherwise), and the same
// contrast step finishes it. Fixed-stride sampling, a seeded start and a fixed number of iterations
// make it a pure function of the pixels and the seed; only the resulting hex is stored.
//
// Colours are chosen in HSL because templates are written in its terms (hue ranges, saturation,
// lightness); contrast is measured in WCAG relative luminance, which is what legibility follows.

import type { DecodedImage } from '../engine/core/image.ts';
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
  split: [90, -110],
  duotone: [180, 0],
  mono: [0, 0],
};

export interface GeneratedPalette {
  readonly palette: Palette;
  /** Plain-language notes for the decision log, including any contrast fix. */
  readonly notes: readonly string[];
  readonly data: Readonly<Record<string, unknown>>;
}

/** What a role takes from its source, where the source is more than one hue. */
interface RoleHue {
  readonly h: number;
  readonly s: number;
}

/** The role table: every role's colour from the base hue and saturation. Shared by both strategies. */
function roleColours(spec: TemplatePalette, style: StyleVector, hue: number, saturation: number, picked: { readonly secondary?: RoleHue; readonly accent?: RoleHue } = {}): Record<PaletteRole, string> {
  const [offsetB, offsetC] = HARMONY[spec.harmony];
  const light = spec.mode === 'light';

  // Darker tracks sit on darker grounds; a light template's paper gets brighter with brighter tracks.
  const [b0, b1] = spec.background;
  const backgroundL = light ? b0 + (b1 - b0) * style.brightness : b1 - (b1 - b0) * style.darkness;

  const roles: Record<PaletteRole, Hsl> = {
    primary: { h: hue, s: saturation, l: light ? 0.42 : 0.58 },
    secondary: { h: picked.secondary?.h ?? hue + offsetB, s: picked.secondary?.s ?? saturation * 0.9, l: light ? 0.38 : spec.harmony === 'mono' ? 0.4 : 0.55 },
    accent: { h: picked.accent?.h ?? hue + offsetC, s: picked.accent?.s ?? saturation, l: light ? 0.48 : spec.harmony === 'duotone' || spec.harmony === 'mono' ? 0.74 : 0.62 },
    glow: { h: hue, s: Math.min(1, saturation + 0.05), l: light ? 0.55 : 0.72 },
    background: { h: hue + (spec.harmony === 'duotone' ? offsetB : 0), s: light ? 0.12 : saturation * 0.45, l: backgroundL },
    text: light ? { h: hue, s: 0.25, l: 0.1 } : { h: hue, s: 0.2, l: 0.95 },
    textShadow: light ? { h: hue, s: 0.1, l: 0.97 } : { h: hue, s: 0.3, l: 0.03 },
  };
  return Object.fromEntries(PALETTE_ROLES.map((role) => [role, hslToHex(roles[role])])) as Record<PaletteRole, string>;
}

/** Contrast comes last and always wins (§5.3): both strategies end here. Mutates `hex`; returns the notes. */
function enforceContrast(spec: TemplatePalette, hex: Record<PaletteRole, string>): string[] {
  const notes: string[] = [];
  const light = spec.mode === 'light';
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
  return notes;
}

const toPalette = (hex: Record<PaletteRole, string>): Palette => ({ colors: PALETTE_ROLES.map((role) => hex[role]), roles: Object.fromEntries(PALETTE_ROLES.map((role, i) => [role, i])), extra: {} });

/**
 * A palette from the template's rule and the track's style. `seed` is the palette aspect's own
 * seed, so a palette lock reproduces it and a reroll moves only the hue within `hueJitter`.
 */
export function generatePalette(spec: TemplatePalette, style: StyleVector, seed: number, hueJitter: number): GeneratedPalette {
  const axis = style[spec.baseHue.from];
  const [h0, h1] = spec.baseHue.range;
  const jitter = (random01(seed, 'palette', 'hue') * 2 - 1) * hueJitter;
  const hue = wrap(h0 + (h1 - h0) * axis + jitter);
  const saturation = spec.saturation[0] + (spec.saturation[1] - spec.saturation[0]) * style.energy;
  const light = spec.mode === 'light';
  const hex = roleColours(spec, style, hue, saturation);

  for (const [role, color] of Object.entries(spec.colors)) {
    if ((PALETTE_ROLES as readonly string[]).includes(role) && /^#[0-9a-f]{6}$/i.test(color) && spec.strategy === 'fixed') {
      hex[role as PaletteRole] = color.toLowerCase();
    }
  }

  const notes = enforceContrast(spec, hex);
  notes.unshift(`${hueName(hex.primary)} primary (hue ${Math.round(hue)}° from ${spec.baseHue.from} ${axis.toFixed(2)}), ${spec.harmony} harmony, ${light ? 'light' : 'dark'} ground.`);
  return {
    palette: toPalette(hex),
    notes,
    data: { hue: Math.round(hue), saturation: Number(saturation.toFixed(3)), textContrast: Number(contrastRatio(hex.text, hex.background).toFixed(2)) },
  };
}

// ---------------------------------------------------------------------------
// derive-from-image
// ---------------------------------------------------------------------------

/** One dominant colour of a picture. */
export interface ImageColour extends Hsl {
  readonly hex: string;
  /** Its share of the saturation-weighted pixels, 0..1. */
  readonly share: number;
}

/** About this many pixels are read, whatever the picture's size. */
const IMAGE_SAMPLES = 4096;
const IMAGE_CLUSTERS = 6;
const IMAGE_ITERATIONS = 12;
/** A pixel with no colour at all still counts a little: an image of greys has a dominant grey. */
const NEUTRAL_WEIGHT = 0.04;
/** Below this a colour has no hue worth following. */
const CHROMATIC_SATURATION = 0.15;
/** A colour of the picture stands in for the harmony's hue when it is this close, in degrees. */
const HARMONY_TOLERANCE = 30;

/**
 * The picture's dominant colours, strongest first: weighted k-means in sRGB over a fixed-stride
 * sample. A pixel's weight is its chroma, so a vivid object beats the larger grey around it, which
 * is what makes the result a palette rather than an average. Pure: the same pixels and seed give
 * the same colours. Empty when no pixel is visible.
 */
export function dominantColours(image: DecodedImage, seed: number): ImageColour[] {
  const { width, height, pixels } = image;
  const stride = Math.max(1, Math.ceil(Math.sqrt((width * height) / IMAGE_SAMPLES)));
  const rgb: number[] = [];
  const weights: number[] = [];
  for (let y = stride >> 1; y < height; y += stride) {
    for (let x = stride >> 1; x < width; x += stride) {
      const at = (y * width + x) * 4;
      if ((pixels[at + 3] as number) < 128) continue;
      const r = (pixels[at] as number) / 255;
      const g = (pixels[at + 1] as number) / 255;
      const b = (pixels[at + 2] as number) / 255;
      rgb.push(r, g, b);
      weights.push(NEUTRAL_WEIGHT + Math.max(r, g, b) - Math.min(r, g, b));
    }
  }
  const count = weights.length;
  if (count === 0) return [];

  const distance = (i: number, c: readonly number[]) => {
    const dr = (rgb[i * 3] as number) - (c[0] as number);
    const dg = (rgb[i * 3 + 1] as number) - (c[1] as number);
    const db = (rgb[i * 3 + 2] as number) - (c[2] as number);
    return dr * dr + dg * dg + db * db;
  };
  // Seeded k-means++: each further centre is drawn in proportion to its distance from the rest.
  const centres: number[][] = [];
  for (let k = 0; k < IMAGE_CLUSTERS; k += 1) {
    let total = 0;
    const reach = new Float64Array(count);
    for (let i = 0; i < count; i += 1) {
      let nearest = centres.length === 0 ? 1 : Infinity;
      for (const c of centres) nearest = Math.min(nearest, distance(i, c));
      reach[i] = nearest * (weights[i] as number);
      total += reach[i] as number;
    }
    if (total <= 0) break;
    let pick = random01(seed, 'palette', 'cluster', k) * total;
    let chosen = count - 1;
    for (let i = 0; i < count; i += 1) {
      pick -= reach[i] as number;
      if (pick < 0) {
        chosen = i;
        break;
      }
    }
    centres.push([rgb[chosen * 3] as number, rgb[chosen * 3 + 1] as number, rgb[chosen * 3 + 2] as number]);
  }

  const mass = new Float64Array(centres.length);
  for (let iteration = 0; iteration < IMAGE_ITERATIONS; iteration += 1) {
    const sums = centres.map(() => [0, 0, 0]);
    mass.fill(0);
    for (let i = 0; i < count; i += 1) {
      let best = 0;
      let bestDistance = Infinity;
      centres.forEach((c, k) => {
        const d = distance(i, c);
        if (d < bestDistance) {
          bestDistance = d;
          best = k;
        }
      });
      const w = weights[i] as number;
      const sum = sums[best] as number[];
      sum[0] = (sum[0] as number) + (rgb[i * 3] as number) * w;
      sum[1] = (sum[1] as number) + (rgb[i * 3 + 1] as number) * w;
      sum[2] = (sum[2] as number) + (rgb[i * 3 + 2] as number) * w;
      mass[best] = (mass[best] as number) + w;
    }
    centres.forEach((c, k) => {
      const m = mass[k] as number;
      if (m > 0) (sums[k] as number[]).forEach((v, channel) => (c[channel] = v / m));
    });
  }

  const totalMass = mass.reduce((sum, m) => sum + m, 0);
  const channel = (v: number) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0');
  return centres
    .flatMap((c, k): ImageColour[] => {
      const share = (mass[k] as number) / totalMass;
      if (share <= 0) return [];
      const hex = `#${channel(c[0] as number)}${channel(c[1] as number)}${channel(c[2] as number)}`;
      return [{ ...hexToHsl(hex), hex, share }];
    })
    .sort((a, b) => b.share - a.share || (a.hex < b.hex ? -1 : 1));
}

const hueGap = (a: number, b: number) => {
  const d = Math.abs(wrap(a) - wrap(b));
  return Math.min(d, 360 - d);
};

/**
 * A palette from a picture (§5.3). `seed` chooses among the colours strong enough to lead, so a
 * reroll can bring a different colour of the same picture forward. Null when no pixel is visible.
 */
export function derivePalette(spec: TemplatePalette, image: DecodedImage, imageName: string, style: StyleVector, seed: number): GeneratedPalette | null {
  const colours = dominantColours(image, seed);
  if (colours.length === 0) return null;
  const chromatic = colours.filter((c) => c.s >= CHROMATIC_SATURATION && c.l > 0.08 && c.l < 0.95);
  const pool = chromatic.length > 0 ? chromatic : colours;
  const strongest = (pool[0] as ImageColour).share;
  const leaders = pool.filter((c) => c.share >= strongest * 0.5);
  const lead = leaders[Math.floor(random01(seed, 'palette', 'lead') * leaders.length)] as ImageColour;

  const hue = lead.h;
  const [offsetB, offsetC] = HARMONY[spec.harmony];
  /** The picture's own colour nearest the harmony's hue, when the rule leaves room for one. */
  const near = (offset: number): RoleHue | undefined => {
    if (offset === 0 || chromatic.length === 0) return undefined;
    const target = hue + offset;
    const found = pool.filter((c) => c !== lead && hueGap(c.h, target) <= HARMONY_TOLERANCE)
      .sort((a, b) => hueGap(a.h, target) - hueGap(b.h, target) || b.share - a.share)[0];
    return found === undefined ? undefined : { h: found.h, s: found.s };
  };
  const secondary = near(offsetB);
  const accent = near(offsetC);
  const hex = roleColours(spec, style, hue, lead.s, { ...(secondary === undefined ? {} : { secondary }), ...(accent === undefined ? {} : { accent }) });

  const notes = enforceContrast(spec, hex);
  notes.unshift(`${hueName(hex.primary)} primary from "${imageName}" (${Math.round(lead.share * 100)}% of the colour in it), ${spec.harmony} harmony.`);
  if (chromatic.length === 0) notes.push(`"${imageName}" has almost no colour, so the palette is close to neutral.`);
  return {
    palette: toPalette(hex),
    notes,
    data: { hue: Math.round(hue), saturation: Number(lead.s.toFixed(3)), textContrast: Number(contrastRatio(hex.text, hex.background).toFixed(2)), image: imageName, dominant: colours.map((c) => c.hex) },
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
