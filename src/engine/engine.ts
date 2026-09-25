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
  bindingLevels, compileModulation, modulateValue, type ModulationIssue, type ModulationProgram,
} from './core/modulation.ts';
import { resolveParams, type ParamIssue, type ParamValue, type ParamValues, type ResolveOptions } from './core/params.ts';
import { createPrng, hash32 } from './core/prng.ts';
import {
  isGroupSpec, layerIsLive, walkRenderModules, type AnyLayerSpec, type EffectSpec, type RenderProject,
} from './core/project.ts';
import type { EffectPass } from './render/effects.ts';
import { frameStartTick, frameTimeSeconds, ticksToSeconds, timelineToSourceSeconds } from './core/time.ts';
import { Compositor, type CompositeLayer, type OutputOptions } from './render/compositor.ts';
import { RenderSetupError, requireContextFeatures, type ContextInfo } from './render/gl.ts';
import { AsyncReadback, bytesPerFrame, readSync } from './render/readback.ts';
import { ImageStore } from './render/images.ts';
import { backgroundModule } from './modules/background.ts';
import type { DecodedImage } from './core/image.ts';
import type { TextRasterizer } from './core/text.ts';
import { lyricsModule } from './modules/lyrics.ts';
import { textModule } from './modules/text.ts';
import { logoModule } from './modules/logo.ts';
import { videoModule } from './modules/video.ts';
import { VideoStore, type VideoFrameSource } from './render/videos.ts';
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
import { blurModule } from './modules/blur.ts';
import { gradeModule } from './modules/grade.ts';
import { chromaticModule } from './modules/chromatic.ts';
import { grainModule } from './modules/grain.ts';
import { pixelateModule } from './modules/pixelate.ts';
import { scanlinesModule } from './modules/scanlines.ts';
import { kaleidoscopeModule } from './modules/kaleidoscope.ts';
import { glitchModule } from './modules/glitch.ts';
import { flashModule } from './modules/flash.ts';
import { testPatternModule } from './modules/test-pattern.ts';
import { shapesModule } from './modules/scene3d/shapes.ts';
import { terrainModule } from './modules/scene3d/terrain.ts';
import { cityModule } from './modules/scene3d/city.ts';
import { dofModule } from './modules/dof.ts';

export const BUILTIN_MODULES: readonly ModuleDefinition[] = [
  // Sources (M14), text (M16), visualizers (M11), 3D scenes (M37), then effects (M12), then the test modules the validator uses.
  backgroundModule, textModule, lyricsModule, logoModule, videoModule,
  barsModule, radialModule, curveModule, orbModule, spectrogramModule,
  gridModule, wavesModule, tunnelModule, blobsModule, particlesModule,
  // 3D scenes (M37).
  shapesModule, terrainModule, cityModule,
  bloomModule, vignetteModule, blurModule, gradeModule, chromaticModule,
  grainModule, pixelateModule, scanlinesModule, kaleidoscopeModule, glitchModule, dofModule,
  testPatternModule, flashModule,
];

/**
 * How deep groups may nest before the engine refuses (M38). Each level costs a render target and
 * a recursion step, and a document can arrive from disk with anything in it.
 */
