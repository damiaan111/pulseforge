// MilkDrop as the engine sees it. The renderer is Butterchurn, a browser library with a WebGL2
// context of its own, so it stays on the far side of this interface as glyph rasterisation does
// (core/text.ts): the module asks for a picture of a frame, and the host supplies it.
//
// A MilkDrop preset draws each frame on top of the last, so a frame depends on every frame before
// it. Determinism therefore rests on three things the host must do: seed all randomness from
// `seed`, step exactly one fixed `1/fps` per frame, and on a final render reach a frame by stepping
// to it from the start, never by jumping (export-spec §8).

/** Samples per frame, as Butterchurn's analyser takes them. */
export const MILKDROP_SAMPLES = 1024;
/** The `waveform` feature's rate: enough to carry the treble, a quarter of the size of 48 kHz in memory. */
export const WAVEFORM_RATE = 22_050;

export interface MilkdropRequest {
  /** One per layer: the state a preset has built up lives with it. */
  readonly owner: object;
  readonly preset: string;
  readonly width: number;
  readonly height: number;
  readonly frameIndex: number;
  /** Seconds a frame lasts. */
  readonly frameSeconds: number;
  readonly seed: number;
  /** 'final' reaches a frame exactly; the others may jump, and settle within a moment. */
  readonly exact: boolean;
  /** The audio a given frame hears: `MILKDROP_SAMPLES` bytes centred on 128. Called for every frame stepped through. */
  readonly samples: (frameIndex: number) => Uint8Array;
}

export interface MilkdropHost {
  hasPreset(name: string): boolean;
  /** Synchronous: presets are loaded before rendering, so a frame never waits. */
  frame(request: MilkdropRequest): TexImageSource;
  /** What the preset on this layer could not run; null when it runs whole. */
  problem(owner: object): string | null;
  /** The layer is gone: free its context. Browsers allow only a handful at once. */
  release(owner: object): void;
}
