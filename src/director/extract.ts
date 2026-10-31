// Extract as template (auto-director-spec §10 step 2): direct() run backwards.
//
// A project built by hand, or a generated one edited until it looks right, becomes a template
// draft: layers become slots, concrete numbers become intent (each binding's amount is matched
// against what `calibrate` would write for every intensity band on this same track), the palette
// becomes a strategy, and the arrangement curves and keyframes become section states.
//
// A draft is the start of step 3, not the end of it: one candidate per slot, an affinity centred
// on this one track. What cannot become intent is listed in `notes` rather than dropped quietly
// (CLAUDE.md #4), and the output is the raw JSON a person will go on to edit, checked by the same
// `parseTemplate` that will read it back.

import { sampleTrack } from '../engine/core/automation.ts';
import type { AnalysisSet } from '../engine/core/analysis.ts';
import type { CurvePoint } from '../engine/core/modulation.ts';
import { sampleCurve } from '../engine/core/modulation.ts';
import type { ParamSpec } from '../engine/core/params.ts';
import { sourceToTimelineSeconds, ticksToSeconds } from '../engine/core/time.ts';
import type { VocalSegment } from '../lyrics/vocal-segments.ts';
import { GLOBAL_OWNER } from '../project/commands.ts';
import {
  IDENTITY_TRANSFORM, aspectBucket, walkLayers,
  type AspectBucket, type EffectSpec, type ModuleLayer, type ModulationBinding, type ProjectDocument, type Transform,
} from '../project/document.ts';
import { allBindings, describeTarget, paramSpan, parseTarget, targetBase, type SchemaLookup } from '../project/modulation-authoring.ts';
import { PALETTE_ROLES, linkedRole, resolveRole, type PaletteRole } from '../project/palette.ts';
import { timelineDurationTicks } from '../project/snapshot.ts';
import { calibrate, sourceTrack, trackStats, type SourceStats } from './calibrate.ts';
import type { StyleVector, TrackDigest } from './digest.ts';
import type { DirectorModules } from './match.ts';
import { HARMONY, contrastRatio, hexToHsl } from './palette.ts';
import {
  GPU_COST, HARMONIES, INTENSITIES, RESPONSES, SHIFT_ROLES, SLOT_ROLES, STYLE_AXES, parseTemplate,
  type Harmony, type Intensity, type Response, type ShiftRole, type SlotRole, type Template, type TemplateIssue, type TemplateModulation,
} from './template.ts';

export interface ExtractInput {
  readonly document: ProjectDocument;
  readonly modules: DirectorModules;
  readonly digest: TrackDigest;
  readonly style: StyleVector;
  readonly analysis: AnalysisSet | null;
  readonly vocalSegments: readonly VocalSegment[];
}

export interface ExtractResult {
  /** The template's JSON, for the file. */
  readonly raw: Readonly<Record<string, unknown>>;
  /** That JSON as the parser reads it. */
  readonly template: Template;
  /** Anything `parseTemplate` said about it. */
  readonly issues: readonly TemplateIssue[];
  /** What could not become intent, in plain language. */
  readonly notes: readonly string[];
}

export class ExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractError';
  }
}

type Raw = Record<string, unknown>;

/** Slot targets name layers by slot; everything else about a project's ids stays behind. */
interface SlotPlan {
  readonly id: string;
  readonly role: SlotRole;
  readonly layer: ModuleLayer;
  /** Effect id → the key it goes by in the template. */
  readonly effectKeys: ReadonlyMap<string, string>;
}

const TEXT_MODULES: Partial<Record<string, SlotRole>> = { 'core.text.title': 'TEXT', 'core.text.lyrics': 'LYRICS', 'core.source.logo': 'LOGO' };
/** How far the draft's affinity reaches either side of this track. */
const AFFINITY_REACH = 0.2;
/** Both harmony offsets must land this close for the palette to read as that rule. */
const HARMONY_FIT = 20;
const DRAFT_HUE_SPREAD = 30;
const round3 = (v: number) => Number(v.toFixed(3));
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const wrap = (h: number) => ((h % 360) + 360) % 360;
const hueGap = (a: number, b: number) => {
  const d = Math.abs(wrap(a) - wrap(b));
  return Math.min(d, 360 - d);
};

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled';
}

