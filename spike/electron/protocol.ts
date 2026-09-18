// Messages between the spike orchestrators, the Electron main process and the renderer.

import type { RenderProject } from '../../src/engine/core/project.ts';
import type { ContextInfo } from '../../src/engine/render/gl.ts';
import type { RenderReport } from '../../src/export/report.ts';
import type { EncodeSettings } from '../../src/export/ffmpeg-args.ts';

/**
 * A decoded image asset handed to the renderer as a raw RGBA8 file (straight alpha, sRGB, top row
 * first) rather than inline: a 4K image is 60 MB, far too much for a JSON config.
 */
export interface ImageFile {
  hash: string;
  width: number;
  height: number;
  file: string;
}

/** A font file for text layers: the renderer reads and registers it under `hash`. */
export interface FontFileRef {
  hash: string;
  file: string;
}

/** An extracted video sequence the renderer reads stills from (M39). */
export interface VideoSequenceFile {
  hash: string;
  /** The frame-cache folder for this clip at this fps and width. */
  dir: string;
  frameCount: number;
}

/** Fonts for a render: the default, and the project's font assets. */
export interface FontsConfig {
  default: FontFileRef;
  fonts: FontFileRef[];
}

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
  /**
   * Where the audio sits on the timeline (PROJECT.md §8.10), in samples at 48 kHz. Passed
   * explicitly rather than assumed zero: a project with lead-in silence or a trimmed clip
   * would otherwise export out of sync with its own preview.
   */
  audioPlacement: { leadInSamples: number; clipInSamples: number; clipOutSamples: number | undefined };
  durationTicks: number;
  project: RenderProject;
  images?: ImageFile[];
  /** Absent: text layers report that no rasteriser is available. */
  text?: FontsConfig;
  videos?: VideoSequenceFile[];
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
  images?: ImageFile[];
  /** Absent: text layers report that no rasteriser is available. */
  text?: FontsConfig;
  videos?: VideoSequenceFile[];
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
