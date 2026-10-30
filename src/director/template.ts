// Templates (auto-director-spec §4, M21): where the taste lives.
//
// A template is hand-authored JSON describing *intent* — which roles a composition has, which
// modules may fill each, what drives what and how hard, how the look changes across the song —
// and never raw modulation numbers. The director turns intent into a project calibrated to one
// track (populate.ts, calibrate.ts, arrange.ts). The spec's thesis is that ten excellent templates
// beat a thousand procedural permutations, so this file's job is to make a template easy to read
// and hard to get subtly wrong: everything is validated, and every problem is reported with its
// path rather than silently defaulted.
//
// Differences from the spec's sketch, all deliberate:
//  - Section states are keyed by this build's section labels (intro | build | main | breakdown |
//    outro, sections.ts); the spec's "chorus" is `main`, its "drop" is the separate `drop` entry,
//    placed on the digest's detected drops.
//  - A modulation's `target` may list alternatives, first match wins, because a slot's candidates
//    do not share parameter names (a radial's `radius` is a bar visualizer's `maxHeight`).
//  - The budget is a number: gpuCost low = 1, medium = 2, high = 4, summed and scaled by pixel
//    count relative to 1080p (§5.1 step 5, "over GPU budget at 4K").

import type { SectionLabel } from '../analysis/sections.ts';
import { ANCHORS, ASPECT_BUCKETS, BLEND_MODES, type Anchor, type AspectBucket, type DocumentBlendMode } from '../project/document.ts';

export const TEMPLATE_FORMAT_VERSION = 1;

export const STYLE_AXES = ['tempo', 'energy', 'brightness', 'density', 'organic', 'vocalWeight', 'dynamics', 'darkness'] as const;
export type StyleAxis = (typeof STYLE_AXES)[number];
export type AxisRanges = Readonly<Partial<Record<StyleAxis, readonly [number, number]>>>;

export const SLOT_ROLES = ['BACKDROP', 'HERO', 'ACCENT', 'TEXT', 'LYRICS', 'LOGO', 'POST'] as const;
export type SlotRole = (typeof SLOT_ROLES)[number];

/** Facts about the project a slot or candidate can depend on (§4 `condition`, `needs`). */
export const CONDITIONS = ['hasTitle', 'hasLyrics', 'noLyrics', 'hasLogo', 'hasStems', 'hasBackgroundImage', 'hasMilkdrop'] as const;
export type Condition = (typeof CONDITIONS)[number];

export const INTENSITIES = { subtle: 0.08, medium: 0.25, strong: 0.6 } as const;
export type Intensity = keyof typeof INTENSITIES;

/** Attack / release in ms (§5.2). */
export const RESPONSES = {
  snappy: { attackMs: 5, releaseMs: 120 },
  smooth: { attackMs: 40, releaseMs: 400 },
  slow: { attackMs: 200, releaseMs: 1500 },
} as const;
export type Response = keyof typeof RESPONSES;

export const SECTION_STATES = ['intro', 'build', 'main', 'breakdown', 'outro'] as const satisfies readonly SectionLabel[];

export const PALETTE_STRATEGIES = ['generate-from-style', 'fixed', 'user'] as const;
export type PaletteStrategy = (typeof PALETTE_STRATEGIES)[number];
/** `split`: secondary a quarter turn on, accent the other way — magenta, orange and cyan: synthwave. */
export const HARMONIES = ['analogous', 'complementary', 'triad', 'split', 'duotone', 'mono'] as const;
export type Harmony = (typeof HARMONIES)[number];

export interface TemplateAffinity {
  /** Inside the range scores 1; outside falls off with distance. */
  readonly prefer: AxisRanges;
  /** Inside is neutral; outside costs a little. */
  readonly tolerate: AxisRanges;
  /** Inside is a hard-ish veto: the score is cut to a fifth. */
  readonly avoid: AxisRanges;
  /** Global bias, multiplied in last. */
  readonly weight: number;
  /** Conditions that add to (or, negative, take from) the score — Lyric Focus when lyrics exist. */
  readonly bonus: readonly { readonly condition: Condition; readonly amount: number }[];
}

