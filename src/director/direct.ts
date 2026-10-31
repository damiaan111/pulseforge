// The auto-director (auto-director-spec §1, M21, M22): a track in, a complete project out.
//
//   classify → match → palette → populate → calibrate → arrange → guardrails → assemble
//
// Everything it writes is an ordinary layer, effect or binding, so the result is edited like any
// hand-built project; the decision log says what was chosen and why (§8). It is a pure function of
// its inputs and a seed: the same track, template, seed and locks make the same project on any
// machine — ids included, which come from the seed rather than the clock.
//
// Rerolls (§9) keep what the user has touched. Every layer, global effect, global binding and
// keyframe track the director writes is recorded with a fingerprint of its content (fingerprint.ts).
// On the next run anything still matching its fingerprint is the director's to replace; anything
// that no longer matches was edited and is kept, still filling its slot. Keys live beside the layer
// they animate, out of its fingerprint's sight, so keys the user set on a generated layer or effect
// count as an edit to it: replacing it would orphan them. Layers the user added are kept where they
// were, relative to the director's.

import { keyName } from '../analysis/key.ts';
import type { Section } from '../analysis/sections.ts';
import type { AnalysisSet } from '../engine/core/analysis.ts';
import type { DecodedImage } from '../engine/core/image.ts';
import type { CurvePoint } from '../engine/core/modulation.ts';
import type { ModuleManifest } from '../engine/core/module.ts';
import type { ParamSpec } from '../engine/core/params.ts';
import { hash32, random01 } from '../engine/core/prng.ts';
import { secondsToTicks, ticksToSeconds } from '../engine/core/time.ts';
import type { VocalSegment } from '../lyrics/vocal-segments.ts';
import { GLOBAL_OWNER } from '../project/commands.ts';
import { createBinding, createEffect, createModuleLayer } from '../project/create.ts';
import {
  DIRECTOR_HISTORY_LIMIT, IDENTITY_TRANSFORM, aspectBucket, walkLayers,
  type AspectBucket, type AspectOverride, type AutomationTrack, type DecisionEntry, type DecisionStep, type DirectorAspect, type DirectorLock,
  type DirectorRoll, type EffectSpec, type GeneratedMark, type Layer, type ModulationBinding, type ModuleLayer,
  type Palette, type ProjectDocument, type Transform,
} from '../project/document.ts';
import { createIdFactory } from '../project/ids.ts';
import { OPACITY_SPEC, paramSpan, parseTarget } from '../project/modulation-authoring.ts';
import { linkedRole, resolveRole, roleLink } from '../project/palette.ts';
import { timelineDurationTicks } from '../project/snapshot.ts';
import { arrange } from './arrange.ts';
import { calibrate, sourceTrack, trackStats } from './calibrate.ts';
import { describeStyle, type StyleVector, type TrackDigest } from './digest.ts';
import { fingerprint } from './fingerprint.ts';
import { rankTemplates, type DirectorModules, type TemplateScore } from './match.ts';
import { chooseLook, milkdropLooks } from './milkdrop.ts';
import { contrastRatio, derivePalette, generatePalette, hexToHsl, hueName, type GeneratedPalette } from './palette.ts';
import { roleKeys, worstContrast } from './palette-shift.ts';
import {
  parseTemplateTarget, type Condition, type EffectEntry, type SlotCandidate, type SlotRole, type Template, type TemplateSlot, type TransformSpec,
} from './template.ts';

export interface DirectorInput {
  readonly document: ProjectDocument;
  readonly templates: readonly Template[];
  readonly modules: DirectorModules;
  readonly digest: TrackDigest;
  readonly style: StyleVector;
  /** For the calibration statistics in the log, and to know which stems exist. */
  readonly analysis: AnalysisSet | null;
  /** Source seconds. */
  readonly beats: readonly number[];
  readonly onsets: readonly number[];
  readonly vocalSegments: readonly VocalSegment[];
  /** The title slot's text: the project's name or the track's. */
  readonly title: string;
  /** The MilkDrop presets installed here, by name; empty when the component is not. */
  readonly milkdropPresets: readonly string[];
  /** Decoded image assets by content hash; absent where nothing decoded them (a batch). */
  readonly images?: ReadonlyMap<string, DecodedImage>;
  /** A picture the user chose as the colour source: it leads any palette that is not fixed. */
  readonly colourImage?: { readonly name: string; readonly image: DecodedImage } | null;
}

export interface DirectOptions {
  /** The master seed; each aspect draws its own from it unless locked. */
  readonly seed: number;
  /** An explicit template choice (the picker). Otherwise the best match, or roulette. */
  readonly templateId?: string | null;
  readonly locks?: readonly DirectorLock[];
  /** Surprise me across templates: pick among the top matches, weighted by score. */
  readonly roulette?: boolean;
  /** Restoring a roll from the history strip: its exact aspect seeds and palette. */
  readonly restore?: DirectorRoll;
}

export interface DirectResult {
  readonly document: ProjectDocument;
  readonly roll: DirectorRoll;
  readonly log: readonly DecisionEntry[];
  readonly template: Template;
  readonly ranked: readonly TemplateScore[];
}

export class DirectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DirectorError';
  }
}

const COST = { low: 1, medium: 2, high: 4 } as const;
const ROLE_MODULE: Partial<Record<SlotRole, string>> = { TEXT: 'core.text.title', LYRICS: 'core.text.lyrics', LOGO: 'core.source.logo' };
/** What a layer is called when neither the slot nor the candidate names it. */
const ROLE_NAME: Partial<Record<SlotRole, string>> = { TEXT: 'Title', LYRICS: 'Lyrics', LOGO: 'Logo' };
/** Sources that read the analysis (the rest are generators, curves and lyric signals). */
const AUDIO_SOURCES = new Set(['band', 'rms', 'peak', 'onset', 'beat', 'centroid', 'flux', 'stereoWidth']);
/** Safe area for text and logos in a vertical frame: clear of platform UI top and bottom. */
const SAFE_Y: readonly [number, number] = [0.12, 0.84];

/** The facts a slot's `condition` or a candidate's `needs` can test. */
export function projectConditions(document: ProjectDocument, analysis: AnalysisSet | null, title: string, milkdropPresets: readonly string[]): Set<Condition> {
  const out = new Set<Condition>();
  if (milkdropLooks(milkdropPresets).length > 0) out.add('hasMilkdrop');
  if (title.trim() !== '') out.add('hasTitle');
  out.add(document.lyrics.lines.some((line) => line.startTicks !== null) ? 'hasLyrics' : 'noLyrics');
  const images = document.assets.filter((a) => a.kind === 'image');
  if (images.some((a) => /logo/i.test(a.name))) out.add('hasLogo');
  if (images.some((a) => !/logo/i.test(a.name))) out.add('hasBackgroundImage');
  if (analysis !== null && (analysis.sources.has('drums') || analysis.sources.has('vocals'))) out.add('hasStems');
  return out;
}

interface Filled {
  readonly slot: TemplateSlot;
  layer: ModuleLayer;
  readonly manifest: ModuleManifest;
  readonly label: string;
  /** A layer the user edited since the last roll: filled, but never touched. */
  readonly kept: boolean;
  /** Effect key (template) → the effect written for it. */
  readonly effects: ReadonlyMap<string, EffectSpec>;
}

