// The project palette (M17, compositor-spec §9).
//
// The requirement is "reskin in one click": changing one colour restyles every layer that asked
// for it. That needs a *link*, not a copy, and the link has to live somewhere the document
// already round-trips.
//
// So a colour parameter either holds a literal `#rrggbb` or holds a **role link**, spelled
// `@primary`. It is still a plain string, which means:
//  - the document format needs no new type and old files still parse;
//  - a preset carries links rather than colours, so applying it adopts *this* project's palette
//    instead of importing a foreign one (compositor-spec §9);
//  - `@` is not a legal character anywhere in a hex colour, so a literal can never be mistaken
//    for a link, and a link is only recognised when it names a role this build knows.
//
// Links are resolved in `snapshot.ts`, on the way to the engine. The engine never learns that
// palettes exist — it receives a resolved hex like any other, which is what keeps headless
// rendering and the golden frames independent of the document model.

import type { Palette } from './document.ts';

/** The roles a module may ask for (compositor-spec §9). Order is the order the UI offers them. */
export const PALETTE_ROLES = ['primary', 'secondary', 'accent', 'glow', 'background', 'text', 'textShadow'] as const;
export type PaletteRole = (typeof PALETTE_ROLES)[number];

const ROLE_SET: ReadonlySet<string> = new Set(PALETTE_ROLES);

/** The stored form of a link to `role`. */
export function roleLink(role: PaletteRole): string {
  return `@${role}`;
}

/** The role a stored value links to, or undefined if it is a literal (or an unknown role). */
export function linkedRole(value: unknown): PaletteRole | undefined {
  if (typeof value !== 'string' || !value.startsWith('@')) return undefined;
  const role = value.slice(1);
  return ROLE_SET.has(role) ? (role as PaletteRole) : undefined;
}

/**
 * The colour a role currently resolves to, or undefined when the role is unassigned or points
 * past the end of the colour list. Undefined is a real answer, not an error: the module's own
 * default is used and the caller reports why (parse.ts says as much when it validates roles).
 */
export function resolveRole(palette: Palette, role: PaletteRole): string | undefined {
  const index = palette.roles[role];
  if (index === undefined || !Number.isInteger(index)) return undefined;
  return palette.colors[index];
}

/**
 * Resolves one stored parameter value. Literals and every non-colour value pass through
 * untouched — this is called on every parameter of every layer, so it has to be cheap and it
 * has to be safe on values that were never colours.
 */
export function resolvePaletteValue(
  palette: Palette,
  value: unknown,
): { readonly value: unknown; readonly unresolved?: PaletteRole } {
  const role = linkedRole(value);
  if (role === undefined) return { value };
  const colour = resolveRole(palette, role);
  // Unresolved: the value is removed so the module's declared default applies, and the caller
  // notes it. Passing "@primary" through would reach the engine as an invalid colour, which is
  // a worse story for the same outcome.
  return colour === undefined ? { value: undefined, unresolved: role } : { value: colour };
}

/** True when any parameter in the record links to a role. Used to decide whether to walk it. */
export function hasPaletteLinks(params: Readonly<Record<string, unknown>>): boolean {
  for (const value of Object.values(params)) if (linkedRole(value) !== undefined) return true;
  return false;
}
