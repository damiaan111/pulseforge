// A render of part of the timeline (S9, ui-spec §3 "markers … used as render-range bounds";
// export-spec §12 `range { inTicks, outTicks }`).
//
// Frames are the same frames a full render would make — frame n of the range is timeline frame
// startFrame + n, rendered at its own time — so a range render is byte-for-byte a slice of the full
// one. The audio is cut at the sample where the first frame starts, and it is as long as the frames
// are, both derived from frame indices (never accumulated), so picture and sound stay locked.

import { frameCount, type Rational } from '../engine/core/time.ts';
import { samplesForFrames } from './audio.ts';

export interface RenderRange {
  readonly inTicks: number;
  readonly outTicks: number;
}

export interface RangeFrames {
  /** The timeline frame the video starts with. */
  readonly startFrame: number;
  readonly frames: number;
  /** The timeline sample the audio starts at (48 kHz: ticks == samples, D10). */
  readonly startSample: number;
  readonly totalSamples: number;
}

export class RenderRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderRangeError';
  }
}

/**
 * The frames of `range` within a timeline of `durationTicks`: from the first frame starting at or
 * after `inTicks` to the last one starting before `outTicks`. A range past the end is cut to the end;
 * a range with no frame in it is refused.
 */
export function rangeFrames(range: RenderRange | null | undefined, fps: Rational, durationTicks: number): RangeFrames {
  const lastFrame = frameCount(durationTicks, fps);
  if (range == null) {
    return { startFrame: 0, frames: lastFrame, startSample: 0, totalSamples: samplesForFrames(lastFrame, fps) };
  }
  if (!Number.isSafeInteger(range.inTicks) || !Number.isSafeInteger(range.outTicks) || range.inTicks < 0 || range.outTicks <= range.inTicks) {
    throw new RenderRangeError(`a render range needs 0 ≤ in < out, got ${range.inTicks}–${range.outTicks} ticks`);
  }
  const startFrame = frameCount(range.inTicks, fps);
  const endFrame = Math.min(frameCount(range.outTicks, fps), lastFrame);
  if (endFrame <= startFrame) throw new RenderRangeError('the render range holds no frame (it is shorter than a frame, or after the end)');
  const startSample = samplesForFrames(startFrame, fps);
  return { startFrame, frames: endFrame - startFrame, startSample, totalSamples: samplesForFrames(endFrame, fps) - startSample };
}
