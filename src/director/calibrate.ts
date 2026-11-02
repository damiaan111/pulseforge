// Modulation calibration (auto-director-spec §5.2): intent in, numbers out.
//
// Templates say "medium, snappy", never "amount 0.37, release 120". The mapping the spec asks for —
// the source's p10 to no visible effect, its p90 to the intensity band's deflection — is exactly
// what a binding's `inputRange: 'auto'` does at compile time (modulation.ts `autoRange`), so the
// director does not bake percentiles into the project: it sets `auto` and chooses the *amount*.
// That keeps the binding correct if the audio is replaced, and editable like any other.
//
// The amount is the band's share of the parameter's soft range (subtle 8%, medium 25%, strong
// 60%), clamped so the loudest moment lands near, not beyond, the soft maximum. A binding whose
// amount rounds to nothing is not written (§7: it would be clutter in the matrix). The source's
// measured percentiles are still computed here — for the decision log, and to refuse a source
// that is flat on this track.

import type { AnalysisSet, AnalysisTrack } from '../engine/core/analysis.ts';
import type { ParamSpec } from '../engine/core/params.ts';
import { paramSpan } from '../project/modulation-authoring.ts';
import { INTENSITIES, RESPONSES, type TemplateModulation } from './template.ts';

export interface SourceStats {
  readonly p10: number;
  readonly p50: number;
  readonly p90: number;
}

const FEATURES = new Set(['rms', 'peak', 'onset', 'beat', 'centroid', 'flux', 'stereoWidth']);

/** The analysis track a template source reads, or why there is none. */
export function sourceTrack(analysis: AnalysisSet | null, type: string, stem: string, band: string | null): AnalysisTrack | string {
  if (analysis === null) return 'no analysis yet';
  const source = analysis.sources.get(stem as never);
  if (source === undefined) return `stem "${stem}" is not analysed`;
  if (type === 'band') {
    const track = band === null ? undefined : source.bands.get(band);
    return track ?? `band "${band ?? ''}" is not one of this project's bands (${[...source.bands.keys()].join(', ')})`;
  }
  if (FEATURES.has(type)) return source.features.get(type) ?? `feature "${type}" is missing from the ${stem} analysis`;
  return 'not an audio source';
}

export function trackStats(track: AnalysisTrack): SourceStats {
  const sorted = Float32Array.from(track.data).sort();
  const at = (p: number) => (sorted.length === 0 ? 0 : (sorted[Math.min(sorted.length - 1, Math.round(p * (sorted.length - 1)))] as number));
  return { p10: at(0.1), p50: at(0.5), p90: at(0.9) };
}

/** The largest factor a multiplying binding may add at full signal: ×1.25, ×1.6, ×2.5. */
const MULTIPLY_CAP: Record<keyof typeof INTENSITIES, number> = { subtle: 0.25, medium: 0.6, strong: 1.5 };

export type Calibration =
  | {
    readonly ok: true;
    readonly amount: number;
    readonly offset: number;
    readonly attackMs: number;
    readonly releaseMs: number;
    /** "p90 0.23 → +0.12 (25% of 0.5, clamped at the soft max)". */
    readonly note: string;
  }
  | { readonly ok: false; readonly reason: string };

/**
 * Numbers for one template modulation on one parameter. `base` is the parameter's value as the
 * director set it; `jitter` (−1..1, seeded) nudges the band by the template's intensityJitter.
 */
export function calibrate(
  modulation: TemplateModulation,
  spec: ParamSpec,
  base: number,
  stats: SourceStats | null,
  jitter: number,
): Calibration {
  const span = paramSpan(spec);
  if (span <= 0 || (spec.type !== 'float' && spec.type !== 'int')) return { ok: false, reason: `${spec.label} is not a numeric parameter` };
  if (stats !== null && stats.p90 - stats.p10 < 1e-4) {
    return { ok: false, reason: `the source barely moves on this track (p10 ${stats.p10.toFixed(3)}, p90 ${stats.p90.toFixed(3)})` };
  }
  const band = INTENSITIES[modulation.intensity] * (1 + jitter);
  const softMin = spec.type === 'float' ? (spec.softMin ?? spec.min) : spec.min;
  const softMax = spec.type === 'float' ? (spec.softMax ?? spec.max) : spec.max;
  const { attackMs, releaseMs } = RESPONSES[modulation.response];
  const stat = stats === null ? '' : `p90 ${stats.p90.toFixed(2)}; `;

  let amount: number;
  let clamped: boolean;
  if (modulation.mode === 'multiply') {
    // A factor: base × (1 + amount) at full signal. Relative to the base, so a base of 0 has
    // nothing to multiply and is refused rather than written as a binding that does nothing. The
    // band's share of the range, divided by a small base, would be a huge factor (a slow drift
    // ×13 on every beat), so a factor is also capped per band.
    if (Math.abs(base) < 1e-9) return { ok: false, reason: `${spec.label} is 0, so multiplying it does nothing` };
    const wanted = Math.min((band * span) / Math.abs(base), MULTIPLY_CAP[modulation.intensity] * (1 + jitter));
    const room = modulation.invert ? 1 - Math.max(0, softMin / base) : softMax / base - 1;
    amount = Math.min(wanted, Math.max(0, room));
    clamped = amount < wanted;
    if (modulation.invert) amount = -amount;
  } else {
    const wanted = band * span;
    const room = modulation.invert ? base - softMin : softMax - base;
    amount = Math.min(wanted, Math.max(0, room));
    clamped = amount < wanted;
    if (modulation.invert) amount = -amount;
  }
  amount = spec.type === 'int' ? Math.round(amount) : Number(amount.toPrecision(3));

  // §7: a calibrated amount that rounds to nothing is clutter, not a binding.
  const effect = modulation.mode === 'multiply' ? Math.abs(amount * base) : Math.abs(amount);
  if (effect < span * 0.005) {
    return { ok: false, reason: `the calibrated amount rounds to zero (${spec.label} is ${base} of a ${formatSpan(span)} range, with no room to move)` };
  }
  const how = modulation.mode === 'multiply' ? `×${(1 + amount).toFixed(2)}` : `${amount >= 0 ? '+' : ''}${amount}`;
  return {
    ok: true,
    amount,
    offset: 0,
    attackMs,
    releaseMs,
    note: `${stat}${how} at full signal (${modulation.intensity}, ${Math.round(band * 100)}% of the range${clamped ? ', held under the soft max' : ''})`,
  };
}

function formatSpan(span: number): string {
  return Number(span.toPrecision(3)).toString();
}
