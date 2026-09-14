// renderFrame(project, analysis, frameIndex) → one deterministic frame (PROJECT.md §5).
//
// Same project + same analysis + same frame index ⇒ byte-identical output, regardless of
// what was rendered before, in what order, or how long it took.

import type { AnalysisSet } from './core/analysis.ts';
import { parseHexColor, toLinearPremultiplied } from './core/color.ts';
import type { ModuleDefinition, ModuleInstance, RenderContext } from './core/module.ts';
import { resolveParams, type ParamIssue } from './core/params.ts';
import { createPrng, hash32 } from './core/prng.ts';
import type { RenderProject } from './core/project.ts';
import { frameTimeSeconds, timelineToSourceSeconds } from './core/time.ts';
import { Compositor, type CompositeLayer, type OutputOptions } from './render/compositor.ts';
import { RenderSetupError, requireContextFeatures, type ContextInfo } from './render/gl.ts';
import { AsyncReadback, bytesPerFrame, readSync } from './render/readback.ts';
import { TargetPool, type RenderTarget } from './render/targets.ts';
import { Nv12Converter, nv12Bytes, nv12Supported } from './render/yuv.ts';
import { barsModule } from './modules/bars.ts';
import { flashModule } from './modules/flash.ts';
import { testPatternModule } from './modules/test-pattern.ts';

export const BUILTIN_MODULES: readonly ModuleDefinition[] = [barsModule, testPatternModule, flashModule];

/** Recorded in render reports. Bump when rendering output changes. */
export const ENGINE_VERSION = '0.1.0-p0';

export interface EngineOptions {
  readonly quality: 'preview' | 'final';
  readonly output: OutputOptions;
  /**
   * Byte layout handed to readback. 'rgba': 4 bytes/pixel (RGBA8 or packed 10-bit).
   * 'nv12': BT.709 limited-range 4:2:0 converted on the GPU (8-bit only; width % 4 == 0).
   */
  readonly packing?: 'rgba' | 'nv12';
  readonly modules?: readonly ModuleDefinition[];
}

export interface FrameReport {
  readonly frameIndex: number;
  readonly t: number;
  readonly warnings: readonly string[];
  readonly paramIssues: readonly { readonly layerId: string; readonly issues: readonly ParamIssue[] }[];
}

/** Non-blocking readback of rendered frames, oldest first (export-spec §4.2). */
export interface FrameReadback {
  readonly depth: number;
  readonly bytesPerFrame: number;
  hasFreeSlot(): boolean;
  pendingCount(): number;
  /** Queues the most recently rendered frame. */
  submit(): void;
  oldestReady(): boolean;
  collectOldest(into: Uint8Array): void;
  dispose(): void;
}

export interface Engine {
  readonly context: ContextInfo;
  readonly options: EngineOptions;
  renderFrame(project: RenderProject, analysis: AnalysisSet, frameIndex: number): FrameReport;
  /**
   * Synchronous readback of the last frame, top-down; 4 bytes per pixel (RGBA8, or packed
   * 2-10-10-10 little-endian at 10 bits). Blocks on the GPU — the baseline for measurement.
   */
  readOutputSync(into: Uint8Array): void;
  /** A PBO ring for `width`×`height` output at this engine's bit depth. */
  createReadback(width: number, height: number, depth: number): FrameReadback;
  /**
   * The same interface over synchronous readPixels (depth 1: each frame is read straight into
   * the caller's buffer before the next renders). Measured against the PBO ring in P0, because
   * through ANGLE the "async" path is not necessarily faster.
   */
  createSyncReadback(width: number, height: number): FrameReadback;
  /** Peak simultaneous pooled render targets (render report). */
  readonly targetHighWaterMark: number;
  dispose(): void;
}

/**
 * 10-bit export reads RGB10_A2 as UNSIGNED_INT_2_10_10_10_REV. ES 3.0 lets the implementation
 * choose the second allowed read format, so confirm it before committing to a 10-bit render.
 */
function requireTenBitReadback(gl: WebGL2RenderingContext, pool: TargetPool): void {
  const probe = pool.acquire(4, 4, 'rgb10a2');
  gl.bindFramebuffer(gl.FRAMEBUFFER, probe.framebuffer);
  const format = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT) as number;
  const type = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE) as number;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  pool.release(probe);
  if (format !== gl.RGBA || type !== gl.UNSIGNED_INT_2_10_10_10_REV) {
    throw new RenderSetupError(
      `This GPU/driver cannot read back 10-bit frames (implementation read format 0x${format.toString(16)}, type 0x${type.toString(16)}). ` +
        'Export 8-bit H.264/HEVC instead, or update the GPU driver.',
    );
  }
}

