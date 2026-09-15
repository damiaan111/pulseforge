// renderFrame(project, analysis, frameIndex) → one deterministic frame (PROJECT.md §5).
//
// Same project + same analysis + same frame index ⇒ byte-identical output, regardless of
// what was rendered before, in what order, or how long it took.

import type { AnalysisSet } from './core/analysis.ts';
import { parseHexColor, toLinearPremultiplied } from './core/color.ts';
import type { ModuleDefinition, ModuleInstance } from './core/module.ts';
import {
  IDENTITY_LAYER_TRANSFORM, isIdentityTransform, layerMatrix, referenceLength,
  type Mat3, type ScaleReference,
} from './core/layout.ts';
import {
  compileModulation, modulateValue, type ModulationIssue, type ModulationProgram,
} from './core/modulation.ts';
import { resolveParams, type ParamIssue, type ResolveOptions } from './core/params.ts';
import { createPrng, hash32 } from './core/prng.ts';
import { layerIsLive, type EffectSpec, type RenderProject } from './core/project.ts';
import type { EffectPass } from './render/effects.ts';
import { frameStartTick, frameTimeSeconds, ticksToSeconds, timelineToSourceSeconds } from './core/time.ts';
import { Compositor, type CompositeLayer, type OutputOptions } from './render/compositor.ts';
import { RenderSetupError, requireContextFeatures, type ContextInfo } from './render/gl.ts';
import { AsyncReadback, bytesPerFrame, readSync } from './render/readback.ts';
import { TargetPool, type RenderTarget } from './render/targets.ts';
import { Nv12Converter, nv12Bytes, nv12Supported } from './render/yuv.ts';
import { barsModule } from './modules/bars.ts';
import { curveModule } from './modules/spectrum-curve.ts';
import { orbModule } from './modules/orb.ts';
import { radialModule } from './modules/radial.ts';
import { spectrogramModule } from './modules/spectrogram.ts';
import { gridModule } from './modules/grid.ts';
import { wavesModule } from './modules/waves.ts';
import { tunnelModule } from './modules/tunnel.ts';
import { blobsModule } from './modules/blobs.ts';
import { particlesModule } from './modules/particles.ts';
import { bloomModule } from './modules/bloom.ts';
import { vignetteModule } from './modules/vignette.ts';
import { flashModule } from './modules/flash.ts';
import { testPatternModule } from './modules/test-pattern.ts';