export interface TemplatePalette {
  readonly strategy: PaletteStrategy;
  readonly harmony: Harmony;
  /** Hue in degrees: `range[0]` when the style axis is 0, `range[1]` at 1. */
  readonly baseHue: { readonly from: StyleAxis; readonly range: readonly [number, number] };
  /** HSL saturation of the primary, chosen by energy within the range. */
  readonly saturation: readonly [number, number];
  /** HSL lightness of the background, darker for darker tracks. */
  readonly background: readonly [number, number];
  /** Light templates put ink on paper: text dark, background light. */
  readonly mode: 'dark' | 'light';
  readonly minTextContrast: number;
  /** `fixed`: the colours, by role. */
  readonly colors: Readonly<Record<string, string>>;
}

export interface TransformSpec {
  readonly x?: number;
  readonly y?: number;
  readonly scale?: number;
  readonly rotationDeg?: number;
  readonly anchor?: Anchor;
}

export interface SlotCandidate {
  readonly module: string;
  readonly weight: number;
  readonly params: Readonly<Record<string, unknown>>;
  /** Asset or project condition this candidate needs (`needs: "hasBackgroundImage"`). */
  readonly needs: Condition | null;
  /** Minimum style axes for this candidate to be considered (§5.1 step 1). */
  readonly minStyle: Readonly<Partial<Record<StyleAxis, number>>>;
  /** For budget and for the history strip ("Radial"). */
  readonly label: string | null;
  /** Transform for this candidate only, over the slot's. */
  readonly transform: TransformSpec;
}

export interface EffectEntry {
  /** How modulations and arrangement refer to it: `POST.bloom.intensity`. */
  readonly key: string;
  readonly module: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly probability: number;
}

export interface TemplateSlot {
  /** Unique within the template; usually the role ("HERO"), or "ACCENT2" for a second accent. */
  readonly id: string;
  readonly role: SlotRole;
  readonly name: string | null;
  readonly required: boolean;
  readonly probability: number;
  readonly condition: Condition | null;
  /** Lower is dropped first when over budget. Required slots are never dropped. */
  readonly priority: number;
  readonly candidates: readonly SlotCandidate[];
  readonly params: Readonly<Record<string, unknown>>;
  readonly transform: TransformSpec;
  readonly blend: DocumentBlendMode;
  readonly opacity: number;
  readonly aspectOverrides: Readonly<Partial<Record<AspectBucket, { readonly transform: TransformSpec; readonly params: Readonly<Record<string, unknown>> }>>>;
  /** On a layer slot: the layer's own chain. On POST: the whole frame's. */
  readonly effects: readonly EffectEntry[];
}

export interface ModulationSourceSpec {
  readonly type: string;
  readonly stem: string;
  readonly band: string | null;
  readonly shape: string | null;
  readonly rateHz: number | null;
  readonly syncDivision: number | null;
}

export interface TemplateModulation {
  /** `SLOT.params.key`, `SLOT.opacity`, `SLOT.fx.<effect>.key`, `POST.<effect>.key`; first that resolves wins. */
  readonly targets: readonly string[];
  readonly source: ModulationSourceSpec;
  /** When a stem is not available, the mix stands in — said in the log (§5.2 needs stems to shine). */
  readonly mode: 'add' | 'multiply';
  readonly intensity: Intensity;
  readonly response: Response;
  readonly invert: boolean;
  readonly label: string | null;
}

export interface SectionState {
  /** 0..1: the one knob that drives every intensity target (§6). */
  readonly intensity: number;
  readonly addLayers: readonly string[];
  readonly removeLayers: readonly string[];
}

export interface TemplateArrangement {
  readonly sections: Readonly<Partial<Record<SectionLabel, SectionState>>>;
  /** What "intensity" moves: target paths as in modulations. */
  readonly intensityTargets: readonly string[];
  /** The factor at intensity 0 — 0.35 means a quiet section keeps 35% of the look's strength. */
  readonly floor: number;
  /** Slots that are present only in sections that add them (and until one removes them). */
  readonly optionalLayers: readonly string[];
  /** When the TEXT slot leaves: before the first vocal, at the end of the intro, or never. */
  readonly textHold: 'untilFirstVocal' | 'intro' | 'none';
  readonly drop: { readonly targets: readonly string[]; readonly amount: number; readonly decaySeconds: number } | null;
  readonly fadeIn: number;
  readonly fadeOut: number;
}