/** The id a template of this name gets, and the file it goes in: `<slug>.json`. */
export function templateIdFor(name: string): string {
  return `tpl.user.${slug(name)}`;
}

function uniqueKey(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) if (!taken.has(`${base}${n}`)) return `${base}${n}`;
}

/** Which role a layer plays: what the director marked it as, or what its module is. */
function roleOf(layer: ModuleLayer, kind: string | undefined, index: number, heroTaken: boolean): SlotRole {
  const known = TEXT_MODULES[layer.module];
  if (known !== undefined) return known;
  if (kind === 'source' || layer.module === 'core.source.background') return index === 0 ? 'BACKDROP' : 'ACCENT';
  return heroTaken ? 'ACCENT' : 'HERO';
}

function transformSpec(t: Partial<Transform>, notes: string[], where: string): Raw {
  const out: Raw = {};
  if (t.x !== undefined && t.x !== IDENTITY_TRANSFORM.x) out['x'] = round3(clamp(t.x, -1, 2));
  if (t.y !== undefined && t.y !== IDENTITY_TRANSFORM.y) out['y'] = round3(clamp(t.y, -1, 2));
  const { scaleX, scaleY } = t;
  if (scaleX !== undefined && scaleY !== undefined && (scaleX !== 1 || scaleY !== 1)) {
    if (Math.abs(scaleX - scaleY) > 1e-6) notes.push(`${where}: a template has one scale, so its ${scaleX} × ${scaleY} became their mean.`);
    out['scale'] = round3(clamp((scaleX + scaleY) / 2, 0.01, 10));
  }
  if (t.rotationDeg !== undefined && t.rotationDeg !== 0) out['rotationDeg'] = round3(clamp(t.rotationDeg, -360, 360));
  if (t.anchor !== undefined && t.anchor !== IDENTITY_TRANSFORM.anchor) out['anchor'] = t.anchor;
  return out;
}

/** The nearest response by attack and release, measured as ratios: 5 to 10 ms is as far as 200 to 400. */
function nearestResponse(attackMs: number, releaseMs: number): Response {
  const distance = (name: Response) => {
    const r = RESPONSES[name];
    return Math.abs(Math.log(Math.max(1, attackMs) / r.attackMs)) + Math.abs(Math.log(Math.max(1, releaseMs) / r.releaseMs));
  };
  return (Object.keys(RESPONSES) as Response[]).sort((a, b) => distance(a) - distance(b))[0] as Response;
}

/**
 * The intent behind a number: the band whose calibrated amount, on this parameter and this track,
 * comes nearest the amount the binding has. Where calibrate refuses every band (a flat source, a
 * base of zero) the amount's share of the range decides.
 */
function nearestIntensity(binding: ModulationBinding, spec: ParamSpec, base: number, stats: SourceStats | null): Intensity {
  const bands = Object.keys(INTENSITIES) as Intensity[];
  const size = Math.abs(binding.amount);
  let best: Intensity | null = null;
  let bestGap = Infinity;
  for (const intensity of bands) {
    const asked: TemplateModulation = {
      targets: [], source: { type: binding.source.type, stem: binding.source.stem, band: binding.source.band, shape: null, rateHz: null, syncDivision: null },
      mode: binding.mode === 'multiply' ? 'multiply' : 'add', intensity, response: 'smooth', invert: binding.amount < 0, label: null,
    };
    const made = calibrate(asked, spec, base, stats, 0);
    if (!made.ok) continue;
    // On a tie the stronger band: a parameter near its soft maximum clamps them all to one amount.
    const gap = Math.abs(Math.abs(made.amount) - size);
    if (gap <= bestGap + 1e-9) {
      bestGap = gap;
      best = intensity;
    }
  }
  if (best !== null) return best;
  const span = paramSpan(spec);
  const share = span > 0 ? size / span : 0;
  return bands.sort((a, b) => Math.abs(INTENSITIES[a] - share) - Math.abs(INTENSITIES[b] - share))[0] as Intensity;
}