export const BUILTIN_MODULES: readonly ModuleDefinition[] = [
  // Visualizers (M11), then effects (M12), then the test modules the validator uses.
  barsModule, radialModule, curveModule, orbModule, spectrogramModule,
  gridModule, wavesModule, tunnelModule, blobsModule, particlesModule,
  bloomModule, vignetteModule,
  testPatternModule, flashModule,
];

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
  /**
   * Problems found when the project's bindings were compiled — a source this build cannot
   * evaluate, a stem that was never analysed. Per project, not per frame, but repeated on
   * every frame report so a caller that only looks at one frame still sees them.
   */
  readonly modulationIssues: readonly ModulationIssue[];
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
  /**
   * Blits the last rendered frame to the canvas's default framebuffer, letterboxed to preserve
   * the project's aspect. For the live preview: export reads pixels back instead, and both
   * start from the same `output` target, so what is on screen is the frame that would be
   * written — at whatever resolution the preview is rendering (ui-spec §0.4).
   */
  present(drawingBufferWidth: number, drawingBufferHeight: number): void;
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

  /**
   * Compiling walks the whole track to precompute envelopes and percentile ranges, so it must
   * not happen per frame. A RenderProject is an immutable snapshot, so identity is a sound
   * cache key: a changed project is a different object.
   */
  let compiled: { project: RenderProject; analysis: AnalysisSet; program: ModulationProgram } | undefined;
  function programFor(project: RenderProject, analysis: AnalysisSet): ModulationProgram {
    if (compiled !== undefined && compiled.project === project && compiled.analysis === analysis) {
      return compiled.program;
    }
    const bindings = [
      ...project.layers.flatMap((layer) => layer.modulations ?? []),
      ...(project.globalModulations ?? []),
    ];
    const program = compileModulation({
      bindings,
      analysis,
      durationSeconds: ticksToSeconds(project.durationTicks ?? 0),
      seed: project.seed,
    });
    compiled = { project, analysis, program };
    return program;
  }

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
      const frameContext = {
        time: { t, frameIndex, fps },
        analysis,
        audioSeconds: timelineToSourceSeconds(t, project.audio),
        prng: createPrng(project.seed),
        gl,
        quality: options.quality,
        warn: (message: string) => warnings.push(message),
      };

      const program = programFor(project, analysis);
      const tick = frameStartTick(frameIndex, fps);

      /** Parameter keys under `prefix` that actually carry a binding (module-spec §4). */
      const modulationFor = (prefix: string): ResolveOptions => {
        const keys = new Set<string>();
        for (const target of program.targets.keys()) {
          if (target.startsWith(prefix)) keys.add(target.slice(prefix.length));
        }
        if (keys.size === 0) return {};
        return { modulated: keys, modulate: (key, base) => modulateValue(program, prefix + key, base, t) };
      };

      const canvasFor = (reference: ScaleReference) => ({
        width,
        height,
        aspect: width / height,
        referenceScale: referenceLength(width, height, reference),
      });

      /** Builds the effect passes for one chain, reporting anything it cannot run. */
      const buildEffects = (
        specs: readonly EffectSpec[],
        pathPrefix: string,
        owner: string,
        canvas: ReturnType<typeof canvasFor>,
      ): EffectPass[] => {
        const passes: EffectPass[] = [];
        for (const spec of specs) {
          if (!spec.enabled) continue;
          const definition = registry.get(spec.module);
          if (definition === undefined) {
            warnings.push(`${owner}: unknown effect module "${spec.module}" is not applied`);
            continue;
          }
          if (definition.manifest.kind !== 'effect') {
            warnings.push(`${owner}: module "${spec.module}" is a ${definition.manifest.kind}, not an effect; it is not applied`);
            continue;
          }
          const resolved = resolveParams(definition.manifest.params, spec.params, modulationFor(`${pathPrefix}${spec.id}.params.`));
          if (resolved.issues.length > 0) paramIssues.push({ layerId: `${owner}/${spec.id}`, issues: resolved.issues });
          const instance = instanceFor(spec.id, definition);
          passes.push({
            id: spec.id,
            draw: (input, target) => instance.render({ ...frameContext, canvas, targets: pool, input, outputTarget: target }, resolved.values),
          });
        }
        return passes;
      };

      const layers: CompositeLayer[] = [];
      for (const layer of project.layers) {
        if (!layer.enabled) continue;
        if (!layerIsLive(layer.timeRange, tick)) continue;
        const definition = registry.get(layer.module);
        if (definition === undefined) {
          // Preserved in the project, reported, never silently dropped (CLAUDE.md #4).
          warnings.push(`layer ${layer.id}: unknown module "${layer.module}" is not rendered`);
          continue;
        }
        // Step 4 of module-spec §5. Only keys that actually carry a binding go through the
        // evaluator; everything else resolves exactly as it did before modulation existed.
        const resolved = resolveParams(definition.manifest.params, layer.params, modulationFor(`layers.${layer.id}.params.`));
        if (resolved.issues.length > 0) paramIssues.push({ layerId: layer.id, issues: resolved.issues });
        const instance = instanceFor(layer.id, definition);

        // `referenceScale` is per layer: it follows the layer's own scaleReference, so a logo
        // on 'min' and a full-bleed background on 'max' each get the number they need.
        const transform = layer.transform ?? IDENTITY_LAYER_TRANSFORM;
        const canvas = canvasFor(transform.scaleReference);

        let inverseTransform: Mat3 | undefined;
        if (!isIdentityTransform(transform)) {
          const inverse = layerMatrix(transform, width, height).inverse;
          if (inverse === null) {
            // A zero or collapsed scale: the layer has no area, so it cannot be drawn. Said
            // out loud, because an invisible layer with no explanation is a long afternoon.
            warnings.push(`layer ${layer.id}: transform collapses the layer to zero area (scale ${transform.scaleX}×${transform.scaleY}); nothing is drawn`);
            continue;
          }
          inverseTransform = inverse;
        }

        layers.push({
          opacity: Math.min(1, Math.max(0, layer.opacity)),
          blend: layer.blend,
          draw: (target) => instance.render({ ...frameContext, canvas, targets: pool, input: null, outputTarget: target }, resolved.values),
          effects: buildEffects(layer.effects ?? [], `layers.${layer.id}.effects.`, `layer ${layer.id}`, canvas),
          ...(inverseTransform === undefined ? {} : { inverseTransform }),
        });
      }

      const background = toLinearPremultiplied(parseHexColor(project.canvas.background) ?? { r: 0, g: 0, b: 0, a: 1 });
      if (parseHexColor(project.canvas.background) === undefined) {
        warnings.push(`canvas background "${project.canvas.background}" is not a valid colour; using black`);
      }
      // The global chain has no layer of its own, so its sizes follow the smaller canvas
      // dimension — the reference that behaves the same in landscape and vertical.
      const globalEffects = buildEffects(project.globalEffects ?? [], 'global.effects.', 'global effects', canvasFor('min'));

      compositor.composite(output, { ...background, a: 1 }, layers, options.output, {
        frameIndex,
        noiseSeed: hash32(project.seed, 'output-dither'),
      }, globalEffects);
      nv12?.convert(output);

      return { frameIndex, t, warnings, paramIssues, modulationIssues: program.issues };
    },

    readOutputSync(into) {
      if (output === undefined) throw new Error('readOutputSync called before any frame was rendered');
      const expected = frameBytes(output.width, output.height);
      if (into.length !== expected) throw new RangeError(`readback buffer is ${into.length} bytes, expected ${expected}`);
      readPacked(output, into);
    },

    present(drawingBufferWidth, drawingBufferHeight) {
      if (output === undefined) throw new Error('present called before any frame was rendered');
      // Letterbox: fit the project's aspect inside the drawing buffer rather than stretching.
      // A preview that quietly changes the shape of the frame is worse than black bars, because
      // every composition decision is then made against the wrong picture.
      const scale = Math.min(drawingBufferWidth / output.width, drawingBufferHeight / output.height);
      const width = Math.max(1, Math.round(output.width * scale));
      const height = Math.max(1, Math.round(output.height * scale));
      const x = Math.floor((drawingBufferWidth - width) / 2);
      const y = Math.floor((drawingBufferHeight - height) / 2);

      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, output.framebuffer);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      gl.viewport(0, 0, drawingBufferWidth, drawingBufferHeight);
      gl.disable(gl.SCISSOR_TEST);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      // The output target is written bottom-up when flipY is off, which is the default screen
      // orientation, so source and destination rows map straight across.
      gl.blitFramebuffer(
        0, 0, output.width, output.height,
        x, y, x + width, y + height,
        gl.COLOR_BUFFER_BIT,
        scale === 1 ? gl.NEAREST : gl.LINEAR,
      );
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
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
