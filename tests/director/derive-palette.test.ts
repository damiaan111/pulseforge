// `derive-from-image` (auto-director-spec §5.3): dominant colours by saturation-weighted clustering,
// then the harmony rule and role contrast; and in direct(), the picture the palette comes from is
// the one the backdrop shows.

import { describe, expect, it } from 'vitest';

import { direct } from '../../src/director/direct.ts';
import { contrastRatio, derivePalette, dominantColours, generatePalette, hexToHsl } from '../../src/director/palette.ts';
import { parseTemplate, type Template, type TemplatePalette } from '../../src/director/template.ts';
import type { DecodedImage } from '../../src/engine/core/image.ts';
import type { AssetRef, ModuleLayer } from '../../src/project/document.ts';
import { builtinTemplateTexts, builtinTemplates, directorInput, songDocument } from './fixture.ts';

const STYLE = { tempo: 0.5, energy: 0.5, brightness: 0.5, density: 0.5, organic: 0.5, vocalWeight: 0.5, dynamics: 0.5, darkness: 0.5, unmeasured: [] };

/** Pixels from a function of (x, y) → [r, g, b] or [r, g, b, a]. */
function image(width: number, height: number, at: (x: number, y: number) => readonly number[]): DecodedImage {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a = 255] = at(x, y) as [number, number, number, number?];
      pixels.set([r, g, b, a], (y * width + x) * 4);
    }
  }
  return { width, height, pixels };
}

function spec(harmony: TemplatePalette['harmony'] = 'complementary'): TemplatePalette {
  return { ...builtinTemplates().find((t) => t.id === 'tpl.neon.pulse')!.palette, strategy: 'derive-from-image', harmony };
}

const hueOf = (hex: string) => hexToHsl(hex).h;
const gap = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

describe('dominantColours', () => {
  // A quarter vivid red on three quarters of mid grey.
  const redOnGrey = image(64, 64, (x, y) => (x < 32 && y < 32 ? [230, 20, 30] : [128, 128, 128]));

  it('ranks a vivid minority above the larger grey: weighted by saturation, not by area', () => {
    const [first] = dominantColours(redOnGrey, 1);
    expect(gap(first!.h, 357)).toBeLessThan(6);
    expect(first!.s).toBeGreaterThan(0.7);
  });

  it('is a pure function of the pixels and the seed', () => {
    expect(dominantColours(redOnGrey, 9)).toEqual(dominantColours(redOnGrey, 9));
  });

  it('reads a large picture at a fixed stride: the same colours in far fewer samples', () => {
    const big = image(4000, 3000, (x) => (x < 1000 ? [20, 60, 240] : [20, 200, 90]));
    const colours = dominantColours(big, 3);
    expect(colours.some((c) => gap(c.h, hueOf('#143cf0')) < 8)).toBe(true);
    expect(colours.some((c) => gap(c.h, hueOf('#14c85a')) < 8)).toBe(true);
  });

  it('ignores transparent pixels, and returns nothing for an invisible picture', () => {
    const halfClear = image(32, 32, (x) => (x < 16 ? [255, 0, 0, 0] : [0, 0, 255, 255]));
    expect(gap(dominantColours(halfClear, 1)[0]!.h, 240)).toBeLessThan(2);
    expect(dominantColours(image(8, 8, () => [255, 0, 0, 0]), 1)).toEqual([]);
  });
});

