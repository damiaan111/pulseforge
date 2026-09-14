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
