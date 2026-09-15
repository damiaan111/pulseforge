// Document on disk → video file. The one pipeline, used by `npm run render` and by the studio's
// render queue.
//
// It exists because those two were about to be the same forty lines twice, and the two copies
// would have drifted — which would mean "it renders differently from the CLI" bug reports about
// a difference nobody chose. Everything specific to a caller (argument parsing, queue
// bookkeeping, console output) stays with that caller; what is here is the part that must be
// identical.
//
// **The render itself runs in a separate Electron process.** A WebGL2 context needs Chromium,
// and doing it in the studio's own window would fight the preview for the GPU and freeze the UI
// for the length of the render. The child is killed if the caller aborts.

import { dirname, isAbsolute, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';

import { AnalysisCache } from '../analysis/cache.ts';
import { loadImageAssets } from '../assets/load-images.ts';
import { analyzeCached } from '../analysis/cached.ts';
import { decodeMono48k } from '../analysis/decode.ts';
import { defaultEncodeSettings, type VideoCodec } from './ffmpeg-args.ts';
import { frameCount, rational, TICKS_PER_SECOND } from '../engine/core/time.ts';
import { loadDocument } from '../project/load.ts';
import { timelineDurationTicks, toRenderProject, type SnapshotNote } from '../project/snapshot.ts';
import type { DocumentIssue } from '../project/parse.ts';
import { FFMPEG_EXE, FFPROBE_EXE } from '../../setup/lib/paths.ts';
import type { ImageFile } from '../../spike/electron/protocol.ts';
import { bundleElectron } from '../../spike/harness.ts';
import { runExportSpike } from '../../spike/lib/export-run.ts';
import type { RenderReport } from './report.ts';

/** Aspects the studio and the CLI both offer. */
export const ASPECT_RATIOS: Readonly<Record<string, number>> = {
  '16:9': 16 / 9,
  '9:16': 9 / 16,
  '1:1': 1,
  '4:5': 4 / 5,
};

export class RenderDocumentError extends Error {
  readonly fixes: readonly string[];
  constructor(message: string, fixes: readonly string[] = []) {
    super(message);
    this.name = 'RenderDocumentError';
    this.fixes = fixes;
  }
}

/**
 * The canvas for a named aspect, keeping roughly the project's pixel count so "the same project
 * as a Short" does not silently become a different resolution class.
 */
export function canvasForAspect(aspect: string, base: { width: number; height: number }): { width: number; height: number } {
  const ratio = ASPECT_RATIOS[aspect];
  if (ratio === undefined) {
    throw new RenderDocumentError(`Unknown aspect "${aspect}".`, [`Use one of ${Object.keys(ASPECT_RATIOS).join(', ')}`]);
  }
  const pixels = base.width * base.height;
  // Even dimensions: 4:2:0 chroma subsampling cannot encode an odd one.
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return { width: even(Math.sqrt(pixels * ratio)), height: even(Math.sqrt(pixels / ratio)) };
}

export interface RenderDocumentOptions {
  readonly documentText: string;
  /** Where the document came from, so a relative audio path resolves. Null for an unsaved one. */
  readonly projectPath: string | null;
  readonly audioOverride?: string | undefined;
  readonly aspect?: string | undefined;
  readonly size?: { readonly width: number; readonly height: number } | undefined;
  readonly seconds?: number | undefined;
  readonly codec: VideoCodec;
  readonly outputPath: string;
  /** Scratch: the analysis blob, the encoder's temporary files, the result JSON. */
  readonly workDir: string;
  readonly cacheRoot: string;
  /** Distinguishes concurrent callers' scratch files. */
  readonly name: string;
  readonly noCache?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: ((progress: RenderProgress) => void) | undefined;
  /** Human-readable running commentary. The CLI prints it; the studio ignores it. */
  readonly log?: ((line: string) => void) | undefined;
}

export interface RenderProgress {
  readonly line: string;
  readonly encoded: number;
  readonly total: number;
}

export interface RenderDocumentResult {
  readonly outputPath: string;
  readonly reportPath: string;
  readonly report: RenderReport;
  readonly frames: number;
  readonly issues: readonly DocumentIssue[];
  readonly notes: readonly SnapshotNote[];
  readonly migratedFrom: number | null;
}

/**
 * `PROGRESS` lines from the child look like `frames read back 120/600, encoded 96`. Progress is the
 * **encoded** count, not the read-back one: the pump runs ahead of the encoder, and reporting its
 * position makes a render look finished and then hang (export-spec §13).
 */
export function parseProgress(line: string): { encoded: number; total: number } | undefined {
  const match = /(\d+)\s*\/\s*(\d+)\s*,\s*encoded\s+(\d+)/.exec(line);
  if (match?.[2] === undefined || match[3] === undefined) return undefined;
  return { encoded: Number(match[3]), total: Number(match[2]) };
}

export async function renderDocument(options: RenderDocumentOptions): Promise<RenderDocumentResult> {
  const say = options.log ?? (() => {});
  if (!existsSync(FFMPEG_EXE)) {
    throw new RenderDocumentError('The vendored FFmpeg is missing.', ['Run `npm run setup` to provision vendor/']);
  }

  const { document, issues, migratedFrom } = loadDocument(options.documentText);

  // Audio paths are stored relative to the project when possible (data-formats §1.2), so they
  // only resolve against the project's own directory — an unsaved document has nothing to
  // resolve against and must carry an absolute path or an override.
  const stored = document.audio.path;
  const audioPath = options.audioOverride !== undefined
    ? resolve(options.audioOverride)
    : stored === ''
      ? undefined
      : isAbsolute(stored)
        ? stored
        : options.projectPath === null ? undefined : join(dirname(options.projectPath), stored);
  if (audioPath === undefined || !existsSync(audioPath)) {
    throw new RenderDocumentError(
      audioPath === undefined ? 'The project has no audio file.' : `Audio file not found: ${audioPath}`,
      ['Import audio into the project', 'Or save the project, so a relative audio path can resolve'],
    );
  }

  say(`Decoding ${audioPath}`);
  const decoded = await decodeMono48k(FFMPEG_EXE, audioPath);

  // Analysis goes through the on-disk cache (data-formats §4): the same audio and settings are
  // analysed once, ever.
  const cache = new AnalysisCache({ root: options.cacheRoot });
  const analysed = await analyzeCached(decoded.pcm, cache, { force: options.noCache === true });
  say(analysed.fromCache
    ? `Analysis: cache hit (${analysed.audioHash.slice(0, 12)}…)`
    : `Analysis: computed and cached (${analysed.audioHash.slice(0, 12)}…)`);

  const canvas = options.size ?? (options.aspect !== undefined
    ? canvasForAspect(options.aspect, document.canvas)
    : { width: document.canvas.width, height: document.canvas.height });
  const resized = { ...document, canvas: { ...document.canvas, ...canvas } };

  const { project, notes, aspect } = toRenderProject(resized);

  const documentTicks = timelineDurationTicks(document);
  const durationTicks = options.seconds !== undefined
    ? Math.round(options.seconds * TICKS_PER_SECOND)
    : documentTicks > 0
      ? documentTicks
      : Math.round((decoded.pcm.length / decoded.sampleRate) * TICKS_PER_SECOND);
  if (durationTicks <= 0) {
    throw new RenderDocumentError('The timeline has no length.', ['Set the audio duration in the project']);
  }

  const fps = rational(project.canvas.fps.num, project.canvas.fps.den);
  const frames = frameCount(durationTicks, fps);
  say(`Rendering ${project.layers.length} layer(s) at ${canvas.width}×${canvas.height} (${aspect}) `
    + `${fps.num / fps.den} fps, ${frames} frames, ${options.codec}`);

  // Image assets decode here, through the same code the studio preview uses, and cross to the
  // Electron child as raw files. Problems become notes: the render still goes ahead.
  const loaded = await loadImageAssets(document, options.projectPath, { ffmpegExe: FFMPEG_EXE, ffprobeExe: FFPROBE_EXE });
  const allNotes: SnapshotNote[] = [
    ...notes,
    ...loaded.problems.map((problem) => ({ path: `assets.${problem.assetId}`, detail: problem.detail })),
  ];
  for (const problem of loaded.problems) say(`Warning: ${problem.detail}`);
  await mkdir(options.workDir, { recursive: true });
  const images: ImageFile[] = [];
  for (const [hash, image] of loaded.images) {
    const file = join(options.workDir, `${options.name}.image-${hash.slice(0, 16)}.rgba`);
    await writeFile(file, image.pixels);
    images.push({ hash, width: image.width, height: image.height, file });
  }

  await mkdir(dirname(options.outputPath), { recursive: true });
  await bundleElectron();

  // A cancelled or failed render must not leave a half-written file that looks like a result
  // (export-spec §13). The Electron child was killed, so FFmpeg has already let go of it.
  const discardPartial = () => Promise.all([
    rm(options.outputPath, { force: true, maxRetries: 5, retryDelay: 200 }),
    rm(`${options.outputPath}.report.json`, { force: true }),
  ]);
  const summary = await runExportSpike({
    workDir: options.workDir,
    name: options.name,
    project: { ...project, durationTicks },
    analysisPcm: decoded.pcm,
    analysis: { analysis: analysed.analysis, beatGrid: analysed.beatGrid },
    audioPath,
    audioLabel: audioPath,
    audioPlacement: {
      leadInSamples: document.audio.leadInTicks,
      clipInSamples: document.audio.clipInTicks,
      clipOutSamples: document.audio.clipOutTicks ?? undefined,
    },
    durationTicks,
    images,
    settings: defaultEncodeSettings(options.codec),
    outputPath: options.outputPath,
    // Sync readback: measured faster than the PBO ring through ANGLE (D50).
    readbackMode: 'sync',
    readbackDepth: 1,
    hashFrames: false,
    dither: true,
    runs: 1,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    onProgress: (line) => {
      say(`  ${line}`);
      const parsed = parseProgress(line);
      options.onProgress?.({ line, encoded: parsed?.encoded ?? 0, total: parsed?.total ?? frames });
    },
  }).catch(async (error: unknown) => {
    await discardPartial();
    throw error;
  }).finally(() => Promise.all(images.map((image) => rm(image.file, { force: true }))));

  const { report } = summary.first;
  return {
    outputPath: options.outputPath,
    reportPath: `${options.outputPath}.report.json`,
    report,
    frames,
    issues,
    notes: allNotes,
    migratedFrom,
  };
}
