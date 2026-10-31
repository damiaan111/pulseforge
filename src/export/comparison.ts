// A/B render (C10): two versions of a look next to each other in one file, to judge them moving.
//
// Both sides go through `renderDocument`, the one pipeline, so each side is exactly what a normal
// export of it would be. What makes them comparable is settled here:
//   picture  the right side takes the left's canvas size and frame rate
//   length   the shorter of the two timelines; a side longer than that is cut, neither is padded
//   sound    the left side's, copied; two songs at once would judge nothing
// The side-by-side is one more encode, so it runs through FFmpeg with the job's own encoder.

import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Rational } from '../engine/core/time.ts';
import type { ProjectDocument } from '../project/document.ts';
import { timelineDurationTicks } from '../project/snapshot.ts';
import { RenderDocumentError } from './render-document.ts';
import { buildSideBySideArgs, formatCommandLine, sideBySideSize, type EncodeSettings } from './ffmpeg-args.ts';
import { checkOutput, probeFile, type VerificationResult } from './verify.ts';

export type ComparisonSide = 'left' | 'right';

/** The other project on this one's canvas, with everything that is its own left alone. */
export function comparisonDocument(left: ProjectDocument, right: ProjectDocument): ProjectDocument {
  const { width, height, fps } = left.canvas;
  return { ...right, canvas: { ...right.canvas, width, height, fps } };
}

/** How long an A/B render is: the shorter timeline. */
export function comparisonTicks(left: ProjectDocument, right: ProjectDocument): number {
  const ticks = Math.min(timelineDurationTicks(left), timelineDurationTicks(right));
  if (ticks <= 0) throw new RenderDocumentError('One side of the comparison has no length.', ['Import audio into both projects']);
  return ticks;
}

/** What a side's render has to hand back. `renderDocument`'s result satisfies it. */
export interface SideResult {
  readonly frames: number;
  readonly report: { readonly verification: { readonly ok: boolean; readonly issues: readonly string[] } };
}

export interface RenderComparisonOptions {
  readonly ffmpegExe: string;
  readonly ffprobeExe: string;
  readonly settings: EncodeSettings;
  readonly outputPath: string;
  readonly workDir: string;
  readonly labels: Readonly<Record<ComparisonSide, string>>;
  readonly signal?: AbortSignal;
  /** Renders one side to `outputPath`. Injected, so this is testable without a GPU. */
  readonly renderSide: (side: ComparisonSide, outputPath: string) => Promise<SideResult>;
}

function parseRate(rate: string | undefined): Rational {
  const [num, den] = (rate ?? '').split('/').map(Number);
  if (num === undefined || den === undefined || !Number.isInteger(num) || !Number.isInteger(den) || num <= 0 || den <= 0) {
    throw new Error(`The render reports a frame rate of "${rate}".`);
  }
  return { num, den };
}

function runFfmpeg(exe: string, args: readonly string[], signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, [...args], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    const onAbort = () => child.kill();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', reject);
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted === true) reject(new Error('cancelled'));
      else if (code === 0) resolve();
      else reject(new Error(`FFmpeg could not put the two renders side by side (exit ${code}): ${stderr.trim().split('\n').pop() ?? ''}`));
    });
  });
}

export interface ComparisonResult {
  readonly reportPath: string;
  readonly frames: number;
  readonly verification: VerificationResult;
}

/** Renders both sides, one after the other, and joins them. A side that fails fails the job. */
export async function renderComparison(options: RenderComparisonOptions): Promise<ComparisonResult> {
  const { ffmpegExe, ffprobeExe, settings, outputPath, workDir, labels, signal } = options;
  await mkdir(workDir, { recursive: true });
  const leftPath = join(workDir, 'left.mp4');
  const rightPath = join(workDir, 'right.mp4');
  for (const [side, path] of [['left', leftPath], ['right', rightPath]] as const) {
    const result = await options.renderSide(side, path);
    if (!result.report.verification.ok) {
      throw new Error(`The ${side} render failed verification: ${result.report.verification.issues.join('; ')}`);
    }
  }

  const probed = await probeFile(ffprobeExe, leftPath);
  const video = probed.streams.find((stream) => stream.codec_type === 'video');
  if (video?.width === undefined || video.height === undefined) throw new Error('The left render has no picture.');
  const fps = parseRate(video.r_frame_rate);
  const frames = Number(video.nb_read_packets);
  const args = buildSideBySideArgs({ left: leftPath, right: rightPath, width: video.width, height: video.height, fps, settings, outputPath });
  try {
    await runFfmpeg(ffmpegExe, args, signal);
    const size = sideBySideSize(video.width, video.height, settings.codec);
    const verification = checkOutput(await probeFile(ffprobeExe, outputPath), { frameCount: frames, ...size, fps, settings, hasAudio: true });
    if (!verification.ok) throw new Error(`The side-by-side file failed verification: ${verification.issues.join('; ')}`);
    const reportPath = `${outputPath}.report.json`;
    await writeFile(reportPath, `${JSON.stringify({
      comparison: { left: labels.left, right: labels.right, length: 'the shorter timeline', sound: 'left' },
      command: formatCommandLine(ffmpegExe, args),
      verification,
    }, null, 2)}\n`);
    return { reportPath, frames, verification };
  } catch (error) {
    // A half-written file must not look like a result (export-spec §13).
    await rm(outputPath, { force: true, maxRetries: 5, retryDelay: 200 });
    throw error;
  }
}