export function createEngine(gl: WebGL2RenderingContext, options: EngineOptions): Engine {
  const context = requireContextFeatures(gl);
  const registry = new Map((options.modules ?? BUILTIN_MODULES).map((m) => [m.manifest.id, m]));
  const pool = new TargetPool(gl);
  const compositor = new Compositor(gl, pool);
  const instances = new Map<string, { moduleId: string; instance: ModuleInstance }>();
  let output: RenderTarget | undefined;

  function instanceFor(layerId: string, definition: ModuleDefinition): ModuleInstance {
    const existing = instances.get(layerId);
    if (existing !== undefined && existing.moduleId === definition.manifest.id) return existing.instance;
    existing?.instance.dispose();
    const instance = definition.create(gl);
    instances.set(layerId, { moduleId: definition.manifest.id, instance });
    return instance;
  }

  const outputFormat = options.output.bitDepth === 10 ? 'rgb10a2' : 'rgba8';
  if (outputFormat === 'rgb10a2') requireTenBitReadback(gl, pool);
  const packing = options.packing ?? 'rgba';
  if (packing === 'nv12' && (options.output.bitDepth !== 8 || !options.output.flipY)) {
    throw new RenderSetupError('NV12 packing needs 8-bit, top-down (flipY) output');
  }
  const nv12 = packing === 'nv12' ? new Nv12Converter(gl, pool) : undefined;
  const frameBytes = (width: number, height: number) =>
    packing === 'nv12' ? nv12Bytes(width, height) : bytesPerFrame({ width, height, bitDepth: options.output.bitDepth });
  const readPacked = (target: RenderTarget, into: Uint8Array) => {
    if (nv12 !== undefined) nv12.readSync(into);
    else readSync(gl, target, options.output.bitDepth, into);
  };

  return {
    context,
    options,

    get targetHighWaterMark() {
      return pool.highWaterMark;
    },

    renderFrame(project, analysis, frameIndex) {
      if (!Number.isSafeInteger(frameIndex) || frameIndex < 0) {
        throw new RangeError(`frameIndex must be a non-negative integer, got ${frameIndex}`);
      }
      const { width, height, fps } = project.canvas;
      if (nv12 !== undefined && !nv12Supported(width, height)) {
        throw new RenderSetupError(`NV12 export needs a width divisible by 4 and an even height, got ${width}×${height}`);
      }
      if (output === undefined || output.width !== width || output.height !== height) {
        if (output !== undefined) pool.release(output);
        output = pool.acquire(width, height, outputFormat);
        for (const { instance } of instances.values()) instance.resize(width, height);
      }

      const t = frameTimeSeconds(frameIndex, fps);
      const warnings: string[] = [];
      const paramIssues: { layerId: string; issues: readonly ParamIssue[] }[] = [];
      const ctx: RenderContext = {
        time: { t, frameIndex, fps },
        canvas: { width, height, aspect: width / height },
        analysis,
        audioSeconds: timelineToSourceSeconds(t, project.audio),
        prng: createPrng(project.seed),
        gl,
        quality: options.quality,
        warn: (message) => warnings.push(message),
      };

      const layers: CompositeLayer[] = [];
      for (const layer of project.layers) {
        if (!layer.enabled) continue;
        const definition = registry.get(layer.module);
        if (definition === undefined) {
          // Preserved in the project, reported, never silently dropped (CLAUDE.md #4).
          warnings.push(`layer ${layer.id}: unknown module "${layer.module}" is not rendered`);
          continue;
        }
        const resolved = resolveParams(definition.manifest.params, layer.params);
        if (resolved.issues.length > 0) paramIssues.push({ layerId: layer.id, issues: resolved.issues });
        const instance = instanceFor(layer.id, definition);
        layers.push({
          opacity: Math.min(1, Math.max(0, layer.opacity)),
          blend: layer.blend,
          draw: () => instance.render(ctx, resolved.values),
        });
      }

      const background = toLinearPremultiplied(parseHexColor(project.canvas.background) ?? { r: 0, g: 0, b: 0, a: 1 });
      if (parseHexColor(project.canvas.background) === undefined) {
        warnings.push(`canvas background "${project.canvas.background}" is not a valid colour; using black`);
      }
      compositor.composite(output, { ...background, a: 1 }, layers, options.output, {
        frameIndex,
        noiseSeed: hash32(project.seed, 'output-dither'),
      });
      nv12?.convert(output);

      return { frameIndex, t, warnings, paramIssues };
    },

    readOutputSync(into) {
      if (output === undefined) throw new Error('readOutputSync called before any frame was rendered');
      const expected = frameBytes(output.width, output.height);
      if (into.length !== expected) throw new RangeError(`readback buffer is ${into.length} bytes, expected ${expected}`);
      readPacked(output, into);
    },

    createReadback(width, height, depth) {
      if (nv12 !== undefined) {
        // Measured in P0: through ANGLE the PBO ring is slower than readPixels, so the NV12
        // path is only built synchronously. See docs/STATUS.md §5.
        throw new RenderSetupError('async readback is not implemented for NV12 packing; use createSyncReadback');
      }
      const ring = new AsyncReadback(gl, { width, height, bitDepth: options.output.bitDepth }, depth);
      return {
        depth,
        bytesPerFrame: bytesPerFrame(ring.format),
        hasFreeSlot: () => ring.hasFreeSlot(),
        pendingCount: () => ring.pendingCount(),
        submit() {
          if (output === undefined) throw new Error('readback.submit called before any frame was rendered');
          ring.submit(output);
        },
        oldestReady: () => ring.oldestReady(),
        collectOldest: (into) => ring.collectOldest(into),
        dispose: () => ring.dispose(),
      };
    },

    createSyncReadback(width, height) {
      let pending = false;
      return {
        depth: 1,
        bytesPerFrame: frameBytes(width, height),
        hasFreeSlot: () => !pending,
        pendingCount: () => (pending ? 1 : 0),
        submit() {
          if (output === undefined) throw new Error('readback.submit called before any frame was rendered');
          if (output.width !== width || output.height !== height) throw new RangeError(`readback is ${width}×${height} but the output is ${output.width}×${output.height}`);
          pending = true;
        },
        oldestReady: () => pending,
        collectOldest(into) {
          if (!pending || output === undefined) throw new Error('readback.collectOldest called with nothing pending');
          // Safe to read now: with one slot, the pump collects before it renders the next frame.
          readPacked(output, into);
          pending = false;
        },
        dispose() {},
      };
    },

    dispose() {
      for (const { instance } of instances.values()) instance.dispose();
      instances.clear();
      nv12?.dispose();
      compositor.dispose();
      pool.dispose();
    },
  };
}