const MAX_GROUP_DEPTH = 8;

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
  /** Glyph rasterisation for text layers (core/text.ts). Without it, text layers report and draw nothing. */
  readonly text?: TextRasterizer;
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
  /**
   * The value each modulated parameter actually rendered with this frame, by target path
   * (`layers.<id>.params.<key>`, `layers.<id>.effects.<id>.params.<key>`): modulated, clamped,
   * exactly what the module received. Only parameters that carry a binding appear. For the studio's
   * live display (modulation-spec §10); never read back into rendering.
   */
  readonly modulatedValues: ReadonlyMap<string, ParamValue>;
  /** Each enabled binding's shaped signal at this frame, by binding id (`bindingLevels`). */
  readonly bindingLevels: ReadonlyMap<string, number>;
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
  /**
   * Registers decoded pixels for an image asset under its content hash (image.ts). The host does
   * this for every image the project references before rendering; the engine never reads files.
   */
  setImage(hash: string, image: DecodedImage): void;
  hasImage(hash: string): boolean;
  /**
   * Video (M39). The host extracts a clip to stills at the project's fps and then, before each
   * render, pushes in the frame that frame needs — `videoSourceFrame` says which. `setVideoSequence`
   * declares how long the sequence is, which is what lets the module loop and clamp.
   */
  setVideoSequence(hash: string, frameCount: number): void;
  /**
   * Adds modules after creation — drop-in modules (M35) arrive from disk after the preview's
   * engine exists. A module id already registered is replaced, so an edited module reloads.
   */
  addModules(definitions: readonly ModuleDefinition[]): void;
  /** Modules that failed to create (a shader that does not compile), by id, with the reason. */
  readonly brokenModules: ReadonlyMap<string, string>;
  setVideoFrame(hash: string, frameIndex: number, source: VideoFrameSource): void;
  hasVideo(hash: string): boolean;
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
  const images = new ImageStore(gl);
  const videos = new VideoStore(gl);
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
      ...[...walkRenderModules(project.layers)].flatMap((layer) => layer.modulations ?? []),
      ...(project.globalModulations ?? []),
    ];
    const program = compileModulation({
      bindings,
      analysis,
      durationSeconds: ticksToSeconds(project.durationTicks ?? 0),
      seed: project.seed,
      ...(project.lyrics === undefined ? {} : { lyrics: project.lyrics }),
      placement: project.audio,
    });
    compiled = { project, analysis, program };
    return program;
  }

  /**
   * Modules that could not be created, with why. A drop-in shader that does not compile must not
   * take the frame down with it (module-spec §12): its layers are skipped and reported, and it is
   * not retried every frame — only when the module is registered again.
   */
  const broken = new Map<string, string>();

  function instanceFor(layerId: string, definition: ModuleDefinition): ModuleInstance | undefined {
    const existing = instances.get(layerId);
    if (existing !== undefined && existing.moduleId === definition.manifest.id) return existing.instance;
    if (broken.has(definition.manifest.id)) return undefined;
    existing?.instance.dispose();
    instances.delete(layerId);
    let instance: ModuleInstance;
    try {
      instance = definition.create(gl);
    } catch (error) {
      broken.set(definition.manifest.id, error instanceof Error ? error.message : String(error));
      return undefined;
    }
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
      const modulatedValues = new Map<string, ParamValue>();
      /** Notes what a modulated parameter resolved to, under its full target path. */
      const recordModulated = (prefix: string, options: ResolveOptions, values: ParamValues) => {
        for (const key of options.modulated ?? []) {
          const value = values[key];
          if (value !== undefined) modulatedValues.set(prefix + key, value);
        }
      };
      const frameContext = {
        time: { t, frameIndex, fps },
        analysis,
        audioSeconds: timelineToSourceSeconds(t, project.audio),
        prng: createPrng(project.seed),
        gl,
        quality: options.quality,
        warn: (message: string) => warnings.push(message),
        image: (assetId: string) => {
          const ref = project.assets?.[assetId];
          return ref === undefined || ref.kind !== 'image' ? undefined : images.texture(ref.hash);
        },
        video: (assetId: string) => {
          const ref = project.assets?.[assetId];
          return ref === undefined || ref.kind !== 'video' ? undefined : videos.get(ref.hash);
        },
        text: options.text,
        lyrics: project.lyrics,
        font: (assetId: string) => {
          if (assetId === '') return { hash: null, name: 'default' };
          const ref = project.assets?.[assetId];
          if (ref === undefined || ref.kind !== 'font') {
            return { hash: null, name: 'default', missing: `font asset "${assetId}" is not in the project` };
          }
          if (options.text === undefined || !options.text.hasFont(ref.hash)) {
            return { hash: null, name: ref.name, missing: `font "${ref.name}" is not available (missing file?)` };
          }
          return { hash: ref.hash, name: ref.name };
        },
      };
      const layerSeconds = (range: { inTicks: number; outTicks: number | null } | undefined) => ({
        inSeconds: range === undefined ? 0 : ticksToSeconds(range.inTicks),
        outSeconds: range?.outTicks == null ? null : ticksToSeconds(range.outTicks),
      });
      const wholeTimeline = layerSeconds(undefined);

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
        layerTime: { inSeconds: number; outSeconds: number | null },
        hasDepth = false,
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
          if (definition.manifest.capabilities.needsDepth === true && !hasDepth) {
            // Depth exists only on 3D scene layers (D18). Refused and said, never run on nothing.
            warnings.push(`${owner}: effect "${definition.manifest.name}" needs depth, which only 3D scene layers have; it is not applied`);
            continue;
          }
          const effectModulation = modulationFor(`${pathPrefix}${spec.id}.params.`);
          const resolved = resolveParams(definition.manifest.params, spec.params, effectModulation);
          recordModulated(`${pathPrefix}${spec.id}.params.`, effectModulation, resolved.values);
          if (resolved.issues.length > 0) paramIssues.push({ layerId: `${owner}/${spec.id}`, issues: resolved.issues });
          const instance = instanceFor(spec.id, definition);
          if (instance === undefined) {
            warnings.push(`${owner}: effect "${spec.module}" is broken and is not applied — ${broken.get(spec.module) ?? 'it could not be created'}`);
            continue;
          }
          passes.push({
            id: spec.id,
            draw: (input, target, depth) => instance.render({ ...frameContext, canvas, layer: layerTime, targets: pool, input, depth, outputTarget: target }, resolved.values),
          });
        }
        return passes;
      };

      /**
       * One level of the layer tree (M38). A group's children composite into the group's own
       * target, so the group's transform, opacity, blend and effects apply to the result rather
       * than to each child — the difference between fading a scene and fading three layers.
       *
       * Depth is bounded: a document is loaded from disk and could nest arbitrarily, and each
       * level costs a render target.
       */
      const buildLayers = (specs: readonly AnyLayerSpec[], depth: number): CompositeLayer[] => {
        const built: CompositeLayer[] = [];
        for (const layer of specs) {
          if (!layer.enabled) continue;
          if (!layerIsLive(layer.timeRange, tick)) continue;

          const transform = layer.transform ?? IDENTITY_LAYER_TRANSFORM;
          const canvas = canvasFor(transform.scaleReference);
          const layerTime = layerSeconds(layer.timeRange);
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
          // Opacity is a modulation target too (`layers.<id>.opacity`): the auto-director's section
          // presence curves fade optional layers in and out on section boundaries this way.
          const opacityTarget = `layers.${layer.id}.opacity`;
          const opacity = Math.min(1, Math.max(0, program.targets.has(opacityTarget) ? modulateValue(program, opacityTarget, layer.opacity, t) : layer.opacity));
          if (program.targets.has(opacityTarget)) modulatedValues.set(opacityTarget, opacity);
          // Fully faded out: nothing to draw, and nothing worth rendering to find that out.
          if (opacity <= 0) continue;
          const common = {
            opacity,
            blend: layer.blend,
            ...(inverseTransform === undefined ? {} : { inverseTransform }),
          };

          if (isGroupSpec(layer)) {
            if (depth >= MAX_GROUP_DEPTH) {
              warnings.push(`group ${layer.id}: groups are nested more than ${MAX_GROUP_DEPTH} deep; this one and its children are not rendered`);
              continue;
            }
            const children = buildLayers(layer.children, depth + 1);
            built.push({
              ...common,
              draw: (target) => compositor.drawInto(target, children),
              effects: buildEffects(layer.effects ?? [], `layers.${layer.id}.effects.`, `group ${layer.id}`, canvas, layerTime),
            });
            continue;
          }

          const definition = registry.get(layer.module);
          if (definition === undefined) {
            // Preserved in the project, reported, never silently dropped (CLAUDE.md #4).
            warnings.push(`layer ${layer.id}: unknown module "${layer.module}" is not rendered`);
            continue;
          }
          // Step 4 of module-spec §5. Only keys that actually carry a binding go through the
          // evaluator; everything else resolves exactly as it did before modulation existed.
          // `referenceScale` is per layer: it follows the layer's own scaleReference, so a logo
          // on 'min' and a full-bleed background on 'max' each get the number they need.
          const layerModulation = modulationFor(`layers.${layer.id}.params.`);
          const resolved = resolveParams(definition.manifest.params, layer.params, layerModulation);
          recordModulated(`layers.${layer.id}.params.`, layerModulation, resolved.values);
          if (resolved.issues.length > 0) paramIssues.push({ layerId: layer.id, issues: resolved.issues });
          const instance = instanceFor(layer.id, definition);
          if (instance === undefined) {
            warnings.push(`layer ${layer.id}: module "${layer.module}" is broken and is not rendered — ${broken.get(layer.module) ?? 'it could not be created'}`);
            continue;
          }

          built.push({
            ...common,
            draw: (target) => {
              instance.render({ ...frameContext, canvas, layer: layerTime, targets: pool, input: null, depth: null, outputTarget: target }, resolved.values);
              return instance.depth?.() ?? null;
            },
            effects: buildEffects(
              layer.effects ?? [], `layers.${layer.id}.effects.`, `layer ${layer.id}`, canvas, layerTime,
              definition.manifest.kind === 'scene3d',
            ),
          });
        }
        return built;
      };

      const layers = buildLayers(project.layers, 0);

      const background = toLinearPremultiplied(parseHexColor(project.canvas.background) ?? { r: 0, g: 0, b: 0, a: 1 });
      if (parseHexColor(project.canvas.background) === undefined) {
        warnings.push(`canvas background "${project.canvas.background}" is not a valid colour; using black`);
      }
      // The global chain has no layer of its own, so its sizes follow the smaller canvas
      // dimension — the reference that behaves the same in landscape and vertical.
      const globalEffects = buildEffects(project.globalEffects ?? [], 'global.effects.', 'global effects', canvasFor('min'), wholeTimeline);

      compositor.composite(output, { ...background, a: 1 }, layers, options.output, {
        frameIndex,
        noiseSeed: hash32(project.seed, 'output-dither'),
      }, globalEffects);
      nv12?.convert(output);

      return {
        frameIndex, t, warnings, paramIssues, modulationIssues: program.issues,
        modulatedValues, bindingLevels: bindingLevels(program, t),
      };
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

    setImage(hash, image) {
      images.set(hash, image);
    },

    hasImage: (hash) => images.has(hash),

    setVideoSequence(hash, frameCount) {
      videos.setSequence(hash, frameCount);
    },

    setVideoFrame(hash, frameIndex, source) {
      videos.setFrame(hash, frameIndex, source);
    },

    hasVideo: (hash) => videos.has(hash),

    addModules(definitions) {
      for (const definition of definitions) {
        const { id } = definition.manifest;
        // Anything built from the old definition goes, so the next frame creates from the new one.
        for (const [layerId, entry] of instances) {
          if (entry.moduleId !== id) continue;
          entry.instance.dispose();
          instances.delete(layerId);
        }
        broken.delete(id);
        registry.set(id, definition);
      }
    },

    get brokenModules() {
      return broken;
    },

    dispose() {
      for (const { instance } of instances.values()) instance.dispose();
      instances.clear();
      images.dispose();
      videos.dispose();
      nv12?.dispose();
      compositor.dispose();
      pool.dispose();
    },
  };
}
