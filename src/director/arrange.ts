// Arrangement (auto-director-spec §6, D32): giving the video an arc.
//
// Everything here is timing arithmetic on the timeline; what it produces is written into the
// project as ordinary, editable bindings on the `curve` source (the stand-in for keyframes until
// S1 exists — ROADMAP §4) and layer time ranges:
//  - **intensity**: one 0..1 value per section, ramped across boundaries (and across the whole of
//    a build, which rises into what follows). The director multiplies it into the template's
//    intensity targets, so sections differ visibly but coherently — one knob, many parameters.
//  - **presence**: optional layers fade in and out on section boundaries (an opacity curve).
//  - **drops**: a short spike exactly on the detected transient.
//  - **text hold**: the title clears before the first vocal.
//
// The two rules the spec names are enforced here: anti-chaos (no scene change within 8 s of the
// last, at most two layers entering or leaving at one boundary) and anti-monotony (two adjacent
// sections that would look the same are pushed apart). Boundaries snap to the beat grid.

import type { Section, SectionLabel } from '../analysis/sections.ts';
import type { CurvePoint } from '../engine/core/modulation.ts';
import { secondsToTicks, sourceToTimelineSeconds, type AudioPlacement } from '../engine/core/time.ts';
import type { VocalSegment } from '../lyrics/vocal-segments.ts';
import type { TemplateArrangement } from './template.ts';

/** D32: the minimum time between scene changes. */
export const MIN_CHANGE_SECONDS = 8;
/** At most this many layers enter or leave at one boundary; the rest wait for the next. */
export const MAX_CHANGES_PER_BOUNDARY = 2;
/** Intensity ramps across a boundary over this long, centred on it. */
const RAMP_SECONDS = 0.75;
/** Layers fade in and out over this long. */
const FADE_SECONDS = 0.5;

const DEFAULT_INTENSITY: Record<SectionLabel, number> = { intro: 0.35, build: 0.6, main: 0.9, breakdown: 0.45, outro: 0.35 };

export interface ArrangeInput {
  readonly sections: readonly Section[];
  readonly placement: AudioPlacement;
  /** Timeline length. */
  readonly durationSeconds: number;
  /** Source-time beats, onsets, drops and vocal segments, straight from the analysis. */
  readonly beats: readonly number[];
  readonly onsets: readonly number[];
  readonly drops: readonly number[];
  readonly vocalSegments: readonly VocalSegment[];
  readonly arrangement: TemplateArrangement;
  /** Optional slots that were actually filled. */
  readonly optionalSlots: readonly string[];
  /** −1..1, seeded by the motion aspect, per key. */
  readonly jitter: (key: string) => number;
  readonly intensityJitter: number;
}

export interface ArrangedSection {
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly label: SectionLabel;
  readonly intensity: number;
  readonly present: readonly string[];
}

export type Presence =
  | { readonly kind: 'always' }
  | { readonly kind: 'never' }
  | { readonly kind: 'curve'; readonly points: readonly CurvePoint[]; readonly inSeconds: number; readonly outSeconds: number | null };

