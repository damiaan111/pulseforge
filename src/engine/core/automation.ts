// Keyframe automation, evaluated (S1, docs/keyframes-spec.md; module-spec §5 step 3).
//
// A track is a target path and its keys; at time t it yields the value that REPLACES the base (and
// any aspect override) before modulation rides on top. Everything here is a pure function of the
// keys and t: no state carried between frames, and the Bézier easing is solved in a fixed number of
// steps, so preview and export agree to the bit (CLAUDE.md #1).
//
// Interpolation is by type: numbers ease, colours ease in linear light (the space the compositor
// works in, so a fade through the middle does not dip dark), and everything discrete holds until
// the next key.

import { linearToSrgb, parseHexColor, srgbToLinear } from './color.ts';
import { TICKS_PER_SECOND } from './time.ts';

export type Easing = 'linear' | 'hold' | 'easeIn' | 'easeOut' | 'easeInOut' | { readonly cubic: readonly [number, number, number, number] };

export interface AutomationKey {
  /** Timeline ticks. */
  readonly ticks: number;
  readonly value: number | boolean | string;
  /** How the value travels from this key to the next. */
  readonly easing: Easing;
}

export interface AutomationTrackSpec {
  readonly id: string;
  /** A path (module-spec §4): params, effect params, opacity, transform fields. */
  readonly target: string;
  /** Sorted by ticks. */
  readonly keyframes: readonly AutomationKey[];
}

/** How a value interpolates, from its parameter's type. */
export type AutomationKind = 'number' | 'color' | 'discrete';

const NAMED: Readonly<Record<'easeIn' | 'easeOut' | 'easeInOut', readonly [number, number, number, number]>> = {
  easeIn: [0.42, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
  easeInOut: [0.42, 0, 0.58, 1],
};

/** A cubic Bézier from (0,0) to (1,1) with handles (x1,y1), (x2,y2), evaluated at x = u. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number, u: number): number {
  const at = (p1: number, p2: number, s: number) => {
    const inv = 1 - s;
    return 3 * inv * inv * s * p1 + 3 * inv * s * s * p2 + s * s * s;
  };
  // x(s) is monotonic for x1, x2 in [0, 1]: bisection, always the same 40 steps (2^-40 ≈ 1e-12).
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2;
    if (at(x1, x2, mid) < u) lo = mid;
    else hi = mid;
  }
  return at(y1, y2, (lo + hi) / 2);
}

/** Eased progress through a segment; `u` in [0, 1]. Hold is handled by the caller. */
export function ease(easing: Easing, u: number): number {
  const x = Math.min(1, Math.max(0, u));
  if (easing === 'linear' || easing === 'hold') return x;
  const [x1, y1, x2, y2] = typeof easing === 'string' ? NAMED[easing] : easing.cubic;
  return cubicBezier(Math.min(1, Math.max(0, x1)), y1, Math.min(1, Math.max(0, x2)), y2, x);
}

function mixColor(a: string, b: string, e: number): string {
  const ca = parseHexColor(a);
  const cb = parseHexColor(b);
  if (ca === undefined || cb === undefined) return e < 1 ? a : b;
  const channel = (x: number, y: number) => {
    const v = linearToSrgb(srgbToLinear(x) + (srgbToLinear(y) - srgbToLinear(x)) * e);
    return Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  };
  return `#${channel(ca.r, cb.r)}${channel(ca.g, cb.g)}${channel(ca.b, cb.b)}`;
}

/**
 * The track's value at `t` seconds, or undefined when it has no keys. `kind` decides how two keys
 * blend; a value of the wrong kind for its neighbour holds rather than guessing.
 */
export function sampleTrack(keys: readonly AutomationKey[], t: number, kind: AutomationKind): number | boolean | string | undefined {
  const n = keys.length;
  if (n === 0) return undefined;
  const ticks = t * TICKS_PER_SECOND;
  const first = keys[0] as AutomationKey;
  if (n === 1 || ticks <= first.ticks) return first.value;
  const last = keys[n - 1] as AutomationKey;
  if (ticks >= last.ticks) return last.value;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((keys[mid] as AutomationKey).ticks <= ticks) lo = mid;
    else hi = mid;
  }
  const a = keys[lo] as AutomationKey;
  const b = keys[hi] as AutomationKey;
  if (a.easing === 'hold' || kind === 'discrete') return a.value;
  const span = b.ticks - a.ticks;
  const e = ease(a.easing, span <= 0 ? 1 : (ticks - a.ticks) / span);
  if (kind === 'number' && typeof a.value === 'number' && typeof b.value === 'number') return a.value + (b.value - a.value) * e;
  if (kind === 'color' && typeof a.value === 'string' && typeof b.value === 'string') return mixColor(a.value, b.value, e);
  return a.value;
}

/** Tracks by target, for the engine's per-frame lookups. Later tracks on the same target win. */
export function indexAutomation(tracks: readonly AutomationTrackSpec[] | undefined): ReadonlyMap<string, AutomationTrackSpec> {
  const map = new Map<string, AutomationTrackSpec>();
  for (const track of tracks ?? []) if (track.keyframes.length > 0) map.set(track.target, track);
  return map;
}