function nearestHarmony(hues: Readonly<Record<'primary' | 'secondary' | 'accent', number>>): { harmony: Harmony; error: number } {
  let best: { harmony: Harmony; error: number } = { harmony: 'complementary', error: Infinity };
  for (const harmony of HARMONIES) {
    const [b, c] = HARMONY[harmony];
    const error = Math.max(hueGap(hues.secondary, hues.primary + b), hueGap(hues.accent, hues.primary + c));
    if (error < best.error) best = { harmony, error };
  }
  return best;
}

function paletteSpec(input: ExtractInput, notes: string[]): Raw {
  const { document, style } = input;
  const { palette } = document;
  const colour = (role: PaletteRole) => resolveRole(palette, role);
  const primary = colour('primary');
  const secondary = colour('secondary');
  const accent = colour('accent');
  const background = colour('background');
  const text = colour('text');
  if (primary === undefined || secondary === undefined || accent === undefined || background === undefined) {
    notes.push('The palette has no primary, secondary, accent or background, so the template uses the project\'s own palette.');
    return { strategy: 'user' };
  }
  const p = hexToHsl(primary);
  const ground = hexToHsl(background);
  const mode = ground.l > 0.5 ? 'light' : 'dark';
  const { harmony, error } = nearestHarmony({ primary: p.h, secondary: hexToHsl(secondary).h, accent: hexToHsl(accent).h });
  const shared = { harmony, mode, minTextContrast: text === undefined ? 4.5 : Math.min(4.5, Number(contrastRatio(text, background).toFixed(1))) };
  if (error > HARMONY_FIT || p.s < 0.1) {
    // Colours no rule describes are a choice: the draft keeps them as they are.
    const colors = Object.fromEntries(PALETTE_ROLES.flatMap((role) => {
      const value = colour(role);
      return value === undefined ? [] : [[role, value]];
    }));
    return { strategy: 'fixed', ...shared, colors };
  }
  // Ranges chosen so this track lands exactly on these colours; another track moves from there.
  const axis = 'brightness';
  const start = p.h - DRAFT_HUE_SPREAD * style[axis];
  const satLow = clamp(p.s - 0.2 * style.energy, 0, 0.8);
  const light = mode === 'light';
  const groundAt = light ? style.brightness : 1 - style.darkness;
  const groundLow = clamp(ground.l - 0.06 * groundAt, 0, 0.94);
  return {
    strategy: 'generate-from-style',
    ...shared,
    baseHue: { from: axis, range: [round3(start), round3(start + DRAFT_HUE_SPREAD)] },
    saturation: [round3(satLow), round3(satLow + 0.2)],
    background: [round3(groundLow), round3(groundLow + 0.06)],
  };
}

