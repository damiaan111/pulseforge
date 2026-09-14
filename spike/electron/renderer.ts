// Renderer side of the spikes.
//
// Export mode: runs src/export/job.ts — the real export path — in this process.
//
// Determinism mode: pass A renders frames 0..N-1 in order on one engine. Pass B builds a second engine on a
// separate WebGL2 context and renders the same frames in a scrambled order. Every frame's
// RGBA bytes are hashed; any difference means hidden state or non-determinism.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ipcRenderer } from 'electron';
import { createEngine, type Engine } from '../../src/engine/engine.ts';
import { hash32 } from '../../src/engine/core/prng.ts';
import type { AnalysisSet } from '../../src/engine/core/analysis.ts';
import { decodeAnalysis } from '../../src/analysis/container.ts';
import { spikeProject } from '../project.ts';
import { runExport } from '../../src/export/job.ts';
import type {
  DeterminismConfig, ExportConfig, FramesConfig, PassResult, SpikeConfig, SpikeExportResult,
  SpikeFramesResult, SpikeRenderResult,
} from './protocol.ts';

function createContext(): WebGL2RenderingContext {
  // The canvas itself is never drawn to; frames render into engine-owned framebuffers.
  const canvas = new OffscreenCanvas(1, 1);
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
  });
  if (gl === null) throw new Error('WebGL2 is not available in this Electron renderer');
  return gl;
}

function newEngine(dither = true): Engine {
  return createEngine(createContext(), {
    quality: 'final',
    output: { transfer: 'srgb', dither, flipY: true, bitDepth: 8 }, // D49
  });
}

function runPass(
  engine: Engine,
  analysis: AnalysisSet,
  config: DeterminismConfig,
  order: readonly number[],
  onFrame: (frameIndex: number, pixels: Uint8Array) => void,
  warnings: Set<string>,
  paramIssues: Set<string>,
): PassResult {
  const project = spikeProject(config.width, config.height);
  const pixels = new Uint8Array(config.width * config.height * 4);
  const result: PassResult = {
    frameHashes: new Array<string>(config.frameCount).fill(''),
    renderMs: new Array<number>(config.frameCount).fill(0),
    readbackMs: new Array<number>(config.frameCount).fill(0),
  };
  for (const frameIndex of order) {
    const t0 = performance.now();
    const report = engine.renderFrame(project, analysis, frameIndex);
    const t1 = performance.now();
    engine.readOutputSync(pixels); // blocks until the GPU has finished this frame
    const t2 = performance.now();
    for (const w of report.warnings) warnings.add(w);
    for (const p of report.paramIssues) for (const i of p.issues) paramIssues.add(`${p.layerId}.${i.key}: ${i.detail}`);
    result.frameHashes[frameIndex] = createHash('sha256').update(pixels).digest('hex');
    result.renderMs[frameIndex] = t1 - t0;
    result.readbackMs[frameIndex] = t2 - t1;
    onFrame(frameIndex, pixels);
  }
  return result;
}

