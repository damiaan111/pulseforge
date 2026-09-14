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
import type { ParamSpec, ParamValues } from './params.ts';
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
   * The target the host has already bound and cleared for this module's result. A single-pass
   * module can ignore it and just draw; a multi-pass one binds other framebuffers along the
   * way and must come back to this one for its final pass.
   */
  readonly outputTarget: RenderTarget;
  readonly quality: 'preview' | 'final';
  /** Reports a problem for this frame's report. Never a reason to render differently between runs. */
  readonly warn: (message: string) => void;
}

/** A module instance draws into the currently bound framebuffer: linear light, premultiplied alpha. */
export interface ModuleInstance {
  resize(width: number, height: number): void;
  render(ctx: RenderContext, params: ParamValues): void;
  dispose(): void;
}

export interface ModuleDefinition {
  readonly manifest: ModuleManifest;
  create(gl: WebGL2RenderingContext): ModuleInstance;
}
