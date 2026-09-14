// Messages between the spike orchestrators, the Electron main process and the renderer.

import type { RenderProject } from '../../src/engine/core/project.ts';
import type { ContextInfo } from '../../src/engine/render/gl.ts';
import type { RenderReport } from '../../src/export/report.ts';
import type { EncodeSettings } from '../../src/export/ffmpeg-args.ts';

export interface DeterminismConfig {
  mode: 'determinism';
  analysisFile: string;
  resultFile: string;
  rawDir: string;
  width: number;
  height: number;
  frameCount: number;
  /** Frames whose raw RGBA is written to rawDir for PNG conversion. */
  dumpFrames: number[];
}

export interface ExportConfig {
  mode: 'export';
  analysisFile: string;
  resultFile: string;
  audioPath: string;
  audioLabel: string;
  durationTicks: number;
  project: RenderProject;
  dither: boolean;
  outputPath: string;
  scratchDir: string;
  settings: EncodeSettings;
  readbackMode: 'async' | 'sync';
  hashFrames: boolean;
  readbackDepth: number;
  maxQueuedWrites: number;
  ffmpegExe: string;
  ffprobeExe: string;
}

/**
 * Render named frames of a given project and write their raw RGBA out. The general-purpose
 * headless render path: used to check layout on the GPU, and the basis for golden frames
 * (export-spec §16).
 */
export interface FramesConfig {
  mode: 'frames';
  analysisFile: string;
  resultFile: string;
  rawDir: string;
  project: RenderProject;
  frames: number[];
  dither: boolean;
}

export interface SpikeFramesResult {
  ok: boolean;
  error?: string;
  context?: ContextInfo;
  chromeVersion?: string;
  electronVersion?: string;
  width: number;
  height: number;
  /** Absolute paths, in the same order as the requested frames. */
  files: string[];
  frameHashes: string[];
  warnings: string[];
  paramIssues: string[];
}

export type SpikeConfig = DeterminismConfig | ExportConfig | FramesConfig;

export interface PassResult {
  /** SHA-256 of each frame's RGBA bytes, by frame index. */
  frameHashes: string[];
  renderMs: number[];
  readbackMs: number[];
}

export interface SpikeRenderResult {
  ok: boolean;
  error?: string;
  context?: ContextInfo;
  chromeVersion?: string;
  electronVersion?: string;
  width: number;
  height: number;
  frameCount: number;
  sequential?: PassResult;
  shuffled?: PassResult;
  /** Dither off: shows whether content changes between frames, which dither noise alone would fake. */
  undithered?: PassResult;
  shuffleOrder?: number[];
  warnings: string[];
  paramIssues: string[];
}

export interface SpikeExportResult {
  ok: boolean;
  error?: string;
  chromeVersion?: string;
  electronVersion?: string;
  report?: RenderReport;
  reportPath?: string;
  frameHashes?: string[];
}