function runDeterminism(config: DeterminismConfig): SpikeRenderResult {
  const base: SpikeRenderResult = {
    ok: false,
    width: config.width,
    height: config.height,
    frameCount: config.frameCount,
    chromeVersion: process.versions['chrome'] ?? 'unknown',
    electronVersion: process.versions['electron'] ?? 'unknown',
    warnings: [],
    paramIssues: [],
  };
  try {
    const { analysis } = decodeAnalysis(readFileSync(config.analysisFile));
    mkdirSync(config.rawDir, { recursive: true });
    const warnings = new Set<string>();
    const paramIssues = new Set<string>();

    const engineA = newEngine();
    const sequentialOrder = Array.from({ length: config.frameCount }, (_, i) => i);
    const dump = new Set(config.dumpFrames);
    const sequential = runPass(engineA, analysis, config, sequentialOrder, (frameIndex, pixels) => {
      if (dump.has(frameIndex)) writeFileSync(join(config.rawDir, `frame-${String(frameIndex).padStart(5, '0')}.rgba`), pixels);
    }, warnings, paramIssues);
    const context = engineA.context;
    engineA.dispose();

    // Deterministic Fisher–Yates shuffle from the engine PRNG.
    const shuffleOrder = [...sequentialOrder];
    for (let i = shuffleOrder.length - 1; i > 0; i--) {
      const j = hash32(99, 'shuffle', i) % (i + 1);
      [shuffleOrder[i], shuffleOrder[j]] = [shuffleOrder[j] ?? 0, shuffleOrder[i] ?? 0];
    }
    const engineB = newEngine();
    const shuffled = runPass(engineB, analysis, config, shuffleOrder, () => {}, warnings, paramIssues);
    engineB.dispose();

    const engineC = newEngine(false);
    const undithered = runPass(engineC, analysis, config, sequentialOrder, () => {}, warnings, paramIssues);
    engineC.dispose();

    return { ...base, ok: true, context, sequential, shuffled, undithered, shuffleOrder: shuffleOrder.slice(0, 12), warnings: [...warnings], paramIssues: [...paramIssues] };
  } catch (error) {
    return { ...base, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
}

/** Renders the requested frames of a supplied project and writes each one's raw RGBA. */
function runFrames(config: FramesConfig): SpikeFramesResult {
  const { width, height } = config.project.canvas;
  const base: SpikeFramesResult = {
    ok: false,
    width,
    height,
    files: [],
    frameHashes: [],
    chromeVersion: process.versions['chrome'] ?? 'unknown',
    electronVersion: process.versions['electron'] ?? 'unknown',
    warnings: [],
    paramIssues: [],
  };
  try {
    const { analysis } = decodeAnalysis(readFileSync(config.analysisFile));
    mkdirSync(config.rawDir, { recursive: true });
    const engine = newEngine(config.dither);
    const pixels = new Uint8Array(width * height * 4);
    const warnings = new Set<string>();
    const paramIssues = new Set<string>();
    const files: string[] = [];
    const frameHashes: string[] = [];

    for (const frameIndex of config.frames) {
      const report = engine.renderFrame(config.project, analysis, frameIndex);
      engine.readOutputSync(pixels);
      for (const w of report.warnings) warnings.add(w);
      for (const p of report.paramIssues) for (const i of p.issues) paramIssues.add(`${p.layerId}.${i.key}: ${i.detail}`);
      const file = join(config.rawDir, `frame-${String(frameIndex).padStart(5, '0')}.rgba`);
      writeFileSync(file, pixels);
      files.push(file);
      frameHashes.push(createHash('sha256').update(pixels).digest('hex'));
    }
    const context = engine.context;
    engine.dispose();
    return { ...base, ok: true, context, files, frameHashes, warnings: [...warnings], paramIssues: [...paramIssues] };
  } catch (error) {
    return { ...base, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
}

/** A zero-delay yield: MessageChannel callbacks are not clamped or throttled like timers. */
function createYield(): () => Promise<void> {
  const channel = new MessageChannel();
  const waiting: Array<() => void> = [];
  channel.port1.onmessage = () => waiting.shift()?.();
  return () =>
    new Promise((resolve) => {
      waiting.push(resolve);
      channel.port2.postMessage(0);
    });
}

async function runExportMode(config: ExportConfig): Promise<SpikeExportResult> {
  const base: SpikeExportResult = {
    ok: false,
    chromeVersion: process.versions['chrome'] ?? 'unknown',
    electronVersion: process.versions['electron'] ?? 'unknown',
  };
  try {
    const { analysis } = decodeAnalysis(readFileSync(config.analysisFile));
    mkdirSync(config.scratchDir, { recursive: true });
    let lastProgress = 0;
    const result = await runExport({
      gl: createContext(),
      project: config.project,
      analysis,
      dither: config.dither,
      audio: {
        source: { kind: 'file', path: config.audioPath, ffmpegExe: config.ffmpegExe },
        placement: config.audioPlacement,
        label: config.audioLabel,
      },
      durationTicks: config.durationTicks,
      outputPath: config.outputPath,
      scratchDir: config.scratchDir,
      settings: config.settings,
      ffmpegExe: config.ffmpegExe,
      ffprobeExe: config.ffprobeExe,
      readbackMode: config.readbackMode,
      readbackDepth: config.readbackDepth,
      maxQueuedWrites: config.maxQueuedWrites,
      hashFrames: config.hashFrames,
      bitexact: true,
      keepPartial: false,
      now: () => performance.now(),
      yieldToEventLoop: createYield(),
      onProgress: ({ collected, encoded, total }) => {
        const t = performance.now();
        if (t - lastProgress > 1000 || collected === total) {
          lastProgress = t;
          ipcRenderer.send('spike-progress', `frames read back ${collected}/${total}, encoded ${encoded}`);
        }
      },
    });
    return { ...base, ok: true, report: result.report, reportPath: result.reportPath, frameHashes: [...result.frameHashes] };
  } catch (error) {
    return { ...base, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
}

// Let the page finish loading before blocking the renderer thread with GPU work.
setTimeout(() => {
  const config = ipcRenderer.sendSync('spike-config') as SpikeConfig;
  if (config.mode === 'export') {
    void runExportMode(config).then((result) => ipcRenderer.send('spike-done', result));
  } else if (config.mode === 'frames') {
    ipcRenderer.send('spike-done', runFrames(config));
  } else {
    ipcRenderer.send('spike-done', runDeterminism(config));
  }
}, 0);