export interface TemplateVariation {
  readonly rerollable: readonly string[];
  readonly locked: readonly string[];
  readonly hueJitter: number;
  readonly intensityJitter: number;
}

export interface Template {
  readonly formatVersion: number;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly author: string;
  readonly version: number;
  readonly affinity: TemplateAffinity;
  readonly aspects: readonly AspectBucket[];
  readonly palette: TemplatePalette;
  readonly slots: readonly TemplateSlot[];
  readonly modulations: readonly TemplateModulation[];
  readonly arrangement: TemplateArrangement;
  readonly variation: TemplateVariation;
  readonly budget: { readonly maxLayers: number; readonly maxCost: number };
}

export interface TemplateIssue {
  readonly path: string;
  readonly detail: string;
}

export class TemplateFormatError extends Error {
  readonly issues: readonly TemplateIssue[];
  constructor(message: string, issues: readonly TemplateIssue[] = []) {
    super(message);
    this.name = 'TemplateFormatError';
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

type Raw = Record<string, unknown>;
const isObject = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A small cursor that reports every problem with its path — the template parser's `Node`. */
class Reader {
  private readonly raw: Raw;
  readonly path: string;
  private readonly issues: TemplateIssue[];

  constructor(raw: Raw, path: string, issues: TemplateIssue[]) {
    this.raw = raw;
    this.path = path;
    this.issues = issues;
  }

  private at(key: string): string {
    return this.path === '' ? key : `${this.path}.${key}`;
  }

  report(key: string, detail: string): void {
    this.issues.push({ path: this.at(key), detail });
  }

  value(key: string): unknown {
    return this.raw[key];
  }

  has(key: string): boolean {
    return this.raw[key] !== undefined && this.raw[key] !== null;
  }

  num(key: string, fallback: number, min = -Infinity, max = Infinity): number {
    const v = this.raw[key];
    if (v === undefined || v === null) return fallback;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      this.report(key, `expected a number, got ${JSON.stringify(v)}`);
      return fallback;
    }
    if (v < min || v > max) {
      this.report(key, `${v} is outside ${min}..${max}`);
      return Math.min(max, Math.max(min, v));
    }
    return v;
  }

  str(key: string, fallback: string, required = false): string {
    const v = this.raw[key];
    if (v === undefined || v === null) {
      if (required) this.report(key, 'required');
      return fallback;
    }
    if (typeof v !== 'string') {
      this.report(key, `expected a string, got ${JSON.stringify(v)}`);
      return fallback;
    }
    return v;
  }

  bool(key: string, fallback: boolean): boolean {
    const v = this.raw[key];
    if (v === undefined || v === null) return fallback;
    if (typeof v !== 'boolean') {
      this.report(key, `expected true or false, got ${JSON.stringify(v)}`);
      return fallback;
    }
    return v;
  }

  oneOf<T extends string>(key: string, options: readonly T[], fallback: T): T {
    const v = this.raw[key];
    if (v === undefined || v === null) return fallback;
    if (typeof v === 'string' && (options as readonly string[]).includes(v)) return v as T;
    this.report(key, `expected one of ${options.join(' | ')}, got ${JSON.stringify(v)}`);
    return fallback;
  }

  nullableOneOf<T extends string>(key: string, options: readonly T[]): T | null {
    return this.has(key) ? this.oneOf(key, options, options[0] as T) : null;
  }

  strings(key: string): string[] {
    const v = this.raw[key];
    if (v === undefined || v === null) return [];
    if (typeof v === 'string') return [v];
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
      this.report(key, 'expected a string or an array of strings');
      return [];
    }
    return v as string[];
  }

  record(key: string): Raw {
    const v = this.raw[key];
    if (v === undefined || v === null) return {};
    if (!isObject(v)) {
      this.report(key, 'expected an object');
      return {};
    }
    return { ...v };
  }

