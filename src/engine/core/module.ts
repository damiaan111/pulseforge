// Module manifest and render contract (module-spec §2, §7).
//
// Hard rules, checked by the determinism harness and later by the conformance suite:
//  1. render is a pure function of (ctx, params): same inputs, same pixels.
//  2. No wall clock, no Math.random — time and randomness arrive through ctx.
//  3. No mutable state carried between frames (P0 modules are all stateless).
//  4. No network or filesystem — assets arrive through params.
//  5. quality 'preview' may lower fidelity, never change composition.
//  6. Allocate in init/resize, not per frame.

import type { AnalysisSet } from './analysis.ts';
import type { RenderLyrics } from './lyrics.ts';
import type { ImageTexture } from './image.ts';
import type { ParamSpec, ParamValues } from './params.ts';
import type { TextRasterizer } from './text.ts';
import type { VideoTexture } from './video.ts';
import type { Prng } from './prng.ts';
import type { RenderTarget, TargetPool } from '../render/targets.ts';
import type { Rational } from './time.ts';

export type ModuleKind = 'visualizer' | 'effect' | 'source' | 'scene3d' | 'text';

export interface ModuleManifest {
  /** Reverse-DNS, permanent, what projects store. */
  readonly id: string;
  readonly version: string;
  readonly kind: ModuleKind;
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly tags: readonly string[];
  readonly capabilities: {
    readonly needsAnalysis: boolean;
    readonly needsInput: boolean;
    readonly supportsAspect: boolean;
    readonly stateful: boolean;
    readonly gpuCost: 'low' | 'medium' | 'high';
    /**
     * The effect's output bleeds outside its input's bounds (module-spec §8) — blur, glow.
     * Declared now and not yet acted on: layer targets are canvas-sized, so a halo already has
     * the whole frame to spread into. Padding becomes real when targets are sized to layer
     * bounds instead, which is a later optimisation.
     */
    readonly expandsBounds?: boolean;
    /**
     * The effect reads its layer's depth (compositor-spec §7.3) — depth of field. Only 3D scene
     * layers have depth (D18), so on any other layer the effect is refused and reported rather
     * than run on a depth buffer that does not exist.
     */
    readonly needsDepth?: boolean;
  };
  readonly paramsSchemaVersion: number;
  readonly params: readonly ParamSpec[];
}

export interface RenderContext {
  readonly time: {
    /** Timeline seconds, derived from frameIndex. */
    readonly t: number;
    readonly frameIndex: number;
    readonly fps: Rational;
  };
  readonly canvas: {
    readonly width: number;
    readonly height: number;
    readonly aspect: number;
    /**
     * Pixels per unit for this layer's declared `scaleReference` (PROJECT.md §8.11,
     * module-spec §6). Any size in `space: 'canvas'` multiplies by this, which is what keeps
     * a line width or a logo the same physical size when the canvas shape changes.
     */
    readonly referenceScale: number;
  };
  readonly analysis: AnalysisSet;
  /** Seconds into the source audio for this frame (timeline mapping already applied). */
  readonly audioSeconds: number;
  readonly prng: Prng;
  readonly gl: WebGL2RenderingContext;
  /**
   * Scratch targets for multi-pass effects (compositor-spec §4). Always released back before
   * `render` returns — the pool is the host's, and holding one starves the next layer.
   */
  readonly targets: TargetPool;
  /**
   * The layer's rendered texture, for `effect` modules only (module-spec §8). An effect must
   * not write to its input. Null for every other kind.
   */
  readonly input: RenderTarget | null;
  /**
   * The layer's depth, for effects on a 3D scene layer (compositor-spec §7.3). Null for every
   * other kind, and for effects on layers that have no depth — which a `needsDepth` effect never
   * sees, because the engine refuses it there.
   */
  readonly depth: LayerDepth | null;
  /**
   * The target the host has already bound and cleared for this module's result. A single-pass
   * module can ignore it and just draw; a multi-pass one binds other framebuffers along the
   * way and must come back to this one for its final pass.
   */
  readonly outputTarget: RenderTarget;
  readonly quality: 'preview' | 'final';
  /** Reports a problem for this frame's report. Never a reason to render differently between runs. */
  readonly warn: (message: string) => void;
  /**
   * The texture for an image asset, by the asset id an `asset` param holds. Undefined when the id
   * is not in the project, or the host has not registered its pixels — a missing file. The module
   * must then say so through `warn` and draw something visibly wrong, never nothing.
   */
  readonly image: (assetId: string) => ImageTexture | undefined;
  /**
   * The current frame of a video asset (M39). Undefined when the clip has no extracted frames yet
   * — a missing file, or a frame cache still building — which the module must report and draw
   * something visibly wrong for, never nothing.
   */
  readonly video: (assetId: string) => VideoTexture | undefined;
  /**
   * The layer's time range in timeline seconds, for entry and exit animations. `out` is null when
   * the layer runs to the end. Effects see their layer's range; the global chain sees 0 → null.
   */
  readonly layer: { readonly inSeconds: number; readonly outSeconds: number | null };
  /** Glyph rasterisation, when the host supplied it (core/text.ts). Undefined: text cannot be drawn. */
  readonly text: TextRasterizer | undefined;
  /** The project's timed lyrics (core/lyrics.ts), for lyrics layers; undefined when it has none. */
  readonly lyrics: RenderLyrics | undefined;
  /**
   * A font asset, by the id a `font` asset param holds. `''` resolves to the default font
   * (`{ hash: null }`). `missing` names why a chosen font cannot be used — not in the project, or
   * its file was never registered — and the module must say so and draw with the default.
   */
  readonly font: (assetId: string) => { readonly hash: string | null; readonly name: string; readonly missing?: string };
}

/**
 * A 3D layer's depth buffer (compositor-spec §7.3): standard GL window depth in 0..1, with the
 * camera's clip range so a consumer can turn it back into distance, and the vertical field of
 * view so a lens model can size its blur. Same orientation and size as the layer's colour.
 */
export interface LayerDepth {
  readonly texture: WebGLTexture;
  readonly near: number;
  readonly far: number;
  /** Vertical field of view in degrees. */
  readonly fov: number;
}

/** A module instance draws into the currently bound framebuffer: linear light, premultiplied alpha. */
export interface ModuleInstance {
  resize(width: number, height: number): void;
  render(ctx: RenderContext, params: ParamValues): void;
  /**
   * Depth for the frame just rendered — 3D scene modules only (`scene3d`). Valid until this
   * instance renders again, which is long enough for the layer's effect chain to read it.
   */
  depth?(): LayerDepth | null;
  dispose(): void;
}

export interface ModuleDefinition {
  readonly manifest: ModuleManifest;
  create(gl: WebGL2RenderingContext): ModuleInstance;
}
