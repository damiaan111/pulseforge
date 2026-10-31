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
import { parseCube } from '../../src/engine/core/lut.ts';
import type { MotionBlur } from '../../src/engine/core/time.ts';
import { createEngine, type Engine } from '../../src/engine/engine.ts';
import { walkRenderModules, type RenderProject } from '../../src/engine/core/project.ts';
import { MILKDROP_MODULE } from '../../src/engine/modules/milkdrop.ts';
import { loadButterchurn, MilkdropRenderer } from '../../src/milkdrop/renderer.ts';
import { hash32 } from '../../src/engine/core/prng.ts';
import type { AnalysisSet } from '../../src/engine/core/analysis.ts';
import type { DecodedImage } from '../../src/engine/core/image.ts';
import { decodeAnalysis } from '../../src/analysis/container.ts';
import { spikeProject } from '../project.ts';
import { runExport } from '../../src/export/job.ts';
import { CanvasTextRasterizer } from '../../src/text/canvas-rasterizer.ts';
import { VideoFrameFeeder } from '../../src/video/frame-feeder.ts';
import { framePath } from '../../src/assets/video-cache.ts';
import { shaderModuleDefinition, type ShaderModuleSource } from '../../src/engine/modules/shader-module.ts';
import { BUILTIN_MODULES } from '../../src/engine/engine.ts';
import type {
  DeterminismConfig, ExportConfig, FontsConfig, FramesConfig, ImageFile, PassResult, VideoSequenceFile, SpikeConfig, SpikeExportResult,
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

/** Raw image files → the map the engine registers; sizes are checked, not trusted. */
/** The mix's analysis with each extra source (a stem) merged in, one container file per source. */
function withSources(analysis: AnalysisSet, files: readonly string[]): AnalysisSet {
  if (files.length === 0) return analysis;
  const sources = new Map(analysis.sources);
  for (const file of files) {
    for (const [name, source] of decodeAnalysis(readFileSync(file)).analysis.sources) sources.set(name, source);
  }
  return { ...analysis, sources };
}

function loadImages(files: readonly ImageFile[] | undefined): Map<string, DecodedImage> {
  const images = new Map<string, DecodedImage>();
  for (const entry of files ?? []) {
    const bytes = readFileSync(entry.file);
    if (bytes.length !== entry.width * entry.height * 4) {
      throw new Error(`image ${entry.hash.slice(0, 12)}: ${bytes.length} bytes, expected ${entry.width}×${entry.height}×4`);
    }
    images.set(entry.hash, { width: entry.width, height: entry.height, pixels: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length) });
  }
  return images;
}

/** The text rasteriser with every font the config names registered, or undefined when there are none. */
async function loadText(config: FontsConfig | undefined): Promise<CanvasTextRasterizer | undefined> {
  if (config === undefined) return undefined;
  const text = new CanvasTextRasterizer();
  await text.setDefaultFont(config.default.hash, readFileSync(config.default.file));
  for (const font of config.fallbacks ?? []) await text.addFallbackFont(font.hash, readFileSync(font.file));
  if (config.colorEmoji !== undefined) await text.setColorEmojiFont(config.colorEmoji.hash, readFileSync(config.colorEmoji.file));
  for (const font of config.fonts) await text.addFont(font.hash, readFileSync(font.file));
  return text;
}

/**
 * A feeder that reads stills straight from the frame cache on disk. This renderer has Node, so
 * there is no IPC in the way: the export's only constraint is that the right frame is uploaded
 * before the frame is drawn, which `prepareFrame` guarantees by awaiting.
 */
function videoFeeder(engine: Engine, sequences: readonly VideoSequenceFile[] | undefined): VideoFrameFeeder | undefined {
  if (sequences === undefined || sequences.length === 0) return undefined;
  const dirs = new Map(sequences.map((s) => [s.hash, s.dir]));
  const feeder = new VideoFrameFeeder(engine, async (hash, sourceFrame) => {
    const dir = dirs.get(hash);
    if (dir === undefined) throw new Error(`no extracted sequence for video ${hash.slice(0, 12)}`);
    return new Uint8Array(readFileSync(framePath(dir, sourceFrame)));
  });
  feeder.setSequences(sequences.map((s) => ({ hash: s.hash, frameCount: s.frameCount })));
  return feeder;
}

/** Built-ins plus the drop-in modules the config carries (M35). */
function moduleSet(sources: readonly ShaderModuleSource[] | undefined) {
  return sources === undefined || sources.length === 0
    ? undefined
    : [...BUILTIN_MODULES, ...sources.map(shaderModuleDefinition)];
}

