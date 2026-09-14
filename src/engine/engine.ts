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
import { requireContextFeatures, type ContextInfo } from './render/gl.ts';
import { TargetPool, type RenderTarget } from './render/targets.ts';
import { barsModule } from './modules/bars.ts';

export const BUILTIN_MODULES: readonly ModuleDefinition[] = [barsModule];

export interface EngineOptions {
  readonly quality: 'preview' | 'final';
  readonly output: OutputOptions;
  readonly modules?: readonly ModuleDefinition[];
}

export interface FrameReport {
  readonly frameIndex: number;
  readonly t: number;
  readonly warnings: readonly string[];
  readonly paramIssues: readonly { readonly layerId: string; readonly issues: readonly ParamIssue[] }[];
}

export interface Engine {
  readonly context: ContextInfo;
  renderFrame(project: RenderProject, analysis: AnalysisSet, frameIndex: number): FrameReport;
  /** Synchronous readback of the last frame, top-down RGBA8. Step 4 replaces this with async PBOs. */
  readOutputSync(into: Uint8Array): void;
  dispose(): void;
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

  return {
    context,

    renderFrame(project, analysis, frameIndex) {
      if (!Number.isSafeInteger(frameIndex) || frameIndex < 0) {
        throw new RangeError(`frameIndex must be a non-negative integer, got ${frameIndex}`);
      }
      const { width, height, fps } = project.canvas;
      if (output === undefined || output.width !== width || output.height !== height) {
        if (output !== undefined) pool.release(output);
        output = pool.acquire(width, height, 'rgba8');
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

      return { frameIndex, t, warnings, paramIssues };
    },

    readOutputSync(into) {
      if (output === undefined) throw new Error('readOutputSync called before any frame was rendered');
      if (into.length !== output.width * output.height * 4) {
        throw new RangeError(`readback buffer is ${into.length} bytes, expected ${output.width * output.height * 4}`);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, output.framebuffer);
      gl.pixelStorei(gl.PACK_ALIGNMENT, 1); // explicit, or odd widths skew (export-spec §4.3)
      gl.readPixels(0, 0, output.width, output.height, gl.RGBA, gl.UNSIGNED_BYTE, into);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    },

    dispose() {
      for (const { instance } of instances.values()) instance.dispose();
      instances.clear();
      compositor.dispose();
      pool.dispose();
    },
  };
}
