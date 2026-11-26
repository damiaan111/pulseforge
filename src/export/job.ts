// One export, end to end (export-spec §1):
// prepare → audio → frame pump (render → async readback → FFmpeg stdin) → mux → verify → report.
//
// Runs where a WebGL2 context and Node APIs are both available (an Electron renderer with Node
// access). The engine, pump and argument builder it composes are each usable on their own.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AnalysisSet } from '../engine/core/analysis.ts';
import type { DecodedImage } from '../engine/core/image.ts';
import type { Lut3D } from '../engine/core/lut.ts';
import type { MilkdropHost } from '../engine/core/milkdrop.ts';
import type { TextRasterizer } from '../engine/core/text.ts';
import type { ModuleDefinition } from '../engine/core/module.ts';
import { walkRenderModules, type RenderProject } from '../engine/core/project.ts';
import type { MotionBlur } from '../engine/core/time.ts';
import { rangeFrames, type RenderRange } from './range.ts';
import { ENGINE_VERSION, createEngine, type Engine } from '../engine/engine.ts';
import { prepareExportAudio, type AudioPlacement, type AudioSource, type PreparedAudio } from './audio.ts';
import { startEncoder, type EncoderProcess } from './encoder.ts';
import { buildFfmpegArgs, formatCommandLine, resolveConversion, settingsProblems, type EncodeSettings } from './ffmpeg-args.ts';
import { pumpFrames } from './pump.ts';
import { RENDER_REPORT_VERSION, type RenderReport } from './report.ts';
import { checkOutput, probeFile } from './verify.ts';

export interface ExportRequest {
  readonly gl: WebGL2RenderingContext;
  readonly project: RenderProject;
  readonly analysis: AnalysisSet;
  readonly audio: { readonly source: AudioSource; readonly placement: AudioPlacement; readonly label: string } | undefined;
  /** Timeline length in ticks (= samples at 48 kHz). */
  readonly durationTicks: number;
  /** Decoded image assets by content hash, registered before the first frame. */
  readonly images?: ReadonlyMap<string, DecodedImage>;
  /** Parsed LUT assets by content hash (S11), registered before the first frame. */
  readonly luts?: ReadonlyMap<string, Lut3D>;
  /** Glyph rasterisation with the project's fonts already registered. */
  readonly text?: TextRasterizer;
  /**
   * Awaited before each frame is rendered, for inputs the host fetches rather than computes —
   * a video layer's still comes off the frame cache and is decoded (M39).
   */
  readonly prepareFrame?: (frameIndex: number) => Promise<void>;
  /** The module set, when it is more than the built-ins (drop-in modules, M35). */
  readonly modules?: readonly ModuleDefinition[];
  /** Called once with the engine this export builds, for hosts that register inputs into it. */
  readonly onEngine?: (engine: Engine) => void;
  readonly outputPath: string;
  readonly scratchDir: string;
  readonly settings: EncodeSettings;
  readonly ffmpegExe: string;
  readonly ffprobeExe: string;
  /** 'async' = PBO ring of `readbackDepth`; 'sync' = readPixels per frame (depth 1). */
  readonly readbackMode: 'async' | 'sync';
  readonly readbackDepth: number;
  readonly maxQueuedWrites: number;
  /** SHA-256 every frame (determinism evidence). Costs CPU time, reported separately. */
  readonly hashFrames: boolean;
  readonly bitexact: boolean;
  /** Keep a partial file when the export fails or is cancelled (export-spec §13). */
  readonly keepPartial: boolean;
  /** Output dither; always on for real exports. Off only for exact colour measurement. */
  readonly dither?: boolean;
  /** Motion blur (S10, export-spec §9); absent renders each frame at one instant. */
  readonly motionBlur?: MotionBlur;
  readonly supersample?: 1 | 2;
  /** Runs MilkDrop layers; a project with none needs no host. */
  readonly milkdrop?: MilkdropHost;
  /** Part of the timeline (S9: markers as range bounds); absent renders all of it. */
  readonly range?: RenderRange;
  readonly now: () => number;
  readonly yieldToEventLoop: () => Promise<void>;
  readonly onProgress?: (progress: { readonly collected: number; readonly encoded: number; readonly total: number }) => void;
  readonly isCancelled?: () => boolean;
}

