// Exact time (CLAUDE.md constraint 5, export-spec §2, D10).
//
// Frame time is always derived from the integer frame index, never accumulated.
// fps is a rational; storage time is integer ticks of 1/48000 s.

export const TICKS_PER_SECOND = 48_000;

export interface Rational {
  readonly num: number;
  readonly den: number;
}

export function rational(num: number, den = 1): Rational {
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || num <= 0 || den <= 0) {
    throw new RangeError(`fps must be a positive integer ratio, got ${num}/${den}`);
  }
  return { num, den };
}

/** Frames needed to cover `durationTicks`: ceil(durationTicks · num / (48000 · den)), in exact integers. */
export function frameCount(durationTicks: number, fps: Rational): number {
  if (!Number.isSafeInteger(durationTicks) || durationTicks < 0) {
    throw new RangeError(`durationTicks must be a non-negative integer, got ${durationTicks}`);
  }
  const numerator = BigInt(durationTicks) * BigInt(fps.num);
  const denominator = BigInt(TICKS_PER_SECOND) * BigInt(fps.den);
  return Number((numerator + denominator - 1n) / denominator);
}

/** t(n) = n / fps in seconds. The one place a frame index becomes seconds. */
export function frameTimeSeconds(frameIndex: number, fps: Rational): number {
  return (frameIndex * fps.den) / fps.num;
}

/**
 * Start of frame n in ticks. Exact for integer fps dividing 48000; NTSC rates
 * (59.94 = 800.8 ticks/frame) are not tick-exact, so this rounds with the one
 * documented rule: floor.
 */
export function frameStartTick(frameIndex: number, fps: Rational): number {
  return Number((BigInt(frameIndex) * BigInt(TICKS_PER_SECOND) * BigInt(fps.den)) / BigInt(fps.num));
}

export function ticksToSeconds(ticks: number): number {
  return ticks / TICKS_PER_SECOND;
}

export function secondsToTicks(seconds: number): number {
  return Math.round(seconds * TICKS_PER_SECOND);
}

export interface AudioPlacement {
  /** Silence before the audio starts on the timeline (PROJECT.md §8.10). */
  readonly leadInTicks: number;
  /** Where in the source file the clip starts. */
  readonly clipInTicks: number;
}

/**
 * Timeline time → source-audio time. The single mapping every analysis lookup goes
 * through (PROJECT.md §8.10, risk "timeline-time vs audio-time confusion").
 * Negative results are before the audio; callers clamp via the analysis read contract.
 */
export function timelineToSourceSeconds(timelineSeconds: number, placement: AudioPlacement): number {
  return timelineSeconds - ticksToSeconds(placement.leadInTicks) + ticksToSeconds(placement.clipInTicks);
}

/**
 * Source-audio time → timeline time: the exact inverse, kept here so both directions of the
 * mapping live in one file and cannot drift apart. The preview clock needs this one, because an
 * audio element reports where *it* is and the playhead has to be expressed on the timeline.
 */
export function sourceToTimelineSeconds(sourceSeconds: number, placement: AudioPlacement): number {
  return sourceSeconds + ticksToSeconds(placement.leadInTicks) - ticksToSeconds(placement.clipInTicks);
}

/** Motion blur (S10, export-spec §9): `samples` subframes across a shutter of `shutterDegrees`. */
export interface MotionBlur {
  readonly samples: number;
  readonly shutterDegrees: number;
}

export const MOTION_BLUR_DEFAULT: MotionBlur = { samples: 8, shutterDegrees: 180 };
export const MOTION_BLUR_MAX_SAMPLES = 32;

export interface SubframeTime {
  readonly t: number;
  readonly tick: number;
  readonly weight: number;
}

/**
 * Where frame n's subframes sit (export-spec §9): `samples` evenly spaced times across
 * `t ± (shutter/2)/fps`, each at the middle of its slice of the open shutter, weighted equally.
 * Derived from the frame index like every other time; nothing accumulates between frames. A time
 * before the timeline starts is held at 0, so frame 0 is only blurred forwards.
 */
export function subframeTimes(frameIndex: number, fps: Rational, blur: MotionBlur): SubframeTime[] {
  const t = frameTimeSeconds(frameIndex, fps);
  const start = frameStartTick(frameIndex, fps);
  const open = ((blur.shutterDegrees / 360) * fps.den) / fps.num;
  const out: SubframeTime[] = [];
  for (let j = 0; j < blur.samples; j++) {
    const offset = ((j + 0.5) / blur.samples - 0.5) * open;
    out.push({
      t: Math.max(0, t + offset),
      tick: Math.max(0, start + Math.round(offset * TICKS_PER_SECOND)),
      weight: 1 / blur.samples,
    });
  }
  return out;
}

/** A motion-blur setting's problems, or none: whole samples 2–32, a shutter of 1–360°. */
export function motionBlurProblems(blur: MotionBlur): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(blur.samples) || blur.samples < 2 || blur.samples > MOTION_BLUR_MAX_SAMPLES) {
    problems.push(`motion blur needs 2–${MOTION_BLUR_MAX_SAMPLES} whole samples, got ${blur.samples}`);
  }
  if (!Number.isFinite(blur.shutterDegrees) || blur.shutterDegrees < 1 || blur.shutterDegrees > 360) {
    problems.push(`the motion-blur shutter must be 1–360°, got ${blur.shutterDegrees}`);
  }
  return problems;
}
