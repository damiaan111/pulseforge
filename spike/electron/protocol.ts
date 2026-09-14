// Messages between the determinism orchestrator, the Electron main process and the renderer.

export interface SpikeRenderConfig {
  analysisFile: string;
  resultFile: string;
  rawDir: string;
  width: number;
  height: number;
  frameCount: number;
  /** Frames whose raw RGBA is written to rawDir for PNG conversion. */
  dumpFrames: number[];
}

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
