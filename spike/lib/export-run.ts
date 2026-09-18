// Runs the real export (src/export/job.ts) in Electron one or more times and compares runs.
// Used by `npm run spike:export` and by `npm run validate`.

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { encodeAnalysis } from '../../src/analysis/container.ts';
import { analyzeMix } from '../../src/analysis/analyze.ts';
import type { AnalysisSet, BeatGrid } from '../../src/engine/core/analysis.ts';
import type { RenderProject } from '../../src/engine/core/project.ts';
import type { EncodeSettings } from '../../src/export/ffmpeg-args.ts';
import type { RenderReport } from '../../src/export/report.ts';
import { FFMPEG_EXE, FFPROBE_EXE } from '../../setup/lib/paths.ts';
import type { ExportConfig, FontsConfig, ImageFile, SpikeExportResult, VideoSequenceFile } from '../electron/protocol.ts';
import { runElectron } from '../harness.ts';

// Re-exported so the spike orchestrators have one import site for the vendored tools.
export { FFPROBE_EXE };

export interface ExportRunOptions {
  readonly workDir: string;
  readonly name: string;
  readonly project: RenderProject;
  /** Mono 48 kHz analysis input. Ignored when `analysis` is supplied. */
  readonly analysisPcm: Float32Array;
  /**
   * Precomputed analysis, so a caller that already has it — from the on-disk cache, say — does
   * not analyse the same audio again. Absent means compute it here, which is what the spikes do.
   */
  readonly analysis?: { readonly analysis: AnalysisSet; readonly beatGrid: BeatGrid | undefined } | undefined;
  /** The audio file muxed into the export. */
  readonly audioPath: string;
  readonly audioLabel: string;
  /** Defaults to the whole file starting at t=0, which is what the spikes want. */
  readonly audioPlacement?: ExportConfig['audioPlacement'];
  readonly durationTicks: number;
  /** Image assets already written as raw RGBA files. */
  readonly images?: readonly ImageFile[];
  /** Fonts for text layers. */
  readonly text?: FontsConfig;
  /** Extracted video sequences (M39). */
  readonly videos?: readonly VideoSequenceFile[];
  readonly settings: EncodeSettings;
  readonly readbackMode: 'sync' | 'async';
  readonly readbackDepth: number;
  readonly hashFrames: boolean;
  readonly dither: boolean;
  readonly runs: number;
  /** Where the (single-run) output goes. Defaults into `workDir`, which is what the spikes want. */
  readonly outputPath?: string;
  readonly onProgress?: (line: string) => void;
  /** Aborting kills the Electron child mid-render (harness.ts). */
  readonly signal?: AbortSignal;
}

export interface ExportRun {
  readonly run: number;
  readonly outputPath: string;
  readonly report: RenderReport;
  readonly frameHashes: readonly string[];
  readonly fileSha256: string;
  readonly chromeVersion: string;
  readonly electronVersion: string;
}

export interface ExportRunSummary {
  readonly runs: readonly ExportRun[];
  readonly first: ExportRun;
  /** undefined when frames were not hashed or only one run. */
  readonly framesIdentical: boolean | undefined;
  readonly firstFrameMismatch: number | undefined;
  readonly filesIdentical: boolean | undefined;
  readonly verified: boolean;
}

export class ExportRunError extends Error {
  readonly log: string;
  constructor(message: string, log: string) {
    super(message);
    this.name = 'ExportRunError';
    this.log = log;
  }
}

export async function runExportSpike(options: ExportRunOptions): Promise<ExportRunSummary> {
  await mkdir(options.workDir, { recursive: true });
  const analysisFile = join(options.workDir, `${options.name}.analysis.bin`);
  const analysed = options.analysis ?? analyzeMix(options.analysisPcm);
  await writeFile(analysisFile, encodeAnalysis(analysed.analysis.sources.get('mix')!, { source: 'mix', beatGrid: analysed.beatGrid }));

  const runs: ExportRun[] = [];
  for (let run = 1; run <= options.runs; run++) {
    // A caller-supplied path only makes sense for one run; several would overwrite each other.
    const outputPath = options.outputPath !== undefined && options.runs === 1
      ? options.outputPath
      : join(options.workDir, `${options.name}-run${run}.mp4`);
    const config: ExportConfig = {
      mode: 'export',
      analysisFile,
      resultFile: join(options.workDir, `${options.name}-run${run}.result.json`),
      audioPath: options.audioPath,
      audioLabel: options.audioLabel,
      audioPlacement: options.audioPlacement ?? { leadInSamples: 0, clipInSamples: 0, clipOutSamples: undefined },
      durationTicks: options.durationTicks,
      project: options.project,
      ...(options.images !== undefined && options.images.length > 0 ? { images: [...options.images] } : {}),
      ...(options.text === undefined ? {} : { text: options.text }),
      ...(options.videos !== undefined && options.videos.length > 0 ? { videos: [...options.videos] } : {}),
      dither: options.dither,
      outputPath,
      scratchDir: join(options.workDir, `${options.name}-scratch-${run}`),
      settings: options.settings,
      readbackMode: options.readbackMode,
      hashFrames: options.hashFrames,
      readbackDepth: options.readbackDepth,
      maxQueuedWrites: 4,
      ffmpegExe: FFMPEG_EXE,
      ffprobeExe: FFPROBE_EXE,
    };
    const { result, log } = await runElectron<SpikeExportResult>(config, options.onProgress, options.signal);
    if (!result.ok || result.report === undefined) {
      throw new ExportRunError(`export "${options.name}" run ${run} failed: ${result.error ?? 'no report'}`, log);
    }
    runs.push({
      run,
      outputPath,
      report: result.report,
      frameHashes: result.frameHashes ?? [],
      fileSha256: createHash('sha256').update(await readFile(outputPath)).digest('hex'),
      chromeVersion: result.chromeVersion ?? 'unknown',
      electronVersion: result.electronVersion ?? 'unknown',
    });
  }

  const first = runs[0];
  if (first === undefined) throw new ExportRunError('runs must be at least 1', '');
  let firstFrameMismatch: number | undefined;
  if (options.hashFrames && runs.length > 1) {
    for (const other of runs.slice(1)) {
      const index = first.frameHashes.findIndex((hash, i) => hash !== other.frameHashes[i]);
      if (index !== -1) {
        firstFrameMismatch = index;
        break;
      }
    }
  }
  return {
    runs,
    first,
    framesIdentical: options.hashFrames && runs.length > 1 ? firstFrameMismatch === undefined : undefined,
    firstFrameMismatch,
    filesIdentical: runs.length > 1 ? runs.every((r) => r.fileSha256 === first.fileSha256) : undefined,
    verified: runs.every((r) => r.report.verification.ok),
  };
}

export function perFrameMs(report: RenderReport, total: number): string {
  return `${(total / report.timing.frames).toFixed(2)} ms`;
}