  child(key: string): Reader {
    const v = this.raw[key];
    if (v !== undefined && v !== null && !isObject(v)) this.report(key, 'expected an object');
    return new Reader(isObject(v) ? v : {}, this.at(key), this.issues);
  }

  children(key: string): Reader[] {
    const v = this.raw[key];
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) {
      this.report(key, 'expected an array');
      return [];
    }
    return v.flatMap((entry, i) => {
      if (!isObject(entry)) {
        this.issues.push({ path: `${this.at(key)}[${i}]`, detail: 'expected an object' });
        return [];
      }
      return [new Reader(entry, `${this.at(key)}[${i}]`, this.issues)];
    });
  }

  keys(): string[] {
    return Object.keys(this.raw);
  }

  /** Report keys no parser asked for: a misspelt `probabilty` must not silently mean "always". */
  unknown(known: readonly string[]): void {
    for (const key of Object.keys(this.raw)) if (!known.includes(key)) this.report(key, 'not a template field (misspelt?)');
  }
}

function axisRanges(r: Reader): AxisRanges {
  const out: Partial<Record<StyleAxis, readonly [number, number]>> = {};
  for (const key of r.keys()) {
    if (!(STYLE_AXES as readonly string[]).includes(key)) {
      r.report(key, `not a style axis (${STYLE_AXES.join(', ')})`);
      continue;
    }
    const range = pair(r, key, [0, 1]);
    if (range !== null) out[key as StyleAxis] = range;
  }
  return out;
}

/**
 * `[lo, hi]`, or the word "any" meaning the whole axis. `directed` allows `lo > hi` — a hue range
 * says which way round the wheel the style axis moves it.
 */
function pair(r: Reader, key: string, whole: readonly [number, number], directed = false): readonly [number, number] | null {
  const v = r.value(key);
  if (v === 'any') return whole;
  if (Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number' && Number.isFinite(x)) && (directed || (v[0] as number) <= (v[1] as number))) {
    return [v[0] as number, v[1] as number];
  }
  r.report(key, `expected [low, high] or "any", got ${JSON.stringify(v)}`);
  return null;
}

function transformSpec(r: Reader): TransformSpec {
  r.unknown(['x', 'y', 'scale', 'rotationDeg', 'anchor']);
  return {
    ...(r.has('x') ? { x: r.num('x', 0.5, -1, 2) } : {}),
    ...(r.has('y') ? { y: r.num('y', 0.5, -1, 2) } : {}),
    ...(r.has('scale') ? { scale: r.num('scale', 1, 0.01, 10) } : {}),
    ...(r.has('rotationDeg') ? { rotationDeg: r.num('rotationDeg', 0, -360, 360) } : {}),
    ...(r.has('anchor') ? { anchor: r.oneOf('anchor', ANCHORS, 'center') } : {}),
  };
}

function effectEntry(r: Reader, index: number): EffectEntry {
  r.unknown(['key', 'module', 'params', 'probability']);
  const module = r.str('module', '', true);
  return {
    key: r.str('key', module.split('.').pop() ?? `effect${index}`),
    module,
    params: r.record('params'),
    probability: r.num('probability', 1, 0, 1),
  };
}

const DEFAULT_PRIORITY: Record<SlotRole, number> = { BACKDROP: 90, HERO: 80, LYRICS: 70, TEXT: 60, LOGO: 50, ACCENT: 30, POST: 100 };