describe('derivePalette', () => {
  const twoColours = image(64, 64, (x) => (x < 40 ? [235, 40, 150] : [30, 215, 150]));

  it('stores hex, leads with the picture\'s colour and keeps the contrast rule', () => {
    const made = derivePalette(spec(), twoColours, 'cover.png', STYLE, 4)!;
    expect(made.palette.colors.every((c) => /^#[0-9a-f]{6}$/.test(c))).toBe(true);
    const { colors, roles } = made.palette;
    expect(contrastRatio(colors[roles['text']!]!, colors[roles['background']!]!)).toBeGreaterThanOrEqual(spec().minTextContrast - 0.01);
    expect(contrastRatio(colors[roles['primary']!]!, colors[roles['background']!]!)).toBeGreaterThanOrEqual(2.99);
    expect(made.notes[0]).toContain('cover.png');
  });

  it('uses the picture\'s own colour where the harmony lands near one, the rule\'s hue where none does', () => {
    // Pink and green sit about 165 degrees apart: within the tolerance of complementary (180).
    const palette = derivePalette(spec('complementary'), twoColours, 'x', STYLE, 4)!.palette;
    const lead = hueOf(palette.colors[0]!);
    const pink = hueOf('#eb2896');
    const teal = hueOf('#1ed796');
    const secondary = hueOf(palette.colors[1]!);
    expect(gap(secondary, gap(lead, pink) < gap(lead, teal) ? teal : pink)).toBeLessThan(6);
    // One colour only: the rule is enforced as it stands.
    const single = derivePalette(spec('complementary'), image(16, 16, () => [20, 60, 240]), 'x', STYLE, 4)!.palette;
    expect(gap(hueOf(single.colors[1]!), (hueOf(single.colors[0]!) + 180) % 360)).toBeLessThan(6);
  });

  it('a seed may bring a different strong colour forward, never a weak one', () => {
    const hues = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((seed) => Math.round(hueOf(derivePalette(spec(), twoColours, 'x', STYLE, seed)!.palette.colors[0]!) / 30)));
    expect(hues.size).toBe(2);
  });

  it('says so when the picture has no colour to give', () => {
    const grey = derivePalette(spec(), image(16, 16, (x) => (x < 8 ? [40, 40, 40] : [200, 200, 200])), 'grey.png', STYLE, 1)!;
    expect(grey.notes.join(' ')).toContain('almost no colour');
  });

  it('is null for an invisible picture', () => {
    expect(derivePalette(spec(), image(8, 8, () => [0, 0, 0, 0]), 'x', STYLE, 1)).toBeNull();
  });

  it('the shared contrast tail leaves a fixed palette\'s colours as written', () => {
    const fixed: TemplatePalette = { ...spec(), strategy: 'fixed', colors: { accent: '#123456' } };
    expect(generatePalette(fixed, STYLE, 1, 0).palette.colors).toContain('#123456');
  });
});

describe('direct() with a derived palette', () => {
  const asset = (n: number, name: string): AssetRef => ({ id: `0000000000A00000000000000${n}`, kind: 'image', path: `C:/pics/${name}`, hash: `hash${n}`, size: 1, name, extra: {} });
  /** Neon Pulse, but its only backdrop is the image and its colours come from it. */
  function imageTemplate(): Template {
    const raw = structuredClone(builtinTemplateTexts().find((t) => t.file === 'neon-pulse.json')!.raw) as { id: string; palette: { strategy: string }; slots: { id: string; candidates?: { label?: string }[] }[] };
    raw.id = 'tpl.test.image';
    raw.palette.strategy = 'derive-from-image';
    const backdrop = raw.slots.find((s) => s.id === 'BACKDROP')!;
    backdrop.candidates = backdrop.candidates!.filter((c) => c.label === 'Image');
    return parseTemplate(raw).template;
  }
  const red = image(16, 16, () => [230, 30, 30]);
  const blue = image(16, 16, () => [30, 30, 230]);
  const images = new Map([['hash1', red], ['hash2', blue]]);
  const assets = [asset(1, 'red.png'), asset(2, 'blue.png')];

  it('takes the palette from the picture the backdrop layer shows, on every seed', () => {
    const seen = new Set<string>();
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const document = songDocument({ assets });
      const { document: made } = direct({ ...directorInput(document, [imageTemplate()]), images }, { seed, templateId: 'tpl.test.image' });
      const backdrop = made.layers.find((l): l is ModuleLayer => l.kind === 'module' && l.name === 'Backdrop')!;
      const shown = assets.find((a) => a.id === backdrop.params['image'])!;
      seen.add(shown.name);
      expect(gap(hueOf(made.palette.colors[0]!), shown.name === 'red.png' ? 0 : 240), `seed ${seed}`).toBeLessThan(4);
    }
    // Otherwise the test would not have tested agreement.
    expect(seen.size).toBe(2);
  });

  it('falls back to the track when there are no pixels, and flags it', () => {
    const document = songDocument({ assets });
    const { log } = direct(directorInput(document, [imageTemplate()]), { seed: 1, templateId: 'tpl.test.image' });
    const fallback = log.filter((e) => e.data['imageFallback'] === true);
    expect(fallback).toHaveLength(1);
    expect(fallback[0]!.text).toContain('not available as pixels');
  });

  it('flags a chosen picture with nothing visible in it, instead of quietly ignoring it', () => {
    const { log } = direct({ ...directorInput(), colourImage: { name: 'clear.png', image: image(8, 8, () => [0, 0, 0, 0]) } }, { seed: 1, templateId: 'tpl.neon.pulse' });
    expect(log.filter((e) => e.data['imageFallback'] === true)[0]?.text).toContain('clear.png');
  });

  it('a chosen colour image leads a generated palette, and a fixed one says it was not used', () => {
    const colourImage = { name: 'cover', image: blue };
    const { document } = direct({ ...directorInput(), colourImage }, { seed: 1, templateId: 'tpl.neon.pulse' });
    expect(gap(hueOf(document.palette.colors[0]!), 240)).toBeLessThan(4);
    const fixedTemplate = { ...imageTemplate(), palette: { ...imageTemplate().palette, strategy: 'fixed' as const } };
    const fixed = direct({ ...directorInput(songDocument({ assets }), [fixedTemplate]), colourImage }, { seed: 1, templateId: 'tpl.test.image' });
    expect(fixed.log.some((e) => e.step === 'palette' && e.text.includes('was not used'))).toBe(true);
  });
});
