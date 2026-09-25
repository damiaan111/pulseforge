// Where the singing is: `vocalSegments` from the vocal stem's level (lyrics-spec §4, §8, §9;
// auto-director-spec §2 `stems.vocalSegments`).
//
// Input is the vocal stem's `rms` feature — the analysis puts every feature on one 0..1 scale
// (STATUS §4.4) — at the analysis rate. A fixed threshold would be wrong twice: Demucs leaves a low
// bed of bleed in the vocal stem whose level depends on the mix, and quiet verses sit far below
// belted choruses. So the threshold is **relative to this track**: between its quiet floor (20th
// percentile) and its loud level (95th), with hysteresis so a held note that dips does not split in
// two. Segments shorter than a syllable are dropped and gaps shorter than a breath are bridged.

export interface VocalSegment {
  /** Seconds, in the time base of the input (source audio time for an analysis track). */
  readonly start: number;
  readonly end: number;
}

export interface VocalSegmentOptions {
  /** Shortest segment kept, seconds. */
  readonly minSeconds?: number;
  /** Gaps shorter than this are bridged, seconds. */
  readonly bridgeSeconds?: number;
}

function percentile(sorted: Float32Array, p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))] as number;
}

export function detectVocalSegments(levels: Float32Array, rate: number, options: VocalSegmentOptions = {}): readonly VocalSegment[] {
  const minSeconds = options.minSeconds ?? 0.2;
  const bridgeSeconds = options.bridgeSeconds ?? 0.35;
  if (levels.length === 0 || rate <= 0) return [];
  const sorted = Float32Array.from(levels).sort();
  const floor = percentile(sorted, 0.2);
  const loud = percentile(sorted, 0.95);
  // A stem that never rises above near-silence has no singing, whatever its percentiles say.
  if (loud < 0.08 || loud - floor < 0.05) return [];
  const on = Math.max(0.08, floor + 0.45 * (loud - floor));
  const off = Math.max(0.06, floor + 0.3 * (loud - floor));

  const raw: VocalSegment[] = [];
  let startIndex = -1;
  for (let i = 0; i < levels.length; i += 1) {
    const v = levels[i] as number;
    if (startIndex < 0 && v >= on) startIndex = i;
    else if (startIndex >= 0 && v < off) {
      raw.push({ start: startIndex / rate, end: i / rate });
      startIndex = -1;
    }
  }
  if (startIndex >= 0) raw.push({ start: startIndex / rate, end: levels.length / rate });

  const merged: VocalSegment[] = [];
  for (const segment of raw) {
    const last = merged[merged.length - 1];
    if (last !== undefined && segment.start - last.end < bridgeSeconds) merged[merged.length - 1] = { start: last.start, end: segment.end };
    else merged.push(segment);
  }
  return merged.filter((s) => s.end - s.start >= minSeconds);
}

/** Seconds of `[start, end)` covered by segments. Segments must be sorted and disjoint. */
export function coveredSeconds(segments: readonly VocalSegment[], start: number, end: number): number {
  let total = 0;
  for (const s of segments) {
    if (s.end <= start) continue;
    if (s.start >= end) break;
    total += Math.min(end, s.end) - Math.max(start, s.start);
  }
  return total;
}
