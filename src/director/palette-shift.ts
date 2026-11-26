// Palette shifts (auto-director-spec §6): at a chorus the colours trade places, interpolating
// between role assignments rather than cutting.
//
// Sections never reach the engine, so a shift is written as ordinary colour keyframes on the
// parameters that link to a role: `@primary` until the boundary, `@accent` after it. The keys stay
// links, so editing the palette recolours them too, and the snapshot resolves them like any other
// link. Two colours trade rather than one moving, which is what keeps them apart in the new state.
//
// Everything here is arithmetic on the arranged sections; direct.ts decides which parameters shift.

import { TICKS_PER_SECOND, secondsToTicks } from '../engine/core/time.ts';
import { sampleTrack } from '../engine/core/automation.ts';
import type { Palette } from '../project/document.ts';
import { resolveRole, type PaletteRole } from '../project/palette.ts';
import { contrastRatio } from './palette.ts';
import type { ShiftRole } from './template.ts';

/** Colours cross over this long, centred on the boundary: the same as the intensity ramp. */
const SHIFT_RAMP_SECONDS = 0.75;
/** Points tested along a crossing. */
const CONTRAST_STEPS = 8;

export interface ShiftSection {
  readonly startSeconds: number;
  readonly paletteShift: ShiftRole | null;
}

export interface RoleKey {
  readonly ticks: number;
  readonly role: PaletteRole;
}

/** The role a parameter linked to `base` shows during a section with `shift`. */
export function shiftedRole(base: PaletteRole, shift: ShiftRole | null): PaletteRole {
  if (shift === null) return base;
  if (base === 'primary') return shift;
  return base === shift ? 'primary' : base;
}

/** The keys for a parameter linked to `base`: held in each section, crossing at the boundaries. Empty if it never moves. */
export function roleKeys(base: PaletteRole, sections: readonly ShiftSection[]): RoleKey[] {
  const first = sections[0];
  if (first === undefined) return [];
  const keys: RoleKey[] = [{ ticks: 0, role: shiftedRole(base, first.paletteShift) }];
  sections.forEach((section, i) => {
    if (i === 0) return;
    const before = shiftedRole(base, (sections[i - 1] as ShiftSection).paletteShift);
    const after = shiftedRole(base, section.paletteShift);
    if (before === after) return;
    keys.push({ ticks: secondsToTicks(section.startSeconds - SHIFT_RAMP_SECONDS / 2), role: before });
    keys.push({ ticks: secondsToTicks(section.startSeconds + SHIFT_RAMP_SECONDS / 2), role: after });
  });
  return keys.length === 1 ? [] : keys;
}

/**
 * The lowest contrast against `against` anywhere along these keys, crossings included, through the
 * engine's own colour interpolation: two colours that each pass can meet in a muddy middle that
 * does not. Null when a role has no colour.
 */
export function worstContrast(palette: Palette, keys: readonly RoleKey[], against: string): number | null {
  let worst = Infinity;
  for (let i = 0; i < keys.length; i += 1) {
    const a = resolveRole(palette, (keys[i] as RoleKey).role);
    if (a === undefined) return null;
    worst = Math.min(worst, contrastRatio(a, against));
    const next = keys[i + 1];
    if (next === undefined || next.role === (keys[i] as RoleKey).role) continue;
    const b = resolveRole(palette, next.role);
    if (b === undefined) return null;
    const crossing = [{ ticks: 0, value: a, easing: 'linear' as const }, { ticks: TICKS_PER_SECOND, value: b, easing: 'linear' as const }];
    for (let step = 1; step < CONTRAST_STEPS; step += 1) {
      worst = Math.min(worst, contrastRatio(sampleTrack(crossing, step / CONTRAST_STEPS, 'color') as string, against));
    }
  }
  return worst === Infinity ? null : worst;
}