type Resolved =
  | { readonly ok: true; readonly ownerId: string; readonly path: string; readonly spec: ParamSpec; readonly base: number; readonly where: string; readonly kept: boolean }
  | { readonly ok: false; readonly reason: string };

export function direct(input: DirectorInput, options: DirectOptions): DirectResult {
  const { document, modules, style } = input;
  const log: DecisionEntry[] = [];
  const note = (step: DecisionStep, text: string, data: Record<string, unknown> = {}) => log.push({ step, text, data });
  const previous = document.director;
  const restore = options.restore;
  const locks = new Set<DirectorLock>(restore?.locks ?? options.locks ?? []);
  // Keeping the layout means keeping the template it is a layout of.
  if (locks.has('layout')) locks.add('template');
  const aspect = aspectBucket(document.canvas.width, document.canvas.height);
  const conditions = projectConditions(document, input.analysis, input.title, input.milkdropPresets);

  // --- classify -------------------------------------------------------------------------------
  const key = input.digest.key;
  note('classify', `The track reads as ${describeStyle(style)}${key === null ? '' : `, in ${keyName(key)}`}.`, {
    tempo: round(style.tempo), energy: round(style.energy), brightness: round(style.brightness), density: round(style.density),
    organic: round(style.organic), vocalWeight: round(style.vocalWeight), dynamics: round(style.dynamics), darkness: round(style.darkness),
    unmeasured: [...style.unmeasured], bpm: round(input.digest.bpm), sections: input.digest.structure.sections.length,
    ...(key === null ? {} : { key: keyName(key), keyConfidence: round(key.confidence) }),
  });

  // --- match ----------------------------------------------------------------------------------
  const ranked = rankTemplates(input.templates, style, conditions, modules, aspect);
  const byId = (id: string) => ranked.find((r) => r.template.id === id);
  let chosen: TemplateScore | undefined;
  let how: string;
  const wanted = restore?.templateId ?? options.templateId ?? (locks.has('template') ? previous?.current.templateId : undefined) ?? null;
  if (wanted !== null) {
    chosen = byId(wanted);
    if (chosen === undefined) throw new DirectorError(`There is no template "${wanted}".`);
    if (!chosen.availability.available) throw new DirectorError(`${chosen.template.name} is unavailable: ${chosen.availability.reason ?? 'unknown reason'}.`);
    how = restore !== undefined ? 'restored from the history' : options.templateId != null ? 'your choice' : 'kept (locked)';
  } else {
    const available = ranked.filter((r) => r.availability.available);
    if (available.length === 0) {
      throw new DirectorError(`No template can be used here: ${ranked.map((r) => `${r.template.name} — ${r.availability.reason ?? 'no score'}`).join('; ') || 'none are installed'}.`);
    }
    const best = available[0]!;
    if (options.roulette === true) {
      // Among the top three that are at least half as good as the best, weighted by score.
      const pool = available.slice(0, 3).filter((r) => r.score >= best.score * 0.5);
      const total = pool.reduce((sum, r) => sum + Math.max(1e-6, r.score), 0);
      let pick = random01(options.seed, 'template') * total;
      chosen = pool.find((r) => (pick -= Math.max(1e-6, r.score)) < 0) ?? best;
      how = `roulette among ${pool.map((r) => r.template.name).join(', ')}`;
    } else {
      chosen = best;
      how = 'best match';
    }
  }
  const template = chosen.template;
  const runnersUp = ranked.filter((r) => r !== chosen).slice(0, 2).map((r) => `${r.template.name} ${r.score.toFixed(2)}`);
  note('match', `Chose ${template.name} (${how}; score ${chosen.score.toFixed(2)}${runnersUp.length > 0 ? `; ${chosen === ranked[0] ? 'next' : 'others'}: ${runnersUp.join(', ')}` : ''}).`, {
    template: template.id,
    scores: Object.fromEntries(ranked.map((r) => [r.template.id, round(r.score)])),
    reasons: [...chosen.reasons],
  });
  for (const text of chosen.availability.notes) note('match', text);

  // --- seeds ----------------------------------------------------------------------------------
  const seedFor = (aspectName: DirectorAspect): number => {
    if (restore !== undefined) return restore.seeds[aspectName];
    const lock: DirectorLock = aspectName === 'motion' ? 'motion' : aspectName;
    if (locks.has(lock) && previous !== null) return previous.current.seeds[aspectName];
    return hash32(options.seed, aspectName) % 1_000_000_007;
  };
  const seeds: Record<DirectorAspect, number> = { palette: seedFor('palette'), layout: seedFor('layout'), motion: seedFor('motion') };

  // The picture a `$backgroundImage` token resolves to. Above the palette, because a palette derived
  // from the background must be derived from the one the layer shows: same seed, same key.
  const images = document.assets.filter((a) => a.kind === 'image');
  const logo = images.find((a) => /logo/i.test(a.name));
  const backgrounds = images.filter((a) => a !== logo);
  const backgroundFor = (key: string) => (backgrounds.length === 0 ? undefined : backgrounds[Math.floor(random01(seeds.layout, 'image', key) * backgrounds.length)]);

  // --- palette --------------------------------------------------------------------------------
  let palette: Palette;
  if (restore !== undefined && restore.palette.length === document.palette.colors.length && restore.palette.length > 0) {
    palette = { ...document.palette, colors: [...restore.palette] };
    note('palette', 'Restored the palette of that roll.');
  } else if (locks.has('palette') && previous !== null) {
    palette = document.palette;
    note('palette', 'Kept the palette (locked).');
  } else if (template.palette.strategy === 'user') {
    palette = document.palette;
    note('palette', `${template.name} uses the project's own palette.`);
    if (input.colourImage != null) note('palette', `"${input.colourImage.name}" was not used: ${template.name} keeps the project's palette.`);
  } else {
    let generated: GeneratedPalette | null = null;
    const strategy = template.palette.strategy;
    const chosenImage = strategy === 'fixed' ? null : input.colourImage ?? null;
    if (strategy === 'fixed' && input.colourImage != null) note('palette', `"${input.colourImage.name}" was not used: ${template.name} fixes its colours.`);
    if (chosenImage !== null) {
      generated = derivePalette(template.palette, chosenImage.image, chosenImage.name, style, seeds.palette);
      if (generated === null) note('palette', `"${chosenImage.name}" has nothing visible in it: generated the colours from the track instead.`, { imageFallback: true });
    } else if (strategy === 'derive-from-image') {
      const asset = backgroundFor(backgroundImageKey(template));
      const pixels = asset === undefined ? undefined : input.images?.get(asset.hash);
      if (asset !== undefined && pixels !== undefined) generated = derivePalette(template.palette, pixels, asset.name, style, seeds.palette);
      // Said out loud, with a flag a batch can read: these are not the colours the template asked for.
      if (generated === null) {
        note('palette', `${template.name} takes its colours from a background image, but ${asset === undefined ? 'the project has none' : `"${asset.name}" is not available as pixels here`}: generated them from the track instead.`, { imageFallback: true });
      }
    }
    const made = generated ?? generatePalette(template.palette, style, seeds.palette, template.variation.hueJitter, key);
    palette = made.palette;
    made.notes.forEach((text, i) => note('palette', text, i === 0 ? made.data : {}));
  }

  // --- what stays from before -----------------------------------------------------------------
  const marks = new Map((previous?.generated ?? []).map((m) => [m.id, m]));
  const keptMarks: GeneratedMark[] = [];
  const keptBySlot = new Map<string, ModuleLayer>();
  const isDirectorTrack = (t: AutomationTrack) => {
    const mark = marks.get(t.id);
    return mark?.kind === 'track' && mark.fingerprint === fingerprint(t);
  };
  /** The user's keys under a target prefix: a generated layer's fingerprint cannot see them. */
  const userKeyed = (prefix: string) => document.automation.some((t) => t.target.startsWith(prefix) && !isDirectorTrack(t));
  /** Whose own track of the director's stays with it: an edited layer or effect is left as it is. */
  const keptOwners: string[] = [];
  /** User layers, each with the slot of the layer it sat on (null: at the bottom). */
  const userLayers: { layer: Layer; anchor: string | null }[] = [];
  let anchor: string | null = null;
  for (const layer of document.layers) {
    const mark = marks.get(layer.id);
    if (mark !== undefined && mark.kind === 'layer') {
      if ((mark.fingerprint !== fingerprint(layer) || userKeyed(`layers.${layer.id}.`)) && layer.kind === 'module') {
        keptBySlot.set(mark.slot, layer);
        keptMarks.push(mark);
        keptOwners.push(`layers.${layer.id}.`);
        note('keep', `Kept "${layer.name}" in ${mark.slot}: you edited it after it was generated.`, { layer: layer.id, slot: mark.slot });
      }
      anchor = mark.slot;
      continue;
    }
    userLayers.push({ layer, anchor });
  }
  const userGlobalEffects: EffectSpec[] = [];
  for (const effect of document.globalEffects) {
    const mark = marks.get(effect.id);
    if (mark === undefined) userGlobalEffects.push(effect);
    else if (mark.fingerprint !== fingerprint(effect) || userKeyed(`global.effects.${effect.id}.`)) {
      userGlobalEffects.push(effect);
      keptMarks.push(mark);
      keptOwners.push(`global.effects.${effect.id}.`);
      note('keep', `Kept the edited ${effect.name || effect.module} on the whole frame.`);
    }
  }
  const userGlobalBindings: ModulationBinding[] = [];
  for (const binding of document.globalModulations) {
    const mark = marks.get(binding.id);
    if (mark === undefined) userGlobalBindings.push(binding);
    else if (mark.fingerprint !== fingerprint(binding)) {
      userGlobalBindings.push(binding);
      keptMarks.push(mark);
    }
  }

  // The user's tracks stay, and the director's own stay with what they animate if that was kept.
  const keptTracks = document.automation.filter((t) => !isDirectorTrack(t) || keptOwners.some((prefix) => t.target.startsWith(prefix)));
  for (const t of keptTracks) {
    const mark = marks.get(t.id);
    if (mark !== undefined && isDirectorTrack(t)) keptMarks.push(mark);
  }

  // Deterministic ids: from the seed, never the clock; never one already in the document.
  const used = new Set<string>();
  for (const t of document.automation) {
    used.add(t.id);
    t.keyframes.forEach((k) => used.add(k.id));
  }
  for (const { layer } of walkLayers(document.layers)) {
    used.add(layer.id);
    layer.effects.forEach((e) => used.add(e.id));
    layer.modulations.forEach((b) => used.add(b.id));
  }
  document.globalEffects.forEach((e) => used.add(e.id));
  document.globalModulations.forEach((b) => used.add(b.id));
  let counter = 0;
  const factory = createIdFactory({
    now: () => 0,
    randomBytes: (into) => {
      for (let i = 0; i < into.length; i += 1) into[i] = hash32(options.seed, seeds.layout, 'id', counter, i) & 255;
    },
  });
  const newId = (): string => {
    for (;;) {
      counter += 1;
      const id = factory();
      if (!used.has(id)) {
        used.add(id);
        return id;
      }
    }
  };

  const looks = milkdropLooks(input.milkdropPresets);
  const paletteHue = hexToHsl(palette.colors[palette.roles['primary'] ?? 0] ?? '#808080').h;
  const chosenLooks = new Map<string, string>();
  const milkdropFor = (key: string): string => {
    const known = chosenLooks.get(key);
    if (known !== undefined) return known;
    const look = chooseLook(looks, style, paletteHue, seeds.layout, key);
    if (look === undefined) return '';
    chosenLooks.set(key, look.name);
    note('populate', `${key}: the MilkDrop preset "${look.name}", for its motion and brightness against this track.`, {
      preset: look.name, motion: round(look.motion), brightness: round(look.brightness), fill: round(look.fill), hue: Math.round(look.hue),
    });
    return look.name;
  };
  const tokens = (params: Readonly<Record<string, unknown>>, key: string): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(params)) {
      if (value === '$title') out[name] = input.title;
      else if (value === '$logo') out[name] = logo?.id ?? '';
      else if (value === '$backgroundImage') out[name] = backgroundFor(key)?.id ?? '';
      else if (value === '$seed') out[name] = 1 + (hash32(seeds.layout, 'seed', key) % 9999);
      else if (value === '$milkdrop') out[name] = milkdropFor(key);
      else out[name] = value;
    }
    return out;
  };
  const effectFrom = (entry: EffectEntry, key: string): EffectSpec | null => {
    const manifest = modules.get(entry.module);
    if (manifest === undefined) return null;
    if (entry.probability < 1 && random01(seeds.layout, 'effect', key) >= entry.probability) {
      note('populate', `Left out ${manifest.name} in ${key.split(':')[0]} (it appears ${Math.round(entry.probability * 100)}% of the time).`);
      return null;
    }
    return createEffect(manifest.id, { id: newId(), params: declared(manifest, tokens(entry.params, key), key, note) });
  };

  // --- populate -------------------------------------------------------------------------------
  const filled = new Map<string, Filled>();
  const post: { entry: EffectEntry; effect: EffectSpec }[] = [];
  const userModules = new Set(userLayers.flatMap(({ layer }) => [...walkLayers([layer])].map(({ layer: l }) => (l.kind === 'module' ? l.module : ''))));
  for (const slot of template.slots) {
    if (slot.role === 'POST') {
      for (const entry of slot.effects) {
        const effect = effectFrom(entry, `POST:${entry.key}`);
        if (effect !== null) post.push({ entry, effect });
      }
      continue;
    }
    const kept = keptBySlot.get(slot.id);
    if (kept !== undefined) {
      const manifest = modules.get(kept.module);
      if (manifest !== undefined) {
        filled.set(slot.id, { slot, layer: kept, manifest, label: manifest.name, kept: true, effects: new Map() });
        continue;
      }
    }
    const roleModule = ROLE_MODULE[slot.role];
    if (roleModule !== undefined && userModules.has(roleModule)) {
      note('populate', `${slot.id}: your own ${modules.get(roleModule)?.name ?? roleModule} layer fills it.`);
      continue;
    }
    if (slot.condition !== null && !conditions.has(slot.condition)) {
      note('populate', `${slot.id}: not used (${conditionText(slot.condition)}).`);
      continue;
    }
    if (!slot.required && slot.probability < 1 && random01(seeds.layout, 'presence', slot.id) >= slot.probability) {
      note('populate', `${slot.id}: left out this time (it appears ${Math.round(slot.probability * 100)}% of the time).`);
      continue;
    }
    const candidates = (slot.candidates.length > 0 ? slot.candidates : roleModule === undefined ? [] : [defaultCandidate(roleModule)])
      .map((c) => ({ c, manifest: modules.get(c.module) ?? modules.get(chosen.availability.substitutes.get(c.module) ?? '') }))
      .filter((x): x is { c: SlotCandidate; manifest: ModuleManifest } => x.manifest !== undefined)
      .filter(({ c }) => c.needs === null || conditions.has(c.needs))
      .filter(({ c }) => Object.entries(c.minStyle).every(([axis, min]) => style.unmeasured.includes(axis) || style[axis as keyof StyleVector] as number >= (min ?? 0)));
    if (candidates.length === 0) {
      note('populate', `${slot.id}: no candidate fits this track or project${slot.required ? ' — the template asked for one' : ''}.`);
      continue;
    }
    const total = candidates.reduce((sum, x) => sum + x.c.weight, 0);
    let pick = random01(seeds.layout, 'candidate', slot.id) * total;
    const { c, manifest } = candidates.find((x) => (pick -= x.c.weight) < 0) ?? candidates[0]!;
    const label = c.label ?? ROLE_NAME[slot.role] ?? manifest.name;
    const effects = new Map<string, EffectSpec>();
    for (const entry of slot.effects) {
      if (entry.module === 'core.effect.dof' && manifest.kind !== 'scene3d') continue;
      const effect = effectFrom(entry, `${slot.id}:${entry.key}`);
      if (effect !== null) effects.set(entry.key, effect);
    }
    const layer: ModuleLayer = {
      ...createModuleLayer(manifest.id, {
        id: newId(),
        name: slot.name ?? label,
        params: declared(manifest, tokens({ ...slot.params, ...c.params }, slot.id), slot.id, note),
        opacity: slot.opacity,
        blend: slot.blend,
        transform: toTransform({ ...slot.transform, ...c.transform }),
      }),
      effects: [...effects.values()],
      aspectOverrides: overridesFor(slot, manifest, (params) => declared(manifest, tokens(params, slot.id), slot.id, note)),
    };
    filled.set(slot.id, { slot, layer, manifest, label, kept: false, effects });
    note('populate', `${slot.id}: ${label}${candidates.length > 1 ? ` (weight ${c.weight} of ${total} across ${candidates.length} candidates)` : ''}.`, {
      slot: slot.id, module: manifest.id, candidates: candidates.map((x) => x.manifest.id),
    });
  }

  // A kept layer whose slot this template does not fill is still the user's: it stays as their own.
  for (const [slot, layer] of keptBySlot) {
    if (filled.get(slot)?.layer.id === layer.id) continue;
    userLayers.push({ layer, anchor: null });
    note('keep', `"${layer.name}" stays as your own layer: ${template.name} has no place for it in ${slot}.`, { layer: layer.id, slot });
  }

  // Budget (§5.1 step 5, §7): drop the lowest-priority optional slots until it fits.
  const pixelScale = Math.max(1, (document.canvas.width * document.canvas.height) / (1920 * 1080));
  const costOf = () => [...filled.values()].reduce((sum, f) => sum + COST[f.manifest.capabilities.gpuCost] * pixelScale, 0)
    + post.reduce((sum, p) => sum + (COST[modules.get(p.effect.module)?.capabilities.gpuCost ?? 'low'] * pixelScale) / 2, 0);
  const layerCount = () => filled.size + userLayers.length;
  for (;;) {
    const over = layerCount() > template.budget.maxLayers ? 'layers' : costOf() > template.budget.maxCost ? 'cost' : null;
    if (over === null) break;
    const droppable = [...filled.values()].filter((f) => !f.slot.required && !f.kept).sort((a, b) => a.slot.priority - b.slot.priority)[0];
    if (droppable === undefined) {
      note('guardrail', over === 'layers'
        ? `More than ${template.budget.maxLayers} layers, but none left to drop are the director's; nothing more removed.`
        : `Over the GPU budget (${costOf().toFixed(1)} of ${template.budget.maxCost}${pixelScale > 1 ? ` at ${document.canvas.width}×${document.canvas.height}` : ''}), but nothing optional is left to drop.`);
      break;
    }
    filled.delete(droppable.slot.id);
    note('guardrail', over === 'layers'
      ? `Dropped ${droppable.label} (${droppable.slot.id}): more than ${template.budget.maxLayers} layers.`
      : `Dropped ${droppable.label} (${droppable.slot.id}): over the GPU budget${pixelScale > 1 ? ` at ${document.canvas.width}×${document.canvas.height}` : ''}.`, { slot: droppable.slot.id });
  }

  // --- targets --------------------------------------------------------------------------------
  const resolve = (target: string): Resolved => {
    const parsed = parseTemplateTarget(target);
    if (parsed === undefined) return { ok: false, reason: `"${target}" is not a target` };
    if (parsed.slot === 'POST') {
      if (parsed.kind !== 'effect') return { ok: false, reason: 'POST has only effects' };
      const found = post.find((p) => p.entry.key === parsed.effect);
      if (found === undefined) return { ok: false, reason: `the ${parsed.effect} effect was left out` };
      const manifest = modules.get(found.effect.module);
      const spec = manifest?.params.find((p) => p.key === parsed.key);
      if (manifest === undefined || spec === undefined) return { ok: false, reason: `${manifest?.name ?? found.effect.module} has no "${parsed.key}"` };
      return { ok: true, ownerId: GLOBAL_OWNER, path: `global.effects.${found.effect.id}.params.${parsed.key}`, spec, base: numeric(found.effect.params[parsed.key], spec), where: `${manifest.name} › ${spec.label}`, kept: false };
    }
    const f = filled.get(parsed.slot);
    if (f === undefined) return { ok: false, reason: `${parsed.slot} is not in this project` };
    if (parsed.kind === 'opacity') {
      return { ok: true, ownerId: f.layer.id, path: `layers.${f.layer.id}.opacity`, spec: OPACITY_SPEC, base: f.layer.opacity, where: `${f.label} › Opacity`, kept: f.kept };
    }
    if (parsed.kind === 'effect') {
      const effect = f.effects.get(parsed.effect);
      const manifest = effect === undefined ? undefined : modules.get(effect.module);
      const spec = manifest?.params.find((p) => p.key === parsed.key);
      if (effect === undefined || manifest === undefined || spec === undefined) return { ok: false, reason: `${f.label} has no ${parsed.effect} ${parsed.key}` };
      return { ok: true, ownerId: f.layer.id, path: `layers.${f.layer.id}.effects.${effect.id}.params.${parsed.key}`, spec, base: numeric(effect.params[parsed.key], spec), where: `${f.label} › ${manifest.name} › ${spec.label}`, kept: f.kept };
    }
    const spec = f.manifest.params.find((p) => p.key === parsed.key);
    if (spec === undefined) return { ok: false, reason: `${f.label} has no "${parsed.key}"` };
    if (spec.modulatable === false) return { ok: false, reason: `${f.label}'s ${spec.label} cannot be modulated` };
    return { ok: true, ownerId: f.layer.id, path: `layers.${f.layer.id}.params.${parsed.key}`, spec, base: numeric(f.layer.params[parsed.key], spec), where: `${f.label} › ${spec.label}`, kept: f.kept };
  };
  const firstResolved = (targets: readonly string[]): Resolved => {
    const reasons: string[] = [];
    for (const t of targets) {
      const r = resolve(t);
      if (r.ok) return r;
      reasons.push(r.reason);
    }
    return { ok: false, reason: reasons.join('; ') || 'no target' };
  };
  const globalBindings: ModulationBinding[] = [];
  const attach = (ownerId: string, binding: ModulationBinding) => {
    if (ownerId === GLOBAL_OWNER) {
      globalBindings.push(binding);
      return;
    }
    for (const f of filled.values()) {
      if (f.layer.id === ownerId) f.layer = { ...f.layer, modulations: [...f.layer.modulations, binding] };
    }
  };

  // --- calibrate ------------------------------------------------------------------------------
  template.modulations.forEach((m, i) => {
    const title = m.label ?? `${m.source.type}${m.source.band === null ? '' : ` ${m.source.band}`}`;
    const target = firstResolved(m.targets);
    if (!target.ok) {
      note('calibrate', `Skipped "${title}": ${target.reason}.`);
      return;
    }
    if (target.kept) {
      note('calibrate', `Left ${target.where} alone: you edited its layer.`);
      return;
    }
    let stem = m.source.stem;
    const audio = AUDIO_SOURCES.has(m.source.type);
    if (audio && stem !== 'mix' && input.analysis !== null && !input.analysis.sources.has(stem as never)) {
      note('calibrate', `${title}: the ${stem} stem is not separated, so the mix stands in (separate stems for a tighter result).`);
      stem = 'mix';
    }
    let stats = null;
    if (audio && input.analysis !== null) {
      const track = sourceTrack(input.analysis, m.source.type, stem, m.source.band);
      if (typeof track === 'string') {
        note('calibrate', `Skipped "${title}": ${track}.`);
        return;
      }
      stats = trackStats(track);
    }
    const jitter = (random01(seeds.motion, 'modulation', i) * 2 - 1) * template.variation.intensityJitter;
    const cal = calibrate(m, target.spec, target.base, stats, jitter);
    if (!cal.ok) {
      note('guardrail', `Removed "${title}" → ${target.where}: ${cal.reason}.`);
      return;
    }
    const made = createBinding(target.path, { id: newId(), sourceType: m.source.type, stem, ...(m.source.band === null ? {} : { band: m.source.band }), amount: cal.amount, mode: m.mode, order: i });
    const binding: ModulationBinding = {
      ...made,
      label: m.label,
      source: {
        ...made.source,
        ...(m.source.shape === null ? {} : { shape: m.source.shape }),
        ...(m.source.rateHz === null ? {} : { rateHz: m.source.rateHz }),
        ...(m.source.syncDivision === null ? {} : { syncDivision: m.source.syncDivision }),
      },
      envelope: { ...made.envelope, attackMs: cal.attackMs, releaseMs: cal.releaseMs },
    };
    attach(target.ownerId, binding);
    note('calibrate', `${sourceText(m.source.type, stem, m.source.band)} → ${target.where}: ${cal.note}, ${m.response}.`, {
      target: target.path, amount: cal.amount, ...(stats === null ? {} : { p10: round(stats.p10), p50: round(stats.p50), p90: round(stats.p90) }),
    });
  });

  // --- arrange --------------------------------------------------------------------------------
  const durationTicks = timelineDurationTicks(document);
  const durationSeconds = ticksToSeconds(durationTicks);
  const sections: readonly Section[] = input.digest.structure.sections;
  const optionalSlots = [...filled.values()].filter((f) => !f.kept).map((f) => f.slot.id);
  const arrangement = arrange({
    sections,
    placement: { leadInTicks: document.audio.leadInTicks, clipInTicks: document.audio.clipInTicks },
    durationSeconds,
    beats: input.beats,
    onsets: input.onsets,
    drops: input.digest.structure.drops,
    vocalSegments: input.vocalSegments,
    arrangement: template.arrangement,
    optionalSlots,
    jitter: (key) => random01(seeds.motion, 'arrange', key) * 2 - 1,
    intensityJitter: template.variation.intensityJitter,
  });
  if (arrangement.sections.length > 0) {
    note('arrange', `Sections: ${arrangement.sections.map((s) => `${s.label} ${clock(s.startSeconds)} (${Math.round(s.intensity * 100)}%${s.present.length > 0 ? ` + ${s.present.join(', ')}` : ''})`).join(' → ')}.`, {
      sections: arrangement.sections.map((s) => ({ label: s.label, start: round(s.startSeconds), intensity: s.intensity, present: s.present })),
    });
  } else {
    note('arrange', 'No section structure was detected, so the look holds for the whole track.');
  }
  for (const text of arrangement.notes) note('arrange', text);

  const curveBinding = (ownerTarget: Extract<Resolved, { ok: true }>, points: readonly CurvePoint[], label: string, shape: { mode: 'add' | 'multiply'; amount: number; offset: number; order: number }) => {
    const made = createBinding(ownerTarget.path, { id: newId(), sourceType: 'curve', amount: shape.amount, mode: shape.mode, order: shape.order });
    attach(ownerTarget.ownerId, {
      ...made,
      label,
      source: { ...made.source, points: [...points] },
      envelope: { ...made.envelope, attackMs: 0, releaseMs: 0 },
      lookAheadMs: 0,
      offset: shape.offset,
    });
  };

  // Presence: optional layers enter and leave on section boundaries.
  for (const [slotId, presence] of arrangement.presence) {
    const f = filled.get(slotId);
    if (f === undefined) continue;
    if (presence.kind === 'never') {
      filled.delete(slotId);
      note('arrange', `${f.label} (${slotId}) left out: no section of this track brings it in.`);
    } else if (presence.kind === 'curve') {
      f.layer = { ...f.layer, timeRange: { inTicks: secondsToTicks(presence.inSeconds), outTicks: presence.outSeconds === null ? null : secondsToTicks(presence.outSeconds), extra: {} } };
      const target = resolve(`${slotId}.opacity`);
      if (target.ok) curveBinding(target, presence.points, 'Section presence', { mode: 'multiply', amount: 1, offset: -1, order: 200 });
    }
  }

  // Intensity: one knob, many parameters.
  if (arrangement.intensity.length > 0) {
    const floor = template.arrangement.floor;
    const driven: string[] = [];
    for (const t of template.arrangement.intensityTargets) {
      const target = resolve(t);
      if (!target.ok || target.kept) continue;
      curveBinding(target, arrangement.intensity, 'Section intensity', { mode: 'multiply', amount: 1 - floor, offset: -(1 - floor), order: 100 });
      driven.push(target.where);
    }
    if (driven.length > 0) note('arrange', `Section intensity drives ${driven.join(', ')} (quietest sections keep ${Math.round(floor * 100)}%).`);
  }

  // Drops: a spike exactly on the transient.
  const drop = template.arrangement.drop;
  if (drop !== null && arrangement.drops.length > 0) {
    for (const t of drop.targets) {
      const target = resolve(t);
      if (!target.ok || target.kept) continue;
      const softMax = target.spec.type === 'float' ? (target.spec.softMax ?? target.spec.max) : target.spec.type === 'int' ? target.spec.max : 1;
      const amount = Number(Math.min(drop.amount * paramSpan(target.spec), Math.max(0, softMax - target.base)).toPrecision(3));
      if (amount <= 0) {
        note('guardrail', `No drop impulse on ${target.where}: it is already at its maximum.`);
        continue;
      }
      curveBinding(target, arrangement.drops, 'Drop', { mode: 'add', amount, offset: 0, order: 150 });
    }
  }

  // The title leaves before the singing starts.
  const titleSlot = [...filled.values()].find((f) => f.slot.role === 'TEXT' && !f.kept);
  if (titleSlot !== undefined && arrangement.textOutSeconds !== null) {
    titleSlot.layer = {
      ...titleSlot.layer,
      timeRange: { inTicks: titleSlot.layer.timeRange.inTicks, outTicks: secondsToTicks(arrangement.textOutSeconds), extra: {} },
      params: { animIn: 'fade', animOut: 'fade', ...titleSlot.layer.params },
    };
  }

  // --- guardrails -----------------------------------------------------------------------------
  // Lyrics take priority over the hero (§5.4): if they would sit on it, the hero moves up and shrinks.
  const hero = [...filled.values()].find((f) => f.slot.role === 'HERO' && !f.kept);
  const lyricsLayer = [...filled.values()].find((f) => f.slot.role === 'LYRICS')?.layer
    ?? userLayers.map((u) => u.layer).find((l): l is ModuleLayer => l.kind === 'module' && l.module === 'core.text.lyrics');
  if (hero !== undefined && lyricsLayer !== undefined && Math.abs(hero.layer.transform.y - lyricsLayer.transform.y) < 0.25) {
    const t = hero.layer.transform;
    hero.layer = { ...hero.layer, transform: { ...t, scaleX: t.scaleX * 0.8, scaleY: t.scaleY * 0.8, y: Math.max(0.2, Math.min(t.y, lyricsLayer.transform.y) - 0.1) } };
    note('guardrail', `Moved ${hero.label} up and made it smaller: the lyrics sit where it was.`);
  }
  // Vertical frames: text and logos inside the safe area.
  for (const f of filled.values()) {
    if (f.kept || !(f.slot.role === 'TEXT' || f.slot.role === 'LYRICS' || f.slot.role === 'LOGO')) continue;
    const vertical = f.layer.aspectOverrides['9:16'];
    const y = vertical?.transform.y ?? f.layer.transform.y;
    if (y < SAFE_Y[0] || y > SAFE_Y[1]) {
      const fixed = Math.min(SAFE_Y[1], Math.max(SAFE_Y[0], y));
      f.layer = { ...f.layer, aspectOverrides: { ...f.layer.aspectOverrides, '9:16': { transform: { ...(vertical?.transform ?? {}), y: fixed }, params: vertical?.params ?? {}, extra: {} } } };
      note('guardrail', `Nudged ${f.label} into the 9:16 safe area (y ${y.toFixed(2)} → ${fixed.toFixed(2)}).`);
    }
  }

  // Fades to and from black: a black layer on top whose opacity follows a curve.
  const fadeIn = template.arrangement.fadeIn;
  const fadeOut = template.arrangement.fadeOut;
  let fadeLayer: ModuleLayer | null = null;
  if ((fadeIn > 0 || fadeOut > 0) && durationSeconds > fadeIn + fadeOut + 1 && modules.get('core.source.background') !== undefined) {
    const id = newId();
    const points: CurvePoint[] = [];
    const at = (s: number, v: number) => points.push({ ticks: secondsToTicks(s), value: v });
    if (fadeIn > 0) {
      at(0, 1);
      at(fadeIn, 0);
    } else at(0, 0);
    if (fadeOut > 0) {
      at(durationSeconds - fadeOut, 0);
      at(durationSeconds, 1);
    }
    const binding = createBinding(`layers.${id}.opacity`, { id: newId(), sourceType: 'curve', amount: 1, mode: 'multiply', order: 0 });
    fadeLayer = {
      ...createModuleLayer('core.source.background', { id, name: 'Fade', params: { mode: 'solid', colorA: '#000000' } }),
      modulations: [{ ...binding, label: 'Fade', source: { ...binding.source, points }, envelope: { ...binding.envelope, attackMs: 0, releaseMs: 0 }, lookAheadMs: 0, offset: -1 }],
    };
    note('arrange', `Fades ${[fadeIn > 0 ? `in over ${fadeIn} s` : '', fadeOut > 0 ? `out over the last ${fadeOut} s` : ''].filter(Boolean).join(' and ')} (the "Fade" layer on top).`);
  }

  // One effect of a kind per chain: the first stays (a kept, edited one before a new one).
  const globalEffects: EffectSpec[] = [...userGlobalEffects];
  const postKept: EffectSpec[] = [];
  for (const p of post) {
    if (globalEffects.some((e) => e.module === p.effect.module)) {
      note('guardrail', `Left out a second ${modules.get(p.effect.module)?.name ?? p.effect.module} on the whole frame: one is already there.`);
      continue;
    }
    globalEffects.push(p.effect);
    postKept.push(p.effect);
  }
  const survivingEffects = new Set(globalEffects.map((e) => e.id));
  const generatedGlobalBindings = globalBindings.filter((b) => {
    const effectId = /^global\.effects\.([^.]+)\./.exec(b.target)?.[1];
    return effectId === undefined || survivingEffects.has(effectId);
  });

  // Occlusion: a full-frame opaque layer hides everything the director put under it.
  const ordered: Filled[] = template.slots.flatMap((s) => {
    const f = filled.get(s.id);
    return f === undefined ? [] : [f];
  });
  for (let i = ordered.length - 1; i > 0; i -= 1) {
    const f = ordered[i]!;
    if (!coversFrame(f.layer)) continue;
    const hidden = ordered.slice(0, i).filter((below) => !below.kept);
    for (const h of hidden) {
      filled.delete(h.slot.id);
      note('guardrail', `Removed ${h.label} (${h.slot.id}): ${f.label} covers the whole frame above it.`);
    }
    break;
  }

  // --- assemble -------------------------------------------------------------------------------
  const finalOrdered = ordered.filter((f) => filled.has(f.slot.id));
  const slotsPresent = new Set(finalOrdered.map((f) => f.slot.id));
  const layers: Layer[] = [...userLayers.filter((u) => u.anchor === null).map((u) => u.layer)];
  for (const f of finalOrdered) {
    layers.push(f.layer);
    layers.push(...userLayers.filter((u) => u.anchor === f.slot.id).map((u) => u.layer));
  }
  // User layers whose neighbour is gone go on top, where they are easiest to find.
  layers.push(...userLayers.filter((u) => u.anchor !== null && !slotsPresent.has(u.anchor)).map((u) => u.layer));
  if (fadeLayer !== null) layers.push(fadeLayer);

  // Palette shifts (§6): the colours trade places section by section, as ordinary keyframes on the
  // parameters that link to a role. Last, so a template without them draws no ids and changes nothing.
  const shiftTracks: { track: AutomationTrack; slot: string }[] = [];
  const shifting = arrangement.sections.filter((s) => s.paletteShift !== null);
  if (shifting.length > 0) {
    const backgroundHex = resolveRole(palette, 'background');
    const textHex = resolveRole(palette, 'text');
    const minimum = template.palette.minTextContrast;
    const shiftParams = (target: string, specs: readonly ParamSpec[], params: Readonly<Record<string, unknown>>, slot: string, label: string, role: SlotRole | null, overridden: ReadonlySet<string>) => {
      for (const spec of specs) {
        if (spec.type !== 'color' || overridden.has(spec.key)) continue;
        const base = linkedRole(params[spec.key]);
        if (base === undefined) continue;
        const keys = roleKeys(base, arrangement.sections);
        if (keys.length === 0) continue;
        const baseHex = resolveRole(palette, base);
        // Text must stay as readable through the crossing as it was or as the template demands,
        // and so must text over a backdrop whose colour is the one moving.
        const ground = role === 'TEXT' || role === 'LYRICS' ? backgroundHex : role === 'BACKDROP' ? textHex : undefined;
        if (ground !== undefined && baseHex !== undefined) {
          const worst = worstContrast(palette, keys, ground);
          if (worst === null || worst < Math.min(minimum, contrastRatio(baseHex, ground)) - 0.01) {
            note('guardrail', `Left ${label} › ${spec.label} out of the palette shift: the text would drop to ${(worst ?? 0).toFixed(1)}:1 on the way (minimum ${minimum}:1).`);
            continue;
          }
        }
        const track: AutomationTrack = {
          id: newId(),
          target: `${target}${spec.key}`,
          enabled: true,
          keyframes: keys.map((k) => ({ id: newId(), ticks: k.ticks, value: roleLink(k.role), easing: 'easeInOut' as const, extra: {} })),
          extra: {},
        };
        shiftTracks.push({ track, slot });
      }
    };
    for (const f of finalOrdered) {
      if (f.kept) continue;
      const overridden = new Set(Object.values(f.layer.aspectOverrides).flatMap((o) => Object.keys(o?.params ?? {})));
      shiftParams(`layers.${f.layer.id}.params.`, f.manifest.params, f.layer.params, f.slot.id, f.label, f.slot.role, overridden);
      for (const effect of f.effects.values()) {
        shiftParams(`layers.${f.layer.id}.effects.${effect.id}.params.`, modules.get(effect.module)?.params ?? [], effect.params, f.slot.id, f.label, f.slot.role, new Set());
      }
    }
    for (const effect of postKept) {
      shiftParams(`global.effects.${effect.id}.params.`, modules.get(effect.module)?.params ?? [], effect.params, 'POST', modules.get(effect.module)?.name ?? effect.module, null, new Set());
    }
    if (shiftTracks.length > 0) {
      note('arrange', `The colours trade places in ${shifting.map((s) => `${s.label} ${clock(s.startSeconds)} (primary with ${s.paletteShift ?? ''})`).join(', ')}: ${shiftTracks.length} colour track${shiftTracks.length === 1 ? '' : 's'} of ordinary keyframes.`, { tracks: shiftTracks.length });
    }
  }

  // A track of yours that points at something gone is kept and reported, never dropped (CLAUDE.md #4).
  const present = new Set([...walkLayers(layers)].map(({ layer }) => layer.id));
  const presentEffects = new Set(globalEffects.map((e) => e.id));
  for (const t of keptTracks) {
    const path = parseTarget(t.target);
    if (path !== undefined && (path.layerId === GLOBAL_OWNER ? path.effectId !== null && presentEffects.has(path.effectId) : present.has(path.layerId))) continue;
    note('keep', `Your keyframes on ${t.target} point at something no longer in the project: they are kept, and do nothing.`, { track: t.id });
  }

  const generated: GeneratedMark[] = [
    ...keptMarks.filter((m) => m.kind !== 'layer' || finalOrdered.some((f) => f.kept && f.layer.id === m.id)),
    ...finalOrdered.filter((f) => !f.kept).map((f): GeneratedMark => ({ id: f.layer.id, kind: 'layer', slot: f.slot.id, fingerprint: fingerprint(f.layer) })),
    ...(fadeLayer === null ? [] : [{ id: fadeLayer.id, kind: 'layer' as const, slot: 'FADE', fingerprint: fingerprint(fadeLayer) }]),
    ...postKept.map((e): GeneratedMark => ({ id: e.id, kind: 'effect', slot: 'POST', fingerprint: fingerprint(e) })),
    ...generatedGlobalBindings.map((b): GeneratedMark => ({ id: b.id, kind: 'binding', slot: 'POST', fingerprint: fingerprint(b) })),
    ...shiftTracks.map(({ track, slot }): GeneratedMark => ({ id: track.id, kind: 'track', slot, fingerprint: fingerprint(track) })),
  ];

  const heroFilled = finalOrdered.find((f) => f.slot.role === 'HERO') ?? finalOrdered.find((f) => f.slot.role === 'LYRICS');
  const primary = palette.colors[palette.roles['primary'] ?? 0] ?? '#ffffff';
  const roll: DirectorRoll = {
    seed: options.seed,
    templateId: template.id,
    seeds,
    locks: [...locks],
    palette: [...palette.colors],
    summary: [template.name, heroFilled?.label, hueName(primary)].filter(Boolean).join(' · '),
    extra: {},
  };
  const history = previous === null ? [] : dedupeRolls([...previous.history, previous.current]).filter((r) => !sameRoll(r, roll)).slice(-DIRECTOR_HISTORY_LIMIT);

  const result: ProjectDocument = {
    ...document,
    seed: options.seed,
    palette,
    layers,
    globalEffects,
    globalModulations: [...userGlobalBindings, ...generatedGlobalBindings],
    automation: [...keptTracks, ...shiftTracks.map((s) => s.track)],
    director: { current: roll, history, log, generated, extra: previous?.extra ?? {} },
  };
  return { document: result, roll, log, template, ranked };
}

