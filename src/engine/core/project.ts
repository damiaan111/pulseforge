// The resolved project snapshot the engine renders (a P0 subset of PROJECT.md §7).
// The full document, its migrations and undo live in src/project/; the engine only
// ever sees an immutable snapshot like this one.

import type { Rational } from './time.ts';

export type BlendMode = 'normal' | 'add' | 'screen';

export interface LayerSpec {
  readonly id: string;
  readonly module: string;
  readonly enabled: boolean;
  readonly opacity: number;
  readonly blend: BlendMode;
  readonly params: Readonly<Record<string, unknown>>;
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
}