/** The MilkDrop host with every preset this project names loaded, or undefined when it names none. */
async function loadMilkdrop(dir: string | undefined, project: RenderProject): Promise<MilkdropRenderer | undefined> {
  const names = new Set<string>();
  for (const layer of walkRenderModules(project.layers)) {
    const preset = layer.params['preset'];
    if (layer.module === MILKDROP_MODULE && typeof preset === 'string') names.add(preset);
  }
  if (dir === undefined || names.size === 0) return undefined;
  await loadButterchurn();
  const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as { name: string; file: string }[];
  for (const entry of index) {
    // This window runs no untrusted content, and these are setup's own files, from a pinned package.
    if (names.has(entry.name)) (0, eval)(readFileSync(join(dir, entry.file), 'utf8'));
  }
  return new MilkdropRenderer();
}

function newEngine(dither = true, text?: CanvasTextRasterizer, sources?: readonly ShaderModuleSource[], motionBlur?: MotionBlur, quality: 'draft' | 'preview' | 'final' = 'final', supersample?: 1 | 2, milkdrop?: MilkdropRenderer): Engine {
  const modules = moduleSet(sources);
  return createEngine(createContext(), {
    quality,
    output: { transfer: 'srgb', dither, flipY: true, bitDepth: 8 }, // D49
    ...(text === undefined ? {} : { text }),
    ...(modules === undefined ? {} : { modules }),
    ...(motionBlur === undefined ? {} : { motionBlur }),
    ...(supersample === undefined ? {} : { supersample }),
    ...(milkdrop === undefined ? {} : { milkdrop }),
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
async function runFrames(config: FramesConfig): Promise<SpikeFramesResult> {
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
    const engine = newEngine(config.dither, await loadText(config.text), config.modules, config.motionBlur, config.quality ?? 'final', config.supersample, await loadMilkdrop(config.milkdropDir, config.project));
    if (config.profile === true) engine.setProfiling(true);
    for (const [hash, image] of loadImages(config.images)) engine.setImage(hash, image);
    for (const lut of config.luts ?? []) engine.setLut(lut.hash, parseCube(lut.text));
    const feeder = videoFeeder(engine, config.videos);
    const pixels = new Uint8Array(width * height * 4);
    const warnings = new Set<string>();
    const paramIssues = new Set<string>();
    const files: string[] = [];
    const frameHashes: string[] = [];

    for (const frameIndex of config.frames) {
      if (feeder !== undefined) await feeder.ensure(config.project, frameIndex);
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
    // GPU times lag the frames; each readback already waited for the GPU, so the last results
    // land within moments.
    let gpu;
    if (config.profile === true) {
      for (let i = 0; i < 50 && engine.gpuTimingSummary().frames < config.frames.length; i += 1) await new Promise((d) => setTimeout(d, 20));
      gpu = { ...engine.gpuTimingSummary(), available: engine.profiling.available };
    }
    engine.dispose();
    return { ...base, ok: true, context, files, frameHashes, warnings: [...warnings], paramIssues: [...paramIssues], ...(gpu === undefined ? {} : { gpu }) };
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
    const analysis = withSources(decodeAnalysis(readFileSync(config.analysisFile)).analysis, config.sourceFiles ?? []);
    mkdirSync(config.scratchDir, { recursive: true });
    let lastProgress = 0;
    // The engine the export builds is not ours, so the feeder is attached through `prepareFrame`
    // once `runExport` has made it (below); videos need the engine to register their sequences.
    let feeder: VideoFrameFeeder | undefined;
    const milkdrop = await loadMilkdrop(config.milkdropDir, config.project);
    const result = await runExport({
      gl: createContext(),
      onEngine: (engine) => {
        feeder = videoFeeder(engine, config.videos);
      },
      prepareFrame: async (frameIndex) => {
        if (feeder !== undefined) await feeder.ensure(config.project, frameIndex);
      },
      project: config.project,
      analysis,
      dither: config.dither,
      ...(config.motionBlur === undefined ? {} : { motionBlur: config.motionBlur }),
      ...(milkdrop === undefined ? {} : { milkdrop }),
      ...(config.range === undefined ? {} : { range: config.range }),
      audio: {
        source: { kind: 'file', path: config.audioPath, ffmpegExe: config.ffmpegExe },
        placement: config.audioPlacement,
        label: config.audioLabel,
      },
      durationTicks: config.durationTicks,
      images: loadImages(config.images),
      luts: new Map((config.luts ?? []).map((lut) => [lut.hash, parseCube(lut.text)])),
      ...(() => {
        const modules = moduleSet(config.modules);
        return modules === undefined ? {} : { modules };
      })(),
      ...(config.text === undefined ? {} : { text: await loadText(config.text) as CanvasTextRasterizer }),
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
    void runFrames(config).then((result) => ipcRenderer.send('spike-done', result));
  } else {
    ipcRenderer.send('spike-done', runDeterminism(config));
  }
}, 0);
