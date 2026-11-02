// Choosing a MilkDrop preset for a track.
//
// A preset says nothing about itself, so the director reads what was measured from a render of each
// (milkdrop-catalogue.ts), which also keeps out the ones that stay black or strobe. The measures sit
// on no common scale, so each becomes a rank among all the presets: 0.8 motion means busier than 80%
// of them, which can be held against a style axis directly. A busy track wants a busy preset, a dark
// one a dark preset, a dense one a full frame, and the hue leans towards the palette so the title
// does not fight the picture. The seed then picks among the closest, so rerolls differ.

import { random01 } from '../engine/core/prng.ts';
import type { StyleVector } from './digest.ts';
import { MILKDROP_MEASURES } from './milkdrop-catalogue.ts';

export interface MilkdropLook {
  readonly name: string;
  /** Ranks among all the measured presets, 0..1. */
  readonly brightness: number;
  readonly fill: number;
  readonly motion: number;
  /** Degrees. */
  readonly hue: number;
  readonly saturation: number;
}

/** How many of the best fits a seed chooses among. */
const SHORTLIST = 24;

function ranks(values: readonly number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const last = Math.max(1, sorted.length - 1);
  return values.map((value) => sorted.indexOf(value) / last);
}

const luma = ranks(MILKDROP_MEASURES.map((row) => row[1]));
const coverage = ranks(MILKDROP_MEASURES.map((row) => row[2]));
const motion = ranks(MILKDROP_MEASURES.map((row) => row[5]));
const LOOKS: readonly MilkdropLook[] = MILKDROP_MEASURES.map((row, i) => ({
  name: row[0],
  brightness: luma[i] as number,
  fill: coverage[i] as number,
  motion: motion[i] as number,
  hue: row[4],
  saturation: row[3],
}));

/** The presets the director may use: measured as usable, and installed on this machine. */
export function milkdropLooks(installed: readonly string[]): readonly MilkdropLook[] {
  const names = new Set(installed);
  return LOOKS.filter((look) => names.has(look.name));
}

/** How far a look is from a track; lower is closer. Axes that could not be measured are left out. */
export function lookDistance(look: MilkdropLook, style: StyleVector, paletteHue: number): number {
  const measured = (axis: keyof StyleVector) => !style.unmeasured.includes(axis);
  let distance = 0;
  if (measured('energy')) distance += 1.5 * Math.abs(look.motion - style.energy);
  if (measured('darkness')) distance += Math.abs(look.brightness - (1 - style.darkness));
  if (measured('density')) distance += 0.5 * Math.abs(look.fill - style.density);
  const turn = (Math.abs(look.hue - paletteHue) % 360) / 180;
  return distance + 0.4 * look.saturation * (turn > 1 ? 2 - turn : turn);
}

/** The look for one slot: the same inputs always give the same one. */
export function chooseLook(looks: readonly MilkdropLook[], style: StyleVector, paletteHue: number, seed: number, key: string): MilkdropLook | undefined {
  const shortlist = looks
    .map((look) => ({ look, distance: lookDistance(look, style, paletteHue) }))
    .sort((a, b) => a.distance - b.distance || (a.look.name < b.look.name ? -1 : 1))
    .slice(0, SHORTLIST);
  return shortlist[Math.floor(random01(seed, 'milkdrop', key) * shortlist.length)]?.look;
}