// ---------------------------------------------------------------------------
// Surprise me (§9)
// ---------------------------------------------------------------------------

/** What makes two rolls look alike: the template, the hero, the hue and which accents are there. */
function signature(document: ProjectDocument): { template: string; hero: string; hue: number; slots: string } | null {
  const director = document.director;
  if (director === null) return null;
  const heroMark = director.generated.find((m) => m.kind === 'layer' && m.slot === 'HERO');
  const hero = document.layers.find((l) => l.id === heroMark?.id);
  const primary = document.palette.colors[document.palette.roles['primary'] ?? 0] ?? '#000000';
  return {
    template: director.current.templateId,
    hero: hero?.kind === 'module' ? hero.module : '',
    hue: hexToHsl(primary).h,
    slots: director.generated.filter((m) => m.kind === 'layer').map((m) => m.slot).sort().join(),
  };
}

/** Bounded redraws (§9 "diversity enforcement"). */
const MAX_REDRAWS = 5;

/**
 * A reroll that must look different from the current project: redrawn (with a derived seed) while
 * it resolves to the same template, hero, hue family and accents — unless the locks leave nothing
 * that could differ.
 */
export function surprise(input: DirectorInput, options: Omit<DirectOptions, 'restore' | 'templateId'>): DirectResult {
  const before = signature(input.document);
  const locks = new Set(options.locks ?? []);
  const nothingCanMove = locks.has('layout') && locks.has('palette');
  let seed = options.seed;
  let result = direct(input, options);
  for (let attempt = 1; attempt <= MAX_REDRAWS && before !== null && !nothingCanMove; attempt += 1) {
    const after = signature(result.document);
    const hueDistance = after === null ? 180 : Math.min(Math.abs(after.hue - before.hue), 360 - Math.abs(after.hue - before.hue));
    const tooClose = after !== null && after.template === before.template && after.hero === before.hero && after.slots === before.slots && hueDistance < 25;
    if (!tooClose) {
      if (attempt > 1) {
        const text = `Redrew ${attempt - 1} time${attempt === 2 ? '' : 's'}: the roll came out too close to the previous one.`;
        const log = [...result.log, { step: 'match' as const, text, data: { redraws: attempt - 1 } }];
        result = { ...result, log, document: { ...result.document, director: result.document.director === null ? null : { ...result.document.director, log } } };
      }
      break;
    }
    seed = hash32(seed, 'redraw', attempt) % 1_000_000_007;
    result = direct(input, { ...options, seed });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function round(v: number): number {
  return Number(v.toFixed(3));
}

function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function numeric(value: unknown, spec: ParamSpec): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return typeof spec.default === 'number' ? spec.default : 0;
}

/** The key the first `$backgroundImage` token will draw with: its slot's id, as tokens() is given. */
function backgroundImageKey(template: Template): string {
  const wants = (params: Readonly<Record<string, unknown>>) => Object.values(params).includes('$backgroundImage');
  const slot = template.slots.find((s) => wants(s.params) || s.candidates.some((c) => wants(c.params)));
  return slot?.id ?? 'BACKDROP';
}

function conditionText(condition: Condition): string {
  switch (condition) {
    case 'hasTitle': return 'no title';
    case 'hasLyrics': return 'the project has no timed lyrics';
    case 'noLyrics': return 'the project has lyrics';
    case 'hasLogo': return 'no image named "logo" in the project';
    case 'hasStems': return 'stems have not been separated';
    case 'hasBackgroundImage': return 'no background image in the project';
    case 'hasMilkdrop': return 'the MilkDrop presets are not installed';
  }
}

function sourceText(type: string, stem: string, band: string | null): string {
  const what = type === 'band' ? `${band ?? ''} band` : type;
  return stem === 'mix' ? `Mix ${what}` : `${stem[0]!.toUpperCase()}${stem.slice(1)} ${what}`;
}

function defaultCandidate(module: string): SlotCandidate {
  return { module, weight: 1, params: {}, needs: null, minStyle: {}, label: null, transform: {} };
}

/** Only parameters the module declares: an unknown key is a template mistake, said out loud. */
function declared(
  manifest: ModuleManifest,
  params: Readonly<Record<string, unknown>>,
  where: string,
  note: (step: DecisionStep, text: string) => void,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (manifest.params.some((p) => p.key === key)) out[key] = value;
    else note('populate', `Template sets "${key}" in ${where.split(':')[0]}, which ${manifest.name} does not have; ignored.`);
  }
  return out;
}