export interface ExportResult {
  readonly report: RenderReport;
  readonly reportPath: string;
  readonly frameHashes: readonly string[];
}

export class ExportError extends Error {
  readonly stage: string;
  constructor(stage: string, message: string, options?: { cause?: unknown }) {
    super(`${stage}: ${message}`, options);
    this.name = 'ExportError';
    this.stage = stage;
  }
}

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export async function runExport(request: ExportRequest): Promise<ExportResult> {
  const { project, now } = request;
  const { width, height, fps } = project.canvas;
  const started = now();
  const settings = resolveConversion(request.settings, width, height);
  // NV12 is converted on the GPU and only read synchronously (P0 measurement: faster through ANGLE).
  const readbackMode = settings.conversion === 'gpu-nv12' ? 'sync' : request.readbackMode;

  const problems = settingsProblems(settings, width, height);
  if (problems.length > 0) throw new ExportError('prepare', problems.join(' '));

  let window;
  try {
    window = rangeFrames(request.range, fps, request.durationTicks);
  } catch (error) {
    throw new ExportError('prepare', (error as Error).message);
  }
  const { frames, startFrame, startSample, totalSamples } = window;
  if (frames === 0) throw new ExportError('prepare', 'the timeline is empty (0 frames)');

  let prepared: PreparedAudio | undefined;
  if (request.audio !== undefined) {
    try {
      prepared = await prepareExportAudio(request.audio.source, request.audio.placement, totalSamples, join(request.scratchDir, 'export-audio.wav'), startSample);
    } catch (error) {
      throw new ExportError('audio', (error as Error).message, { cause: error });
    }
  }

  const args = buildFfmpegArgs({
    width,
    height,
    fps,
    settings,
    audioPath: prepared?.path,
    outputPath: request.outputPath,
    bitexact: request.bitexact,
  });

  // quality: 'final' is forced on export (D20); output encoding per D49.
  const engine = createEngine(request.gl, {
    quality: 'final',
    output: { transfer: 'srgb', dither: request.dither ?? true, flipY: true, bitDepth: settings.bitDepth },
    packing: settings.conversion === 'gpu-nv12' ? 'nv12' : 'rgba',
    ...(request.text === undefined ? {} : { text: request.text }),
    ...(request.modules === undefined ? {} : { modules: request.modules }),
    ...(request.motionBlur === undefined ? {} : { motionBlur: request.motionBlur }),
    ...(request.supersample === undefined ? {} : { supersample: request.supersample }),
    ...(request.milkdrop === undefined ? {} : { milkdrop: request.milkdrop }),
  });
  for (const [hash, image] of request.images ?? []) engine.setImage(hash, image);
  for (const [hash, lut] of request.luts ?? []) engine.setLut(hash, lut);
  // Per-layer GPU cost for the report (PROJECT.md §8.15, S12). Observes only; never changes a pixel.
  engine.setProfiling(true);
  request.onEngine?.(engine);
  const readback = readbackMode === 'sync' ? engine.createSyncReadback(width, height) : engine.createReadback(width, height, request.readbackDepth);
  const warnings = new Set<string>();
  const frameHashes: string[] = [];
  const prepareMs = now() - started;

  let encoder: EncoderProcess | undefined;
  try {
    encoder = startEncoder(request.ffmpegExe, args);
    const activeEncoder = encoder;
    const stats = await pumpFrames({
      frameCount: frames,
      maxQueuedWrites: request.maxQueuedWrites,
      now,
      yieldToEventLoop: request.yieldToEventLoop,
      sink: activeEncoder.sink,
      source: {
        readback,
        // The pump counts from 0; the engine is given the timeline frame (a range starts later).
        ...(request.prepareFrame !== undefined ? { prepareFrame: (frameIndex: number) => request.prepareFrame!(startFrame + frameIndex) } : {}),
        renderFrame(frameIndex) {
          const report = engine.renderFrame(project, request.analysis, startFrame + frameIndex);
          for (const w of report.warnings) warnings.add(w);
          for (const p of report.paramIssues) for (const i of p.issues) warnings.add(`${p.layerId}.${i.key}: ${i.detail}`);
        },
      },
      ...(request.hashFrames ? { onFrame: (_i: number, bytes: Uint8Array) => void frameHashes.push(createHash('sha256').update(bytes).digest('hex')) } : {}),
      ...(request.onProgress !== undefined
        ? { onProgress: (_submitted: number, collected: number) => request.onProgress?.({ collected, encoded: activeEncoder.framesEncoded(), total: frames }) }
        : {}),
      ...(request.isCancelled !== undefined ? { isCancelled: request.isCancelled } : {}),
    });

    const finalizeStart = now();
    await activeEncoder.finish();
    const probe = await probeFile(request.ffprobeExe, request.outputPath);
    const verification = checkOutput(probe, { frameCount: frames, width, height, fps, settings, hasAudio: prepared !== undefined });
    const outputBytes = (await stat(request.outputPath)).size;
    const outputSha = request.bitexact ? await sha256OfFile(request.outputPath) : undefined;
    const finalizeMs = now() - finalizeStart;

    if (prepared !== undefined && prepared.adjustmentSamples !== 0) {
      warnings.add(
        prepared.adjustmentSamples > 0
          ? `audio padded with ${prepared.adjustmentSamples} samples of silence to match the video length`
          : `audio cut by ${-prepared.adjustmentSamples} samples to match the video length`,
      );
    }

    const report: RenderReport = {
      reportVersion: RENDER_REPORT_VERSION,
      engineVersion: ENGINE_VERSION,
      output: { path: request.outputPath, bytes: outputBytes, sha256: outputSha },
      project: {
        sha256: createHash('sha256').update(JSON.stringify(project)).digest('hex'),
        seed: project.seed,
        layers: [...walkRenderModules(project.layers)].map((l) => ({ id: l.id, module: l.module })),
      },
      canvas: { width, height, fps: `${fps.num}/${fps.den}` },
      frames: {
        count: frames,
        combinedSha256: request.hashFrames ? createHash('sha256').update(frameHashes.join('\n')).digest('hex') : undefined,
      },
      motionBlur: request.motionBlur ?? null,
      supersample: request.supersample ?? 1,
      range: request.range === undefined ? null : { ...request.range, startFrame, frames },
      encode: {
        settings,
        commandLine: formatCommandLine(request.ffmpegExe, args),
        readbackMode,
        readbackDepth: readback.depth,
        maxQueuedWrites: request.maxQueuedWrites,
        bitexact: request.bitexact,
      },
      audio:
        prepared === undefined
          ? null
          : { source: request.audio?.label ?? '', totalSamples: prepared.totalSamples, sourceSamples: prepared.sourceSamples, adjustmentSamples: prepared.adjustmentSamples },
      timing: { ...stats, fps: frames / (stats.wallMs / 1000), prepareMs, finalizeMs, targetHighWaterMark: engine.targetHighWaterMark },
      gpu: { renderer: engine.context.renderer, vendor: engine.context.vendor },
      gpuTimings: engine.profiling.available ? engine.gpuTimingSummary() : null,
      verification,
      warnings: [...warnings],
    };
    const reportPath = `${request.outputPath}.report.json`;
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    return { report, reportPath, frameHashes };
  } catch (error) {
    encoder?.abort();
    if (!request.keepPartial) await rm(request.outputPath, { force: true });
    if (error instanceof ExportError) throw error;
    throw new ExportError('encode', error instanceof Error ? error.message : String(error), { cause: error });
  } finally {
    readback.dispose();
    engine.dispose();
  }
}