export function extractTemplate(input: ExtractInput, naming: { readonly id: string; readonly name: string; readonly author?: string }): ExtractResult {
  const { document, modules, digest, style, analysis } = input;
  const notes: string[] = [];
  const schemas: SchemaLookup = (id) => modules.get(id);
  const marks = new Map((document.director?.generated ?? []).map((m) => [m.id, m]));
  const durationSeconds = ticksToSeconds(timelineDurationTicks(document));

  // --- layers → slots -------------------------------------------------------------------------
  const flat: ModuleLayer[] = [];
  let fadeLayer: ModuleLayer | null = null;
  for (const { layer } of walkLayers(document.layers)) {
    if (layer.kind === 'group') {
      if (layer.effects.length > 0 || layer.opacity < 1 || layer.blend !== 'normal') notes.push(`Group "${layer.name}": a template has no groups, so its layers were lifted out and its own effects, opacity and blend left behind.`);
      continue;
    }
    if (!layer.enabled) {
      notes.push(`"${layer.name}" is switched off, so it was left out.`);
      continue;
    }
    if (marks.get(layer.id)?.slot === 'FADE' || (layer.module === 'core.source.background' && layer.modulations.some((b) => b.label === 'Fade'))) {
      fadeLayer = layer;
      continue;
    }
    flat.push(layer);
  }
  if (flat.length === 0) throw new ExtractError('There is nothing to make a template from: the project has no visible layers.');

  const plans: SlotPlan[] = [];
  const slotIds = new Set<string>();
  let heroTaken = false;
  const planned = flat.map((layer, index) => {
    const mark = marks.get(layer.id);
    const bare = mark?.slot.replace(/\d+$/, '');
    const marked = bare !== undefined && (SLOT_ROLES as readonly string[]).includes(bare) && bare !== 'POST' ? bare as SlotRole : undefined;
    const role = marked ?? roleOf(layer, modules.get(layer.module)?.kind, index, heroTaken);
    if (role === 'HERO') heroTaken = true;
    return { layer, role, id: mark?.slot };
  });
  // A template must have a hero; in a project of sources and text, the strongest candidate is it.
  if (!planned.some((p) => p.role === 'HERO' || p.role === 'LYRICS')) {
    const stand = planned.find((p) => p.role === 'ACCENT') ?? planned.find((p) => p.role === 'BACKDROP') ?? (planned[0] as typeof planned[number]);
    stand.role = 'HERO';
    stand.id = undefined;
    notes.push(`Nothing here reads as a visualizer, so "${stand.layer.name}" became the HERO slot.`);
  }
  for (const { layer, role, id: markedId } of planned) {
    const id = uniqueKey(markedId ?? role, slotIds);
    slotIds.add(id);
    const keys = new Set<string>();
    const effectKeys = new Map<string, string>();
    for (const effect of layer.effects) {
      const key = uniqueKey(effect.module.split('.').pop() ?? 'effect', keys);
      keys.add(key);
      effectKeys.set(effect.id, key);
    }
    plans.push({ id, role, layer, effectKeys });
  }
  const globalKeys = new Map<string, string>();
  const postKeys = new Set<string>();
  const globalEffects = document.globalEffects.filter((e) => e.enabled);
  for (const effect of globalEffects) {
    const key = uniqueKey(effect.module.split('.').pop() ?? 'effect', postKeys);
    postKeys.add(key);
    globalKeys.set(effect.id, key);
  }
  document.globalEffects.filter((e) => !e.enabled).forEach((e) => notes.push(`The ${modules.get(e.module)?.name ?? e.module} effect is switched off, so it was left out.`));

  /** A document path in template terms, or null when nothing in the template stands for it. */
  const templateTarget = (target: string): string | null => {
    const path = parseTarget(target);
    if (path === undefined) return null;
    if (path.layerId === GLOBAL_OWNER) {
      const key = path.effectId === null ? undefined : globalKeys.get(path.effectId);
      return key === undefined ? null : `POST.${key}.${path.key}`;
    }
    const plan = plans.find((p) => p.layer.id === path.layerId);
    if (plan === undefined) return null;
    if (path.layerProperty === true) return `${plan.id}.opacity`;
    if (path.effectId === null) return `${plan.id}.params.${path.key}`;
    const key = plan.effectKeys.get(path.effectId);
    return key === undefined ? null : `${plan.id}.fx.${key}.${path.key}`;
  };

  // --- bindings → modulations and arrangement --------------------------------------------------
  const modulations: Raw[] = [];
  const intensityTargets: string[] = [];
  let intensityCurve: readonly CurvePoint[] | null = null;
  let floor = 0.35;
  let drop: Raw | null = null;
  const dropTargets: string[] = [];
  const presence = new Map<string, readonly CurvePoint[]>();
  for (const { binding } of allBindings(document)) {
    if (!binding.enabled) continue;
    const target = templateTarget(binding.target);
    const info = describeTarget(document, binding.target, schemas);
    if (target === null || info.spec === undefined) {
      if (binding.label !== 'Fade') notes.push(`The binding on ${info.label} has nowhere to go in a template: ${info.problem ?? 'it is on a group or a layer left out'}.`);
      continue;
    }
    if (binding.source.type === 'curve') {
      const points = binding.source.points;
      if (binding.label === 'Section intensity') {
        intensityTargets.push(target);
        intensityCurve ??= points;
        floor = round3(clamp(1 - binding.amount, 0, 1));
      } else if (binding.label === 'Drop') {
        dropTargets.push(target);
        const span = paramSpan(info.spec);
        const peak = points.findIndex((p) => p.value === 1);
        const after = peak < 0 ? undefined : points[peak + 1];
        if (drop === null) {
          drop = {
            amount: round3(clamp(span > 0 ? binding.amount / span : 0.4, 0, 1)),
            decaySeconds: peak < 0 || after === undefined ? 0.6 : round3(clamp(ticksToSeconds(after.ticks - (points[peak] as CurvePoint).ticks), 0.05, 10)),
          };
        }
      } else if (binding.label === 'Section presence') {
        const owner = parseTarget(binding.target);
        const plan = plans.find((p) => p.layer.id === owner?.layerId);
        if (plan !== undefined) presence.set(plan.id, points);
      } else notes.push(`The curve on ${info.label} is drawn for this song, so it stayed behind.`);
      continue;
    }
    if (binding.mode === 'replace') {
      notes.push(`The binding on ${info.label} replaces its value outright; templates add or multiply, so it stayed behind.`);
      continue;
    }
    const track = sourceTrack(analysis, binding.source.type, binding.source.stem, binding.source.band);
    const stats = typeof track === 'string' ? null : trackStats(track);
    modulations.push({
      ...(binding.label === null || binding.label === '' ? {} : { label: binding.label }),
      target: [target],
      source: {
        type: binding.source.type,
        stem: binding.source.stem,
        ...(binding.source.band === null ? {} : { band: binding.source.band }),
        ...(typeof track === 'string' ? { shape: binding.source.shape, rateHz: binding.source.rateHz } : {}),
        ...(binding.source.syncDivision === null ? {} : { syncDivision: binding.source.syncDivision }),
      },
      mode: binding.mode,
      intensity: nearestIntensity(binding, info.spec, targetBase(document, binding.target, info.spec), stats),
      response: nearestResponse(binding.envelope.attackMs, binding.envelope.releaseMs),
      ...(binding.amount < 0 || binding.invert ? { invert: true } : {}),
    });
  }
  if (drop !== null) (drop as Raw)['targets'] = dropTargets;

  // --- keyframes → section states --------------------------------------------------------------
  const sectionsOnTimeline = digest.structure.sections.map((s) => {
    const placement = { leadInTicks: document.audio.leadInTicks, clipInTicks: document.audio.clipInTicks };
    return { label: s.label, middle: sourceToTimelineSeconds((s.startSeconds + s.endSeconds) / 2, placement) };
  }).filter((s) => s.middle >= 0 && s.middle <= durationSeconds);
  const labels = [...new Set(sectionsOnTimeline.map((s) => s.label))];
  const labelMean = (label: string, at: (t: number) => number) => {
    const here = sectionsOnTimeline.filter((s) => s.label === label);
    return here.reduce((sum, s) => sum + at(s.middle), 0) / here.length;
  };

  const shiftBySection = new Map<string, ShiftRole>();
  const levelTracks: { target: string; peak: number; at: (t: number) => number }[] = [];
  /** Base values raised to a keyed track's peak, so the section intensity scales it back down. */
  const raisedBase = new Map<string, number>();
  for (const track of document.automation) {
    if (!track.enabled || track.keyframes.length === 0) continue;
    const info = describeTarget(document, track.target, schemas);
    const target = templateTarget(track.target);
    if (target === null || info.spec === undefined) {
      notes.push(`The keyframes on ${track.target} have nowhere to go in a template.`);
      continue;
    }
    if (info.spec.type === 'float' || info.spec.type === 'int') {
      const keys = track.keyframes;
      const peak = Math.max(...keys.map((k) => (typeof k.value === 'number' ? k.value : -Infinity)));
      if (peak <= 0 || !Number.isFinite(peak)) {
        notes.push(`The keyframes on ${info.label} never rise above zero, so no section state can scale them.`);
        continue;
      }
      levelTracks.push({ target, peak, at: (t) => Number(sampleTrack(keys, t, 'number') ?? 0) / peak });
      raisedBase.set(track.target, peak);
    } else if (info.spec.type === 'color') {
      const links = track.keyframes.map((k) => linkedRole(k.value));
      if (links.some((role) => role === undefined)) {
        notes.push(`The keyframes on ${info.label} use literal colours; only palette roles can become a section's palette shift.`);
        continue;
      }
      const base = links[0] as PaletteRole;
      if (base !== 'primary') continue;
      for (const section of sectionsOnTimeline) {
        const shown = linkedRole(sampleTrack(track.keyframes, section.middle, 'discrete'));
        if (shown !== undefined && shown !== 'primary' && (SHIFT_ROLES as readonly string[]).includes(shown)) shiftBySection.set(section.label, shown as ShiftRole);
      }
    } else notes.push(`The keyframes on ${info.label} step between values, which a section state cannot say.`);
  }

  // Curves win: keyed levels only become the intensity when there is no curve to read.
  const sectionLevel = (label: string): number | null => {
    if (intensityCurve !== null) {
      const curve = intensityCurve;
      return round3(clamp(labelMean(label, (t) => sampleCurve(curve, t)), 0, 1));
    }
    if (levelTracks.length === 0) return null;
    return round3(clamp(levelTracks.reduce((sum, track) => sum + labelMean(label, track.at), 0) / levelTracks.length, 0, 1));
  };
  if (intensityCurve === null && levelTracks.length > 0) {
    if (labels.length === 0) notes.push('This track has no sections, so its keyframes could not become section states.');
    else {
      intensityTargets.push(...levelTracks.map((t) => t.target));
      floor = 0;
    }
  } else if (levelTracks.length > 0) {
    raisedBase.clear();
    notes.push(`${levelTracks.length} keyframed value${levelTracks.length === 1 ? '' : 's'} stayed behind: the section intensity curve already says how the sections differ.`);
  }

  const sections: Raw = {};
  for (const label of labels) {
    const level = sectionLevel(label);
    const addLayers: string[] = [];
    const removeLayers: string[] = [];
    for (const [slot, points] of presence) {
      if (labelMean(label, (t) => sampleCurve(points, t)) > 0.5) addLayers.push(slot);
      else removeLayers.push(slot);
    }
    const shift = shiftBySection.get(label);
    const state: Raw = {
      ...(level === null ? {} : { intensity: level }),
      ...(addLayers.length > 0 ? { addLayers } : {}),
      ...(removeLayers.length > 0 ? { removeLayers } : {}),
      ...(shift === undefined ? {} : { paletteShift: shift }),
    };
    if (Object.keys(state).length > 0) sections[label] = state;
  }

  // --- params ----------------------------------------------------------------------------------
  const logoPattern = /logo/i;
  const convertParams = (stored: Readonly<Record<string, unknown>>, specs: readonly ParamSpec[], where: string, needs: { value: string | null }, layerPath: string | null): Raw => {
    const out: Raw = {};
    for (const [key, value] of Object.entries(stored)) {
      const spec = specs.find((s) => s.key === key);
      const raised = layerPath === null ? undefined : raisedBase.get(`${layerPath}${key}`);
      if (raised !== undefined) out[key] = raised;
      else if (spec?.type === 'asset' && typeof value === 'string' && value !== '') {
        const asset = document.assets.find((a) => a.id === value);
        if (asset?.kind === 'image') {
          const logo = logoPattern.test(asset.name);
          out[key] = logo ? '$logo' : '$backgroundImage';
          needs.value = logo ? 'hasLogo' : 'hasBackgroundImage';
        } else notes.push(`${where}: ${asset?.name ?? 'an asset'} belongs to this project, so ${spec.label} starts empty.`);
      } else if (spec?.type === 'color' && typeof value === 'string' && linkedRole(value) === undefined) {
        const role = PALETTE_ROLES.find((r) => resolveRole(document.palette, r)?.toLowerCase() === value.toLowerCase());
        out[key] = role === undefined ? value : `@${role}`;
      } else if (key === 'seed' && spec?.type === 'int') out[key] = '$seed';
      else out[key] = value;
    }
    return out;
  };
  const effectEntries = (effects: readonly EffectSpec[], keyOf: ReadonlyMap<string, string>, where: string, path: (effect: EffectSpec) => string): Raw[] => effects.filter((e) => e.enabled).map((effect) => ({
    key: keyOf.get(effect.id),
    module: effect.module,
    params: convertParams(effect.params, modules.get(effect.module)?.params ?? [], where, { value: null }, path(effect)),
  }));

  // --- slots -----------------------------------------------------------------------------------
  const conditionOf: Partial<Record<SlotRole, string>> = { TEXT: 'hasTitle', LYRICS: 'hasLyrics', LOGO: 'hasLogo' };
  const slots: Raw[] = plans.map(({ id, role, layer, effectKeys }) => {
    const manifest = modules.get(layer.module);
    const specs = manifest?.params ?? [];
    if (manifest === undefined) notes.push(`"${layer.name}" uses ${layer.module}, which is not installed here; the slot names it all the same.`);
    const needs: { value: string | null } = { value: null };
    const params = convertParams(layer.params, specs, layer.name, needs, `layers.${layer.id}.params.`);
    if (role === 'TEXT' && typeof params['text'] === 'string' && params['text'] === document.name) params['text'] = '$title';
    if (layer.module === 'core.source.milkdrop' || typeof params['preset'] === 'string') needs.value ??= 'hasMilkdrop';

    const overrides: Raw = {};
    for (const [aspect, override] of Object.entries(layer.aspectOverrides)) {
      if (override === undefined) continue;
      overrides[aspect] = {
        transform: transformSpec(override.transform, notes, `"${layer.name}" at ${aspect}`),
        params: convertParams(override.params, specs, layer.name, { value: null }, null),
      };
    }
    if (layer.maskLayerId !== null) notes.push(`"${layer.name}" is masked; a template has no masks, so it stands unmasked.`);
    if (role !== 'TEXT' && !presence.has(id) && (layer.timeRange.inTicks > 0 || layer.timeRange.outTicks !== null)) {
      notes.push(`"${layer.name}" has its own time range, which is tied to this song, so it runs for the whole track.`);
    }
    const required = role === 'BACKDROP' || role === 'HERO';
    return {
      id,
      role,
      name: layer.name,
      ...(required ? { required } : {}),
      ...(conditionOf[role] === undefined ? {} : { condition: conditionOf[role] }),
      candidates: [{
        module: layer.module,
        weight: 1,
        label: layer.name || manifest?.name || layer.module,
        ...(needs.value === null || needs.value === conditionOf[role] ? {} : { needs: needs.value }),
        params,
      }],
      transform: transformSpec(layer.transform, notes, `"${layer.name}"`),
      blend: layer.blend,
      opacity: layer.opacity,
      ...(Object.keys(overrides).length > 0 ? { aspectOverrides: overrides } : {}),
      ...(effectKeys.size > 0 ? { effects: effectEntries(layer.effects, effectKeys, layer.name, (e) => `layers.${layer.id}.effects.${e.id}.params.`) } : {}),
    };
  });
  if (globalEffects.length > 0) {
    slots.push({ id: 'POST', role: 'POST', required: true, effects: effectEntries(globalEffects, globalKeys, 'The whole-frame chain', (e) => `global.effects.${e.id}.params.`) });
  }

  // --- what is left ----------------------------------------------------------------------------
  const title = plans.find((p) => p.role === 'TEXT')?.layer;
  const firstVocal = input.vocalSegments[0];
  const titleOut = title?.timeRange.outTicks ?? null;
  const placement = { leadInTicks: document.audio.leadInTicks, clipInTicks: document.audio.clipInTicks };
  const textHold = titleOut === null ? 'none'
    : firstVocal !== undefined && Math.abs(ticksToSeconds(titleOut) - sourceToTimelineSeconds(firstVocal.start, placement)) < 1.5 ? 'untilFirstVocal' : 'intro';

  let fadeIn = 0;
  let fadeOut = 0;
  const fadePoints = (fadeLayer as ModuleLayer | null)?.modulations.find((b) => b.label === 'Fade')?.source.points ?? [];
  if (fadePoints.length >= 2) {
    const [a, b] = fadePoints as readonly [CurvePoint, CurvePoint];
    const last = fadePoints[fadePoints.length - 1] as CurvePoint;
    const before = fadePoints[fadePoints.length - 2] as CurvePoint;
    if (a.value === 1) fadeIn = round3(clamp(ticksToSeconds(b.ticks), 0, 30));
    if (last.value === 1 && fadePoints.length >= 2) fadeOut = round3(clamp(ticksToSeconds(last.ticks - before.ticks), 0, 30));
  }

  const prefer: Raw = {};
  for (const axis of STYLE_AXES) {
    if (!style.unmeasured.includes(axis)) prefer[axis] = [round3(clamp(style[axis] - AFFINITY_REACH, 0, 1)), round3(clamp(style[axis] + AFFINITY_REACH, 0, 1))];
  }
  const aspects = new Set<AspectBucket>([aspectBucket(document.canvas.width, document.canvas.height)]);
  for (const layer of flat) for (const aspect of Object.keys(layer.aspectOverrides)) aspects.add(aspect as AspectBucket);
  const cost = plans.reduce((sum, p) => sum + GPU_COST[modules.get(p.layer.module)?.capabilities.gpuCost ?? 'low'], 0)
    + globalEffects.reduce((sum, e) => sum + GPU_COST[modules.get(e.module)?.capabilities.gpuCost ?? 'low'] / 2, 0);

  const optionalLayers = [...presence.keys()];
  const raw: Raw = {
    formatVersion: 1,
    id: naming.id,
    name: naming.name,
    description: `Extracted from "${document.name}": edit the affinity, add candidates, and try it on other tracks.`,
    author: naming.author ?? '',
    version: 1,
    affinity: { prefer, weight: 1 },
    aspects: [...aspects],
    palette: paletteSpec(input, notes),
    slots,
    modulations,
    arrangement: {
      sections,
      intensityTargets: [...new Set(intensityTargets)],
      floor,
      optionalLayers,
      textHold,
      ...(drop === null ? {} : { drop }),
      fadeIn,
      fadeOut,
    },
    variation: { rerollable: ['palette.baseHue'], locked: ['arrangement'], hueJitter: 15, intensityJitter: 0.1 },
    budget: { maxLayers: Math.max(7, plans.length), maxCost: Math.max(12, Math.ceil(cost) + 2) },
  };
  // Through JSON, so what is checked is what the file will hold.
  const { template, issues } = parseTemplate(JSON.parse(JSON.stringify(raw)));
  return { raw, template, issues, notes };
}