function slot(r: Reader): TemplateSlot {
  r.unknown(['id', 'role', 'name', 'required', 'probability', 'condition', 'priority', 'candidates', 'params', 'transform', 'blend', 'opacity', 'aspectOverrides', 'effects']);
  const role = r.oneOf('role', SLOT_ROLES, 'ACCENT');
  if (!r.has('role')) r.report('role', 'required');
  const overrides: Partial<Record<AspectBucket, { transform: TransformSpec; params: Raw }>> = {};
  const rawOverrides = r.child('aspectOverrides');
  for (const key of rawOverrides.keys()) {
    if (!(ASPECT_BUCKETS as readonly string[]).includes(key)) {
      rawOverrides.report(key, `not an aspect (${ASPECT_BUCKETS.join(', ')})`);
      continue;
    }
    const o = rawOverrides.child(key);
    o.unknown(['transform', 'params']);
    overrides[key as AspectBucket] = { transform: transformSpec(o.child('transform')), params: o.record('params') };
  }
  const candidates = r.children('candidates').map((c): SlotCandidate => {
    c.unknown(['module', 'weight', 'params', 'needs', 'minStyle', 'label', 'transform']);
    const minStyle: Partial<Record<StyleAxis, number>> = {};
    const rawMin = c.child('minStyle');
    for (const key of rawMin.keys()) {
      if (!(STYLE_AXES as readonly string[]).includes(key)) rawMin.report(key, 'not a style axis');
      else minStyle[key as StyleAxis] = rawMin.num(key, 0, 0, 1);
    }
    return {
      module: c.str('module', '', true),
      weight: c.num('weight', 1, 0),
      params: c.record('params'),
      needs: c.nullableOneOf('needs', CONDITIONS),
      minStyle,
      label: c.has('label') ? c.str('label', '') : null,
      transform: transformSpec(c.child('transform')),
    };
  });
  const effects = r.children('effects').map(effectEntry);
  if (role === 'POST' && candidates.length > 0) r.report('candidates', 'POST holds effects, not layers');
  if (role !== 'POST' && role !== 'LYRICS' && candidates.length === 0) r.report('candidates', 'a layer slot needs at least one candidate');
  return {
    id: r.str('id', role),
    role,
    name: r.has('name') ? r.str('name', '') : null,
    required: r.bool('required', false),
    probability: r.num('probability', 1, 0, 1),
    condition: r.nullableOneOf('condition', CONDITIONS),
    priority: r.num('priority', DEFAULT_PRIORITY[role]),
    candidates,
    params: r.record('params'),
    transform: transformSpec(r.child('transform')),
    blend: r.oneOf('blend', BLEND_MODES, 'normal'),
    opacity: r.num('opacity', 1, 0, 1),
    aspectOverrides: overrides,
    effects,
  };
}

function modulation(r: Reader): TemplateModulation {
  r.unknown(['target', 'source', 'mode', 'intensity', 'response', 'invert', 'label']);
  const targets = r.strings('target');
  if (targets.length === 0) r.report('target', 'required');
  const s = r.child('source');
  s.unknown(['type', 'stem', 'band', 'shape', 'rateHz', 'syncDivision']);
  return {
    targets,
    source: {
      type: s.str('type', 'rms', true),
      stem: s.str('stem', 'mix'),
      band: s.has('band') ? s.str('band', '') : null,
      shape: s.has('shape') ? s.str('shape', 'sine') : null,
      rateHz: s.has('rateHz') ? s.num('rateHz', 1, 0) : null,
      syncDivision: s.has('syncDivision') ? s.num('syncDivision', 1, 0) : null,
    },
    mode: r.oneOf('mode', ['add', 'multiply'] as const, 'add'),
    intensity: r.oneOf('intensity', Object.keys(INTENSITIES) as Intensity[], 'medium'),
    response: r.oneOf('response', Object.keys(RESPONSES) as Response[], 'smooth'),
    invert: r.bool('invert', false),
    label: r.has('label') ? r.str('label', '') : null,
  };
}

function arrangement(r: Reader): TemplateArrangement {
  r.unknown(['sections', 'intensityTargets', 'floor', 'optionalLayers', 'textHold', 'drop', 'fadeIn', 'fadeOut']);
  const sections: Partial<Record<SectionLabel, SectionState>> = {};
  const rawSections = r.child('sections');
  for (const key of rawSections.keys()) {
    if (!(SECTION_STATES as readonly string[]).includes(key)) {
      rawSections.report(key, `not a section label (${SECTION_STATES.join(', ')})`);
      continue;
    }
    const s = rawSections.child(key);
    s.unknown(['intensity', 'addLayers', 'removeLayers']);
    sections[key as SectionLabel] = { intensity: s.num('intensity', 0.6, 0, 1), addLayers: s.strings('addLayers'), removeLayers: s.strings('removeLayers') };
  }
  const drop = r.has('drop') ? r.child('drop') : null;
  drop?.unknown(['targets', 'amount', 'decaySeconds']);
  return {
    sections,
    intensityTargets: r.strings('intensityTargets'),
    floor: r.num('floor', 0.35, 0, 1),
    optionalLayers: r.strings('optionalLayers'),
    textHold: r.oneOf('textHold', ['untilFirstVocal', 'intro', 'none'] as const, 'none'),
    drop: drop === null ? null : { targets: drop.strings('targets'), amount: drop.num('amount', 0.4, 0, 1), decaySeconds: drop.num('decaySeconds', 0.6, 0.05, 10) },
    fadeIn: r.num('fadeIn', 0, 0, 30),
    fadeOut: r.num('fadeOut', 0, 0, 30),
  };
}