function toTransform(spec: TransformSpec): Transform {
  return {
    ...IDENTITY_TRANSFORM,
    ...(spec.x === undefined ? {} : { x: spec.x }),
    ...(spec.y === undefined ? {} : { y: spec.y }),
    ...(spec.scale === undefined ? {} : { scaleX: spec.scale, scaleY: spec.scale }),
    ...(spec.rotationDeg === undefined ? {} : { rotationDeg: spec.rotationDeg }),
    ...(spec.anchor === undefined ? {} : { anchor: spec.anchor }),
  };
}

function overridesFor(
  slot: TemplateSlot,
  manifest: ModuleManifest,
  params: (raw: Readonly<Record<string, unknown>>) => Record<string, unknown>,
): Partial<Record<AspectBucket, AspectOverride>> {
  const out: Partial<Record<AspectBucket, AspectOverride>> = {};
  for (const [aspect, o] of Object.entries(slot.aspectOverrides)) {
    if (o === undefined) continue;
    const t = o.transform;
    out[aspect as AspectBucket] = {
      transform: {
        ...(t.x === undefined ? {} : { x: t.x }),
        ...(t.y === undefined ? {} : { y: t.y }),
        ...(t.scale === undefined ? {} : { scaleX: t.scale, scaleY: t.scale }),
        ...(t.rotationDeg === undefined ? {} : { rotationDeg: t.rotationDeg }),
        ...(t.anchor === undefined ? {} : { anchor: t.anchor }),
      },
      params: manifest.params.length === 0 ? {} : params(o.params),
      extra: {},
    };
  }
  return out;
}

