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
import type { MotionBlur } from '../engine/core/time.ts';
import { rangeFrames, type RenderRange } from './range.ts';
import { diskSpaceError, estimateOutputBytes, isDiskFullFailure, spaceProblem } from './disk-space.ts';
import { freeBytesAt } from '../node/free-bytes.ts';
import { InstrumentalError, buildInstrumental } from './instrumental.ts';
import { loadLutAssets } from '../assets/luts.ts';

/** The soundtrack of a render: the song, or its instrumental for a karaoke render (S15). */
export type AudioMix = 'full' | 'instrumental';
import { loadImageAssets } from '../assets/load-images.ts';
import { colorEmojiFontFile, defaultFontFile, fallbackFontFiles, loadFontAssets } from '../assets/fonts.ts';
import { resolveAssetPath } from '../assets/load-images.ts';
import { extractSequence, sequenceDir } from '../assets/video-cache.ts';
import { videoFramesNeeded } from '../engine/modules/video.ts';
import { analyzeCached } from '../analysis/cached.ts';
import { cacheOptionsFor } from '../analysis/project-settings.ts';
import { decodeMono48k } from '../analysis/decode.ts';
import { probeCodecs } from './encoder-probe.ts';
import { encodeSettingsFor, type ExportQuality, type VideoCodec } from './ffmpeg-args.ts';
import { rational, TICKS_PER_SECOND } from '../engine/core/time.ts';
import { loadDocument } from '../project/load.ts';
import { timelineDurationTicks, toRenderProject, type SnapshotNote } from '../project/snapshot.ts';
import type { DocumentIssue } from '../project/parse.ts';
import { FFMPEG_EXE, FFPROBE_EXE, MILKDROP_JS_DIR, MODULES_DIR, MODULE_LIBRARIES } from '../../setup/lib/paths.ts';
import { scanModules } from '../modules-folder/scan.ts';
import { BUILTIN_MODULES } from '../engine/engine.ts';
import type { ImageFile, VideoSequenceFile } from '../../spike/electron/protocol.ts';
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
  /** Picture against file size; absent is best. */
  readonly quality?: ExportQuality | undefined;
  /** Motion blur (S10, export-spec §9); absent renders each frame at one instant. */
  readonly motionBlur?: MotionBlur | undefined;
  /** Spatial supersampling (export-spec §9); absent is 1. */
  readonly supersample?: 1 | 2 | undefined;
  /** Part of the timeline (S9: between markers); absent renders all of it. */
  readonly range?: RenderRange | undefined;
  /** 'instrumental': the karaoke variant (S15) — every stem but the vocals, summed. Default 'full'. */
  readonly audioMix?: AudioMix | undefined;
  /** Where separation keeps stems (`<root>/<audioHash>/<model>/<stem>.flac`); defaults to `<cacheRoot>/stems`. */
  readonly stemsRoot?: string | undefined;
  readonly outputPath: string;
  /** Scratch: the analysis blob, the encoder's temporary files, the result JSON. */
  readonly workDir: string;
  readonly cacheRoot: string;
  /**
   * Where video clips are extracted (M39). Separate because a frame cache runs to gigabytes and
   * belongs on a drive with room; defaults to `cacheRoot`.
   */
  readonly videoCacheRoot?: string | undefined;
  /** The drop-in modules folder; defaults to the repo's `modules/`. */
  readonly modulesDir?: string | undefined;
  /** Distinguishes concurrent callers' scratch files. */
  readonly name: string;
  readonly noCache?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: ((progress: RenderProgress) => void) | undefined;
  /** Reads the free space at a path; injected by tests. Default: the real drive. */
  readonly freeBytes?: ((path: string) => Promise<number | null>) | undefined;
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
  // The project's bands and onset settings, through the same mapping the studio uses.
  const analysed = await analyzeCached(decoded.pcm, cache, { ...cacheOptionsFor(document.analysisSettings), force: options.noCache === true });
  say(analysed.fromCache
    ? `Analysis: cache hit (${analysed.audioHash.slice(0, 12)}…)`
    : `Analysis: computed and cached (${analysed.audioHash.slice(0, 12)}…)`);

  if (analysed.beatRefinement === 'stale') {
    say('Warning: the refined beats belong to another audio file; rendering with the detected beats');
  }

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
  // A range (S9) renders only its frames; they are counted here so progress and the result agree.
  let frames: number;
  try {
    frames = rangeFrames(options.range, fps, durationTicks).frames;
  } catch (error) {
    throw new RenderDocumentError(`The render range does not fit this timeline: ${(error as Error).message}.`, ['Choose a start before the end, inside the timeline']);
  }
  // The disk is checked before any of the slow work below, and for a job in a queue at the moment
  // it starts, when the jobs before it have written their files (export-spec §14).
  // The render's own check, as the export dialog's: a job can outlive what was true when queued.
  const support = (await probeCodecs(FFMPEG_EXE))[options.codec];
  if (!support.available) {
    throw new RenderDocumentError(`This machine cannot encode ${options.codec === 'hevc' ? 'HEVC' : 'H.264'}. ${support.reason ?? ''}`.trim(), ['Choose an H.264 export preset, or update the graphics driver']);
  }
  const encodeSettings = { ...encodeSettingsFor(options.codec, options.quality), encoder: support.encoder };
  if (support.encoder === 'software') say(`Encoding in software, which is slower: the hardware encoder is not usable here (${support.reason ?? 'unknown reason'})`);
  const neededBytes = estimateOutputBytes({ ...canvas, frames, fps: fps.num / fps.den, audioBitrateKbps: encodeSettings.audioBitrateKbps });
  const noRoom = spaceProblem(options.outputPath, neededBytes, await (options.freeBytes ?? freeBytesAt)(options.outputPath));
  if (noRoom !== null) throw diskSpaceError(noRoom);

  say(`Rendering ${project.layers.length} layer(s) at ${canvas.width}×${canvas.height} (${aspect}) `
    + `${fps.num / fps.den} fps, ${frames} frames${options.range === undefined ? '' : ` from ${(options.range.inTicks / TICKS_PER_SECOND).toFixed(2)} s`}, ${options.codec}`);

  // Image assets decode here, through the same code the studio preview uses, and cross to the
  // Electron child as raw files. Problems become notes: the render still goes ahead.
  const loaded = await loadImageAssets(document, options.projectPath, { ffmpegExe: FFMPEG_EXE, ffprobeExe: FFPROBE_EXE });
  // Fonts cross as files (the child reads them); the bundled default is always registered, so a text
  // layer with no font chosen — or a missing one — still renders, and says which.
  const fontAssets = loadFontAssets(document, options.projectPath);
  // LUTs (S11) go to the render as text; a missing or unreadable one is a note, and its effect passes the picture through.
  const lutAssets = loadLutAssets(document, options.projectPath);
  // Video clips are extracted to the frame cache at this render's fps and width (M39). A clip that
  // cannot be found or read is a problem, not a failure: its layer draws the missing-clip
  // checkerboard and the render says why, exactly as the preview does.
  const videoProblems: { assetId: string; detail: string }[] = [];
  const videos: VideoSequenceFile[] = [];
  for (const asset of document.assets) {
    if (asset.kind !== 'video') continue;
    const path = resolveAssetPath(asset.path, options.projectPath);
    if (path === undefined || !existsSync(path)) {
      videoProblems.push({ assetId: asset.id, detail: `video "${asset.name}" is missing${path === undefined ? '' : `: ${path}`}` });
      continue;
    }
    try {
      say(`Extracting video frames: ${asset.name}`);
      const sequence = await extractSequence({
        ffmpegExe: FFMPEG_EXE,
        ffprobeExe: FFPROBE_EXE,
        root: options.videoCacheRoot ?? options.cacheRoot,
        path,
        videoHash: asset.hash,
        fps,
        width: canvas.width,
        // Enough for the whole timeline at the fastest speed a layer may use; a loop wraps.
        maxFrames: videoFramesNeeded(project, asset.id, frames),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
      videos.push({ hash: asset.hash, dir: sequenceDir(options.videoCacheRoot ?? options.cacheRoot, asset.hash, fps, canvas.width), frameCount: sequence.frameCount });
    } catch (error) {
      if (options.signal?.aborted === true) throw error;
      videoProblems.push({ assetId: asset.id, detail: (error as Error).message });
    }
  }
  // Drop-in modules (M35), scanned exactly as the studio scans them, so a project using one renders
  // here too. A broken module is a note, and its layers draw nothing — the engine says which.
  const colorEmoji = colorEmojiFontFile();
  const scanned = await scanModules(options.modulesDir ?? MODULES_DIR, new Set(BUILTIN_MODULES.map((m) => m.manifest.id)), MODULE_LIBRARIES);
  for (const broken of scanned.problems) say(`Warning: modules/${broken.folder}: ${broken.problems.join('; ')}`);
  const problems = [...loaded.problems, ...fontAssets.problems, ...lutAssets.problems, ...videoProblems];
  const allNotes: SnapshotNote[] = [
    ...notes,
    ...problems.map((problem) => ({ path: `assets.${problem.assetId}`, detail: problem.detail })),
    ...(analysed.beatRefinement === 'stale' ? [{ path: 'analysisSettings.beatRefinement', detail: 'the refined beats belong to another audio file; the detected beats were used' }] : []),
  ];
  for (const problem of problems) say(`Warning: ${problem.detail}`);
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
  // Karaoke (S15): the instrumental stem sum stands in for the song; placement, trim and fades apply
  // to it unchanged (export-spec §7: "everything else is identical").
  let soundtrack = audioPath;
  let soundtrackLabel = audioPath;
  if (options.audioMix === 'instrumental') {
    const model = document.analysisSettings.stemModel;
    try {
      const built = await buildInstrumental({
        ffmpegExe: FFMPEG_EXE,
        stemDir: join(options.stemsRoot ?? join(options.cacheRoot, 'stems'), analysed.audioHash, model),
        model,
        outPath: join(options.workDir, `${options.name}-instrumental.wav`),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      soundtrack = built.path;
      soundtrackLabel = `${audioPath} — instrumental (${built.stems.join(' + ')}, ${model})`;
      say(`Karaoke: the soundtrack is ${built.stems.join(' + ')} (no vocals)`);
    } catch (error) {
      if (error instanceof InstrumentalError) throw new RenderDocumentError(error.message, error.fixes);
      throw error;
    }
  }

  const summary = await runExportSpike({
    workDir: options.workDir,
    name: options.name,
    project: { ...project, durationTicks },
    analysisPcm: decoded.pcm,
    analysis: { analysis: analysed.analysis, beatGrid: analysed.beatGrid },
    audioPath: soundtrack,
    audioLabel: soundtrackLabel,
    audioPlacement: {
      leadInSamples: document.audio.leadInTicks,
      clipInSamples: document.audio.clipInTicks,
      clipOutSamples: document.audio.clipOutTicks ?? undefined,
      level: document.audio,
    },
    durationTicks,
    images,
    text: { default: defaultFontFile(), fonts: fontAssets.fonts, fallbacks: [...fallbackFontFiles()], ...(colorEmoji === null ? {} : { colorEmoji }) },
    ...(lutAssets.luts.length > 0 ? { luts: lutAssets.luts } : {}),
    videos,
    modules: [...scanned.modules],
    settings: encodeSettings,
    outputPath: options.outputPath,
    // Sync readback: measured faster than the PBO ring through ANGLE (D50).
    readbackMode: 'sync',
    readbackDepth: 1,
    hashFrames: false,
    dither: true,
    ...(options.motionBlur === undefined ? {} : { motionBlur: options.motionBlur }),
    ...(options.supersample === undefined ? {} : { supersample: options.supersample }),
    ...(existsSync(join(MILKDROP_JS_DIR, 'index.json')) ? { milkdropDir: MILKDROP_JS_DIR } : {}),
    ...(options.range === undefined ? {} : { range: options.range }),
    runs: 1,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    onProgress: (line) => {
      say(`  ${line}`);
      const parsed = parseProgress(line);
      options.onProgress?.({ line, encoded: parsed?.encoded ?? 0, total: parsed?.total ?? frames });
    },
  }).catch(async (error: unknown) => {
    await discardPartial();
    // The disk filled anyway, or something else filled it during the render.
    if (error instanceof Error && isDiskFullFailure(error.message)) throw diskSpaceError(`${error.message} The partial file was removed.`);
    throw error;
  }).finally(() => Promise.all([
    ...images.map((image) => rm(image.file, { force: true })),
    // The instrumental is scratch: rebuilt from the stems whenever a karaoke render needs it.
    ...(soundtrack === audioPath ? [] : [rm(soundtrack, { force: true })]),
  ]));

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