/** A template from its JSON. Throws only when it is not a template at all; everything else is an issue. */
export function parseTemplate(raw: unknown): { template: Template; issues: TemplateIssue[] } {
  if (!isObject(raw)) throw new TemplateFormatError('A template must be a JSON object.');
  const issues: TemplateIssue[] = [];
  const r = new Reader(raw, '', issues);
  const formatVersion = r.num('formatVersion', 0);
  if (formatVersion > TEMPLATE_FORMAT_VERSION) {
    throw new TemplateFormatError(`This template needs format ${formatVersion}; this build reads up to ${TEMPLATE_FORMAT_VERSION}.`);
  }
  if (formatVersion < 1) throw new TemplateFormatError('A template needs "formatVersion": 1.');
  r.unknown(['formatVersion', 'id', 'name', 'description', 'author', 'version', 'affinity', 'aspects', 'palette', 'slots', 'modulations', 'arrangement', 'variation', 'budget']);

  const a = r.child('affinity');
  a.unknown(['prefer', 'tolerate', 'avoid', 'weight', 'bonus']);
  const p = r.child('palette');
  p.unknown(['strategy', 'harmony', 'baseHue', 'saturation', 'background', 'mode', 'minTextContrast', 'colors']);
  const hue = p.child('baseHue');
  hue.unknown(['from', 'range']);
  const v = r.child('variation');
  v.unknown(['rerollable', 'locked', 'hueJitter', 'intensityJitter']);
  const b = r.child('budget');
  b.unknown(['maxLayers', 'maxCost']);

  const template: Template = {
    formatVersion,
    id: r.str('id', '', true),
    name: r.str('name', '', true),
    description: r.str('description', ''),
    author: r.str('author', ''),
    version: r.num('version', 1, 0),
    affinity: {
      prefer: axisRanges(a.child('prefer')),
      tolerate: axisRanges(a.child('tolerate')),
      avoid: axisRanges(a.child('avoid')),
      weight: a.num('weight', 1, 0),
      bonus: a.children('bonus').map((x) => {
        x.unknown(['condition', 'amount']);
        return { condition: x.oneOf('condition', CONDITIONS, 'hasLyrics'), amount: x.num('amount', 0, -1, 1) };
      }),
    },
    aspects: r.strings('aspects').filter((aspect): aspect is AspectBucket => {
      const ok = (ASPECT_BUCKETS as readonly string[]).includes(aspect);
      if (!ok) r.report('aspects', `"${aspect}" is not an aspect`);
      return ok;
    }),
    palette: {
      strategy: p.oneOf('strategy', PALETTE_STRATEGIES, 'generate-from-style'),
      harmony: p.oneOf('harmony', HARMONIES, 'complementary'),
      baseHue: { from: hue.oneOf('from', STYLE_AXES, 'brightness'), range: hue.has('range') ? (pair(hue, 'range', [0, 360], true) ?? [0, 360]) : [0, 360] },
      saturation: p.has('saturation') ? (pair(p, 'saturation', [0, 1]) ?? [0.6, 0.9]) : [0.6, 0.9],
      background: p.has('background') ? (pair(p, 'background', [0, 1]) ?? [0.04, 0.12]) : [0.04, 0.12],
      mode: p.oneOf('mode', ['dark', 'light'] as const, 'dark'),
      minTextContrast: p.num('minTextContrast', 4.5, 1, 21),
      colors: Object.fromEntries(Object.entries(p.record('colors')).filter(([, c]) => typeof c === 'string')) as Record<string, string>,
    },
    slots: r.children('slots').map(slot),
    modulations: r.children('modulations').map(modulation),
    arrangement: arrangement(r.child('arrangement')),
    variation: {
      rerollable: v.strings('rerollable'),
      locked: v.strings('locked'),
      hueJitter: v.num('hueJitter', 20, 0, 180),
      intensityJitter: v.num('intensityJitter', 0.1, 0, 0.5),
    },
    budget: { maxLayers: b.num('maxLayers', 7, 1, 32), maxCost: b.num('maxCost', 10, 1, 100) },
  };
  validateReferences(template, issues);
  return { template, issues };
}

