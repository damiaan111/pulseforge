// The audio clip's level over the timeline: gain and fades (M29, PROJECT.md §8.10, export-spec §7).
//
// One definition, used twice: the exporter multiplies every placed sample by it, and the preview
// sets the audio element's volume from it on each tick — so what you hear while editing is the fade
// that will be rendered. Measured in **clip samples** (0 = the first sample after the trim), which is
// the same count in ticks, since ticks are 1/48000 s (D10).

import type { AudioSettings, FadeCurve } from './document.ts';

/** A fade's shape at position x ∈ [0, 1] from silence (0) to full level (1). */
export function fadeShape(curve: FadeCurve, x: number): number {
  const t = Math.min(1, Math.max(0, x));
  switch (curve) {
    case 'linear':
      return t;
    // sin keeps the summed power of a crossfade constant; alone, it sounds like a steady fade
    // rather than one that hangs loud and then drops.
    case 'equal-power':
      return Math.sin((t * Math.PI) / 2);
    case 's-curve':
      return t * t * (3 - 2 * t);
  }
}

export type ClipLevel = Pick<AudioSettings, 'gain' | 'fadeInTicks' | 'fadeOutTicks' | 'fadeInCurve' | 'fadeOutCurve'>;

/**
 * The level at `clipSample` into a clip `clipLength` samples long: gain × fade-in × fade-out. Fades
 * longer than half the clip are allowed to overlap — each is applied on its own, so a clip shorter
 * than both fades rises and falls rather than jumping.
 */
export function clipLevel(level: ClipLevel, clipSample: number, clipLength: number): number {
  let value = level.gain;
  if (level.fadeInTicks > 0 && clipSample < level.fadeInTicks) {
    value *= fadeShape(level.fadeInCurve, clipSample / level.fadeInTicks);
  }
  const fromEnd = clipLength - clipSample;
  if (level.fadeOutTicks > 0 && fromEnd < level.fadeOutTicks) {
    value *= fadeShape(level.fadeOutCurve, fromEnd / level.fadeOutTicks);
  }
  return value;
}

/** True when the clip's level is 1 everywhere — nothing to apply, the source can be used as is. */
export function isUnity(level: ClipLevel): boolean {
  return level.gain === 1 && level.fadeInTicks <= 0 && level.fadeOutTicks <= 0;
}