/** Opaque over the whole frame, for the whole timeline, with nothing fading it. */
function coversFrame(layer: ModuleLayer): boolean {
  if (layer.module !== 'core.source.background' && layer.module !== 'core.source.video') return false;
  if (layer.opacity < 1 || layer.blend !== 'normal' || layer.timeRange.inTicks > 0 || layer.timeRange.outTicks !== null) return false;
  if (layer.modulations.some((b) => b.target.endsWith('.opacity'))) return false;
  const t = layer.transform;
  const identity = t.x === 0.5 && t.y === 0.5 && t.scaleX >= 1 && t.scaleY >= 1 && t.rotationDeg === 0 && t.anchor === 'center';
  // A contained image or video leaves bars; a gradient or solid fills.
  const fit = layer.params['fit'];
  return identity && fit !== 'contain';
}

function sameRoll(a: DirectorRoll, b: DirectorRoll): boolean {
  return a.templateId === b.templateId && a.seeds.palette === b.seeds.palette && a.seeds.layout === b.seeds.layout && a.seeds.motion === b.seeds.motion
    && a.palette.join() === b.palette.join();
}

function dedupeRolls(rolls: readonly DirectorRoll[]): DirectorRoll[] {
  const out: DirectorRoll[] = [];
  for (const roll of rolls) {
    const i = out.findIndex((r) => sameRoll(r, roll));
    if (i >= 0) out.splice(i, 1);
    out.push(roll);
  }
  return out;
}
