// Renderer side of the determinism spike.
//
// Pass A renders frames 0..N-1 in order on one engine. Pass B builds a second engine on a
// separate WebGL2 context and renders the same frames in a scrambled order. Every frame's
// RGBA bytes are hashed; any difference means hidden state or non-determinism.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ipcRenderer } from 'electron';
import { createEngine, type Engine } from '../../src/engine/engine.ts';
import { hash32 } from '../../src/engine/core/prng.ts';
import type { AnalysisSet } from '../../src/engine/core/analysis.ts';
import { decodeAnalysis } from '../analysis-file.ts';
import { spikeProject } from '../project.ts';
import type { PassResult, SpikeRenderConfig, SpikeRenderResult } from './protocol.ts';

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
    output: { transfer: 'srgb', dither, flipY: true }, // D49
  });
}

function runPass(
  engine: Engine,
  analysis: AnalysisSet,
  config: SpikeRenderConfig,
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

function main(): SpikeRenderResult {
  const config = ipcRenderer.sendSync('spike-config') as SpikeRenderConfig;
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

// Let the page finish loading before blocking the renderer thread with GPU work.
setTimeout(() => ipcRenderer.send('spike-done', main()), 0);
