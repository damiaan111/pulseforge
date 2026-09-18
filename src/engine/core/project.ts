// The resolved project snapshot the engine renders (a P0 subset of PROJECT.md §7).
// The full document, its migrations and undo live in src/project/; the engine only
// ever sees an immutable snapshot like this one.

import type { ImageAssetRef } from './image.ts';
import type { FontAssetRef } from './text.ts';
import type { LayerTransform } from './layout.ts';
import type { ModulationBinding } from './modulation.ts';
import type { Rational } from './time.ts';

export type BlendMode = 'normal' | 'add' | 'screen';

/**
 * When a layer is on screen, in timeline ticks (PROJECT.md §8.10). A layer is drawn on the
 * frames whose start tick falls in [inTicks, outTicks); `outTicks: null` means "to the end".
 * Absent means "always", so a project built without time ranges behaves exactly as before.
 */
export interface LayerTimeRange {
  readonly inTicks: number;
  readonly outTicks: number | null;
}

/** One entry in a layer's or the project's effect chain (module-spec §8). */
export interface EffectSpec {
  readonly id: string;
  readonly module: string;
  readonly enabled: boolean;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface LayerSpec {
  readonly id: string;
  readonly module: string;
  readonly enabled: boolean;
  readonly opacity: number;
  readonly blend: BlendMode;
  readonly params: Readonly<Record<string, unknown>>;
  readonly timeRange?: LayerTimeRange;
  /**
   * Placement on the canvas, with any per-aspect override already applied. Absent means the
   * identity transform, which composites 1:1 — the path P0 projects take.
   */
  readonly transform?: LayerTransform;
  /** Bindings targeting this layer's parameters (modulation-spec §1). */
  readonly modulations?: readonly ModulationBinding[];
  /** Post-process chain on this layer alone, bottom of the list first. */
  readonly effects?: readonly EffectSpec[];
}

/** Frame-start-tick membership; the one place the range rule is spelled out. */
export function layerIsLive(range: LayerTimeRange | undefined, tick: number): boolean {
  if (range === undefined) return true;
  if (tick < range.inTicks) return false;
  return range.outTicks === null || tick < range.outTicks;
}

export interface RenderProject {
  readonly schemaVersion: 0;
  /** Master PRNG seed. */
  readonly seed: number;
  readonly canvas: {
    readonly width: number;
    readonly height: number;
    readonly fps: Rational;
    /** sRGB hex, opaque. */
    readonly background: string;
  };
  /** How the audio sits on the timeline (PROJECT.md §8.10). */
  readonly audio: {
    readonly leadInTicks: number;
    readonly clipInTicks: number;
  };
  /** Bottom → top. */
  readonly layers: readonly LayerSpec[];
  /**
   * Timeline length. Modulation needs it: `progress` and `ramp` are fractions of it, and
   * auto-calibration and precomputed envelopes are computed across it (modulation-spec §5, §7).
   * Absent means "unknown", which leaves those sources at their start value.
   */
  readonly durationTicks?: number;
  /** Bindings targeting the global effect chain. */
  readonly globalModulations?: readonly ModulationBinding[];
  /** Post-process chain over the finished composite. */
  readonly globalEffects?: readonly EffectSpec[];
  /** Asset id → what it is. Pixels are registered with the engine separately, by hash (image.ts). */
  readonly assets?: Readonly<Record<string, ImageAssetRef | FontAssetRef>>;
}
