// Messages between the spike orchestrators, the Electron main process and the renderer.

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
  width: number;
  height: number;
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

export type SpikeConfig = DeterminismConfig | ExportConfig;

export interface PassResult {
  /** SHA-256 of each frame's RGBA bytes, by frame index. */
  frameHashes: string[];
  renderMs: number[];
  readbackMs: number[];
}

export interface SpikeRenderResult {
  ok: boolean;
  error?: string;
  context?: { renderer: string; vendor: string; maxTextureSize: number };
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