export interface Arrangement {
  readonly sections: readonly ArrangedSection[];
  /** Empty when the whole track is one section: nothing to arrange. */
  readonly intensity: readonly CurvePoint[];
  readonly presence: ReadonlyMap<string, Presence>;
  /** 0..1 spikes on the drops; empty when there are none. */
  readonly drops: readonly CurvePoint[];
  /** When the title should be gone, timeline seconds; null to leave it up. */
  readonly textOutSeconds: number | null;
  readonly notes: readonly string[];
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function nearest(values: readonly number[], t: number): number | undefined {
  let best: number | undefined;
  for (const v of values) if (best === undefined || Math.abs(v - t) < Math.abs(best - t)) best = v;
  return best;
}

export function arrange(input: ArrangeInput): Arrangement {
  const notes: string[] = [];
  const toTimeline = (s: number) => sourceToTimelineSeconds(s, input.placement);
  const duration = input.durationSeconds;
  const beats = input.beats.map(toTimeline);
  const beatPeriod = beats.length > 1 ? (beats[beats.length - 1]! - beats[0]!) / (beats.length - 1) : 0;
  const snap = (t: number) => {
    const b = nearest(beats, t);
    return b !== undefined && Math.abs(b - t) <= beatPeriod / 2 ? b : t;
  };

  // Section boundaries on the timeline, snapped, and thinned by the anti-chaos rule.
  const raw = input.sections
    .map((s) => ({ start: toTimeline(s.startSeconds), end: toTimeline(s.endSeconds), label: s.label }))
    .filter((s) => s.end > 0 && s.start < duration);
  const merged: { start: number; end: number; label: SectionLabel }[] = [];
  let dropped = 0;
  for (const s of raw) {
    const start = merged.length === 0 ? 0 : snap(s.start);
    const last = merged[merged.length - 1];
    if (last !== undefined && (start - last.start < MIN_CHANGE_SECONDS || duration - start < MIN_CHANGE_SECONDS)) {
      // Too soon after the last change (or too close to the end): one section, labelled by the
      // longer of the two parts.
      if (s.end - start > start - last.start) last.label = s.label;
      last.end = Math.min(duration, s.end);
      dropped += 1;
      continue;
    }
    if (last !== undefined) last.end = start;
    merged.push({ start, end: Math.min(duration, s.end), label: s.label });
  }
  if (merged.length > 0) merged[merged.length - 1]!.end = duration;
  if (dropped > 0) notes.push(`Merged ${dropped} section boundar${dropped === 1 ? 'y' : 'ies'} less than ${MIN_CHANGE_SECONDS} s from the previous change (anti-chaos).`);

  // Layer presence, section by section, at most two changes per boundary.
  const optional = input.arrangement.optionalLayers.filter((id) => input.optionalSlots.includes(id));
  const presentNow = new Set<string>();
  const presentBy: Set<string>[] = [];
  let deferred = 0;
  for (const s of merged) {
    const state = input.arrangement.sections[s.label];
    const wanted = new Set(presentNow);
    for (const id of state?.addLayers ?? []) if (optional.includes(id)) wanted.add(id);
    for (const id of state?.removeLayers ?? []) wanted.delete(id);
    let changes = 0;
    for (const id of optional) {
      if (wanted.has(id) === presentNow.has(id)) continue;
      if (changes >= MAX_CHANGES_PER_BOUNDARY) {
        deferred += 1;
        continue;
      }
      changes += 1;
      if (wanted.has(id)) presentNow.add(id);
      else presentNow.delete(id);
    }
    presentBy.push(new Set(presentNow));
  }
  if (deferred > 0) notes.push(`Deferred ${deferred} layer change${deferred === 1 ? '' : 's'}: at most ${MAX_CHANGES_PER_BOUNDARY} layers enter or leave at one boundary (anti-chaos).`);

  // Intensity per section, jittered, then pushed apart where neighbours would look the same.
  const intensities = merged.map((s, i) => {
    const base = input.arrangement.sections[s.label]?.intensity ?? DEFAULT_INTENSITY[s.label];
    return clamp01(base + input.jitter(`section${i}`) * input.intensityJitter);
  });
  let nudged = 0;
  for (let i = 1; i < merged.length; i += 1) {
    const same = [...presentBy[i]!].sort().join() === [...presentBy[i - 1]!].sort().join();
    if (same && Math.abs(intensities[i]! - intensities[i - 1]!) < 0.1) {
      intensities[i] = clamp01(intensities[i - 1]! + (intensities[i - 1]! < 0.6 ? 0.18 : -0.18));
      nudged += 1;
    }
  }
  if (nudged > 0) notes.push(`Pushed ${nudged} section${nudged === 1 ? '' : 's'} away from ${nudged === 1 ? 'its' : 'their'} neighbour's intensity so consecutive sections differ (anti-monotony).`);

  const sections: ArrangedSection[] = merged.map((s, i) => ({
    startSeconds: s.start,
    endSeconds: s.end,
    label: s.label,
    intensity: Number(intensities[i]!.toFixed(3)),
    present: [...presentBy[i]!].sort(),
  }));

  // The intensity curve: held within a section, ramped across boundaries; a build rises into the
  // section after it.
  const intensity: CurvePoint[] = [];
  const point = (seconds: number, value: number) => ({ ticks: secondsToTicks(Math.max(0, seconds)), value: Number(value.toFixed(3)) });
  if (sections.length > 1) {
    sections.forEach((s, i) => {
      const next = sections[i + 1];
      const previous = sections[i - 1];
      if (previous === undefined || previous.label !== 'build') intensity.push(point(i === 0 ? 0 : s.startSeconds + RAMP_SECONDS / 2, s.intensity));
      if (next === undefined) return;
      if (s.label === 'build') intensity.push(point(s.endSeconds, next.intensity));
      else intensity.push(point(s.endSeconds - RAMP_SECONDS / 2, s.intensity));
    });
  }

  const presence = new Map<string, Presence>();
  for (const id of optional) {
    const flags = sections.map((s) => s.present.includes(id));
    if (flags.every(Boolean)) presence.set(id, { kind: 'always' });
    else if (!flags.some(Boolean)) presence.set(id, { kind: 'never' });
    else {
      const points: CurvePoint[] = [point(0, flags[0] ? 1 : 0)];
      for (let i = 1; i < sections.length; i += 1) {
        if (flags[i] === flags[i - 1]) continue;
        const b = sections[i]!.startSeconds;
        if (flags[i]) points.push(point(b, 0), point(b + FADE_SECONDS, 1));
        else points.push(point(b - FADE_SECONDS, 1), point(b, 0));
      }
      const first = flags.indexOf(true);
      const last = flags.lastIndexOf(true);
      presence.set(id, { kind: 'curve', points, inSeconds: sections[first]!.startSeconds, outSeconds: last === sections.length - 1 ? null : sections[last]!.endSeconds });
    }
  }

  // Drops: exactly on the transient, and never two within the anti-chaos window.
  const drops: CurvePoint[] = [];
  const decay = input.arrangement.drop?.decaySeconds ?? 0.6;
  if (input.arrangement.drop !== null && input.drops.length > 0) {
    const onsets = input.onsets.map(toTimeline);
    let lastDrop = -Infinity;
    let placed = 0;
    for (const d of input.drops.map(toTimeline)) {
      const onset = nearest(onsets, d);
      const t = onset !== undefined && Math.abs(onset - d) <= 0.2 ? onset : snap(d);
      if (t <= 0 || t >= duration || t - lastDrop < MIN_CHANGE_SECONDS) continue;
      if (drops.length === 0) drops.push(point(0, 0));
      const tick = secondsToTicks(t);
      drops.push({ ticks: Math.max(0, tick - 1), value: 0 }, { ticks: tick, value: 1 }, point(t + decay, 0));
      lastDrop = t;
      placed += 1;
    }
    if (placed > 0) notes.push(`${placed} drop${placed === 1 ? '' : 's'}: a ${decay} s impulse on the transient at ${drops.filter((p) => p.value === 1).map((p) => `${(p.ticks / 48_000).toFixed(1)} s`).join(', ')}.`);
  }

  // The title: gone before the first vocal, or at the end of the intro.
  let textOutSeconds: number | null = null;
  const hold = input.arrangement.textHold;
  const introEnd = sections.length > 1 ? Math.min(sections[0]!.endSeconds, 20) : Math.min(8, duration);
  if (hold === 'untilFirstVocal' && input.vocalSegments.length > 0) {
    const firstVocal = toTimeline(input.vocalSegments[0]!.start);
    textOutSeconds = Math.max(2.5, firstVocal - 0.4);
    notes.push(`The title clears at ${textOutSeconds.toFixed(1)} s, before the first vocal at ${firstVocal.toFixed(1)} s.`);
  } else if (hold !== 'none') {
    textOutSeconds = Math.max(2.5, introEnd);
    notes.push(`The title clears at ${textOutSeconds.toFixed(1)} s, at the end of the ${sections[0]?.label === 'intro' ? 'intro' : 'opening'}${hold === 'untilFirstVocal' ? ' (no vocal segments measured — separate stems to time it to the singing)' : ''}.`);
  }
  if (textOutSeconds !== null && textOutSeconds >= duration) textOutSeconds = null;

  return { sections, intensity, presence, drops, textOutSeconds, notes };
}