/** Slot ids unique, and every reference to a slot or effect names one that exists. */
function validateReferences(template: Template, issues: TemplateIssue[]): void {
  const ids = new Set<string>();
  template.slots.forEach((s, i) => {
    if (ids.has(s.id)) issues.push({ path: `slots[${i}].id`, detail: `duplicate slot id "${s.id}"` });
    ids.add(s.id);
  });
  if (!template.slots.some((s) => s.role === 'HERO' || s.role === 'LYRICS')) {
    issues.push({ path: 'slots', detail: 'a template needs a HERO (or LYRICS) slot' });
  }
  const checkTarget = (path: string, target: string) => {
    const problem = targetProblem(template, target);
    if (problem !== null) issues.push({ path, detail: problem });
  };
  template.modulations.forEach((m, i) => m.targets.forEach((t, j) => checkTarget(`modulations[${i}].target[${j}]`, t)));
  template.arrangement.intensityTargets.forEach((t, i) => checkTarget(`arrangement.intensityTargets[${i}]`, t));
  template.arrangement.drop?.targets.forEach((t, i) => checkTarget(`arrangement.drop.targets[${i}]`, t));
  const slotRef = (path: string, id: string) => {
    if (!ids.has(id)) issues.push({ path, detail: `no slot "${id}"` });
  };
  template.arrangement.optionalLayers.forEach((id, i) => slotRef(`arrangement.optionalLayers[${i}]`, id));
  for (const [label, state] of Object.entries(template.arrangement.sections)) {
    state?.addLayers.forEach((id, i) => slotRef(`arrangement.sections.${label}.addLayers[${i}]`, id));
    state?.removeLayers.forEach((id, i) => slotRef(`arrangement.sections.${label}.removeLayers[${i}]`, id));
  }
}

/** A target path in template terms, parsed. */
export type TemplateTarget =
  | { readonly kind: 'param'; readonly slot: string; readonly key: string }
  | { readonly kind: 'opacity'; readonly slot: string }
  | { readonly kind: 'effect'; readonly slot: string; readonly effect: string; readonly key: string };

export function parseTemplateTarget(target: string): TemplateTarget | undefined {
  const parts = target.split('.');
  if (parts.length === 2 && parts[1] === 'opacity') return { kind: 'opacity', slot: parts[0] as string };
  if (parts.length === 3 && parts[1] === 'params') return { kind: 'param', slot: parts[0] as string, key: parts[2] as string };
  if (parts.length === 4 && parts[1] === 'fx') return { kind: 'effect', slot: parts[0] as string, effect: parts[2] as string, key: parts[3] as string };
  // POST.<effect>.<key>: the spec's own spelling for the whole-frame chain.
  if (parts.length === 3 && parts[0] === 'POST') return { kind: 'effect', slot: 'POST', effect: parts[1] as string, key: parts[2] as string };
  return undefined;
}

function targetProblem(template: Template, target: string): string | null {
  const parsed = parseTemplateTarget(target);
  if (parsed === undefined) return `"${target}" is not a target (SLOT.params.key, SLOT.opacity, SLOT.fx.effect.key or POST.effect.key)`;
  const slot = template.slots.find((s) => s.id === parsed.slot);
  if (slot === undefined) return `no slot "${parsed.slot}"`;
  if (parsed.kind === 'effect' && !slot.effects.some((e) => e.key === parsed.effect)) return `slot ${slot.id} has no effect "${parsed.effect}"`;
  if (parsed.kind !== 'effect' && slot.role === 'POST') return 'POST has effects, not parameters';
  return null;
}
