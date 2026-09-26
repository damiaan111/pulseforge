// The render report written beside every export (PROJECT.md M34, export-spec §15).
// Versioned data, not log text, so two renders can be diffed.

import type { MotionBlur } from '../engine/core/time.ts';
import type { EncoderCapability } from './encoder-probe.ts';
import type { EncodeSettings } from './ffmpeg-args.ts';
import type { PumpStats } from './pump.ts';
import type { VerificationResult } from './verify.ts';

export const RENDER_REPORT_VERSION = 1;

export interface RenderReport {
  reportVersion: number;
  engineVersion: string;
  output: { path: string; bytes: number; sha256: string | undefined };
  project: { sha256: string; seed: number; layers: Array<{ id: string; module: string }> };
  canvas: { width: number; height: number; fps: string };
  frames: { count: number; combinedSha256: string | undefined };
  /** Motion blur (S10, export-spec §9): null when off. Absent in reports written before it existed. */
  motionBlur?: MotionBlur | null;
  /** A range render (S9): the ticks asked for and the timeline frames rendered. Null or absent: the whole timeline. */
  range?: { inTicks: number; outTicks: number; startFrame: number; frames: number } | null;
  encode: {
    settings: EncodeSettings;
    commandLine: string;
    readbackMode: 'async' | 'sync';
    readbackDepth: number;
    maxQueuedWrites: number;
    bitexact: boolean;
  };
  audio: {
    source: string;
    totalSamples: number;
    sourceSamples: number;
    adjustmentSamples: number;
  } | null;
  timing: PumpStats & {
    fps: number;
    prepareMs: number;
    finalizeMs: number;
    targetHighWaterMark: number;
  };
  gpu: { renderer: string; vendor: string };
  verification: VerificationResult;
  warnings: string[];
  encoderCapabilities?: EncoderCapability[];
}
