// Template matching (auto-director-spec §3–§4 affinity, D29).
//
// Soft scoring, not gates: every axis a template prefers contributes how close the track sits to
// the preferred range; a tolerated range costs nothing inside and a little outside; an avoided
// range is a hard-ish veto (the score is cut to a fifth, so the template can still win when
// nothing else fits). Axes the digest could not measure (no stems → no vocal weight) are left out
// of the average rather than counted as a neutral 0.5 — a template must not win or lose on a guess.
//
// Availability comes first (D29): a candidate module that is not installed is substituted by the
// installed module of the same kind sharing the most tags, and said so; a required slot left with
// no candidate makes the template unavailable, with the reason.

import type { ModuleManifest } from '../engine/core/module.ts';
import type { StyleVector } from './digest.ts';
import { STYLE_AXES, type AxisRanges, type Condition, type SlotCandidate, type StyleAxis, type Template } from './template.ts';

export interface DirectorModules {
  get(id: string): ModuleManifest | undefined;
  readonly all: readonly ModuleManifest[];
}

export interface Availability {
  readonly available: boolean;
  /** Why not, when not. */
  readonly reason: string | null;
  /** Candidate module → the installed module standing in for it. */
  readonly substitutes: ReadonlyMap<string, string>;
  readonly notes: readonly string[];
}

/** Whether every module the template needs is here, substituting by tag where it is not (D29). */
export function templateAvailability(template: Template, modules: DirectorModules): Availability {
  const substitutes = new Map<string, string>();
  const notes: string[] = [];
  for (const slot of template.slots) {
    let usable = 0;
    for (const candidate of slot.candidates) {
      if (modules.get(candidate.module) !== undefined) {
        usable += 1;
        continue;
      }
      const stand = substituteFor(candidate, modules);
      if (stand !== undefined) {
        substitutes.set(candidate.module, stand.id);
        notes.push(`${candidate.module} is not installed; ${stand.name} stands in for it in ${slot.id} (shared tags).`);
        usable += 1;
      } else {
        notes.push(`${candidate.module} is not installed and nothing shares its role; ${slot.id} will not offer it.`);
      }
    }
    if (slot.required && slot.candidates.length > 0 && usable === 0) {
      return { available: false, reason: `its ${slot.id} slot needs ${slot.candidates.map((c) => c.module).join(' or ')}, and none is installed`, substitutes, notes };
    }
    for (const effect of slot.effects) {
      if (modules.get(effect.module) === undefined) notes.push(`effect ${effect.module} is not installed; ${slot.id} goes without it.`);
    }
  }
  return { available: true, reason: null, substitutes, notes };
}

/**
 * The installed module of the same kind sharing the most tags with the missing one. The missing
 * one's tags are unknown (it is missing), so its id's last segment and the candidate's label stand
 * in: "core.visualizer.rings" looks for modules tagged "rings".
 */
function substituteFor(candidate: SlotCandidate, modules: DirectorModules): ModuleManifest | undefined {
  const [, kindWord, last] = candidate.module.split('.');
  const words = new Set([last, candidate.label?.toLowerCase()].filter((w): w is string => w !== undefined));
  let best: ModuleManifest | undefined;
  let bestScore = 0;
  for (const manifest of modules.all) {
    if (kindWord !== undefined && !manifest.id.includes(`.${kindWord}.`)) continue;
    const score = manifest.tags.filter((tag) => words.has(tag)).length;
    if (score > bestScore) {
      best = manifest;
      bestScore = score;
    }
  }
  return best;
}

export interface TemplateScore {
  readonly template: Template;
  readonly score: number;
  readonly availability: Availability;
  /** Per-axis contributions and bonuses, for the log and the picker's tooltip. */
  readonly reasons: readonly string[];
}

/** 1 inside the range, falling linearly to 0 at 0.5 outside it. */
function closeness(value: number, [lo, hi]: readonly [number, number]): number {
  if (value >= lo && value <= hi) return 1;
  const distance = value < lo ? lo - value : value - hi;
  return Math.max(0, 1 - distance * 2);
}

function inside(value: number, [lo, hi]: readonly [number, number]): boolean {
  return value >= lo && value <= hi;
}

export function scoreTemplate(template: Template, style: StyleVector, conditions: ReadonlySet<Condition>, modules: DirectorModules, aspect: string): TemplateScore {
  const availability = templateAvailability(template, modules);
  const reasons: string[] = [];
  const measured = (axis: StyleAxis) => !style.unmeasured.includes(axis);
  const axes = (ranges: AxisRanges) => STYLE_AXES.filter((axis) => ranges[axis] !== undefined && measured(axis));

  const prefer = axes(template.affinity.prefer);
  let score = prefer.length === 0 ? 0.5 : 0;
  for (const axis of prefer) {
    const c = closeness(style[axis], template.affinity.prefer[axis]!);
    score += c / prefer.length;
    if (c < 1) reasons.push(`${axis} ${style[axis].toFixed(2)} is outside ${fmt(template.affinity.prefer[axis]!)}`);
  }
  for (const axis of axes(template.affinity.tolerate)) {
    const c = closeness(style[axis], template.affinity.tolerate[axis]!);
    if (c < 1) {
      score -= (1 - c) * 0.15;
      reasons.push(`${axis} ${style[axis].toFixed(2)} is past what it tolerates`);
    }
  }
  for (const axis of axes(template.affinity.avoid)) {
    if (inside(style[axis], template.affinity.avoid[axis]!)) {
      score *= 0.2;
      reasons.push(`it avoids ${axis} in ${fmt(template.affinity.avoid[axis]!)}`);
    }
  }
  for (const { condition, amount } of template.affinity.bonus) {
    if (conditions.has(condition)) {
      score += amount;
      reasons.push(`${amount >= 0 ? '+' : ''}${amount} for ${condition}`);
    }
  }
  if (template.aspects.length > 0 && !(template.aspects as readonly string[]).includes(aspect)) {
    score *= 0.8;
    reasons.push(`designed for ${template.aspects.join(', ')}, not ${aspect}`);
  }
  score = Math.max(0, score) * template.affinity.weight;
  return { template, score: availability.available ? score : 0, availability, reasons };
}

/** Every template, best first. Ties break by id, so the order never depends on load order. */
export function rankTemplates(
  templates: readonly Template[],
  style: StyleVector,
  conditions: ReadonlySet<Condition>,
  modules: DirectorModules,
  aspect: string,
): TemplateScore[] {
  return templates
    .map((t) => scoreTemplate(t, style, conditions, modules, aspect))
    .sort((a, b) => b.score - a.score || (a.template.id < b.template.id ? -1 : 1));
}

function fmt([lo, hi]: readonly [number, number]): string {
  return `${lo}–${hi}`;
}
