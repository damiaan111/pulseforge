// Document → the immutable snapshot the engine renders.
//
// This is the only bridge between the editable document and `src/engine/`. The engine never
// sees a ProjectDocument: it sees a flat, resolved RenderProject, which is what makes headless
// rendering and golden-frame tests possible.
//
// Where the document asks for something this build's engine cannot yet draw — a mask, a blend
// mode the compositor lacks — the request is **reported as a note, never dropped** (CLAUDE.md
// constraint 4). A caller that ignores the notes still gets a correct render of everything that
// is implemented; a caller that surfaces them tells the user exactly what is missing and why.
//
// Groups keep their shape here (M38): the engine composites children into the group's own target
// and then applies the group's transform, opacity, blend and effects to that result. Flattening —
// which is what this did before group compositing existed — could not express that.

import type { LayerTransform } from '../engine/core/layout.ts';
import type { RenderLyricLine, RenderLyrics } from '../engine/core/lyrics.ts';
import { hasPaletteLinks, resolvePaletteValue } from './palette.ts';
import type { ModulationBinding } from '../engine/core/modulation.ts';
import { BLEND_MODES, type BlendMode, type EffectSpec, type GroupSpec as GroupLayerSpec, type LayerSpec, type RenderProject } from '../engine/core/project.ts';
import {
  aspectBucket, walkLayers, type AspectBucket, type AspectOverride, type Layer,
  type EffectSpec as DocumentEffect, type ModulationBinding as DocumentBinding,
  type Lyrics, type Palette, type ProjectDocument,
} from './document.ts';

/** Something the document specifies that this engine build does not yet render. */
export interface SnapshotNote {
  readonly path: string;
  readonly detail: string;
}

export interface SnapshotResult {
  readonly project: RenderProject;
  readonly notes: readonly SnapshotNote[];
  /** Which aspect bucket's overrides apply to this canvas (PROJECT.md §8.11). */
  readonly aspect: AspectBucket;
}

/**
 * Blend modes the compositor implements. The document's list is the same one today; the check stays
 * so a file from a later build naming a mode this one lacks renders as normal with a note.
 */
const ENGINE_BLEND_MODES: readonly string[] = BLEND_MODES;

/** Document effect → engine effect: the id, the module and the stored params, nothing else. */
function toEngineEffect(effect: DocumentEffect, palette: Palette, path: string, notes: SnapshotNote[]): EffectSpec {
  return {
    id: effect.id,
    module: effect.module,
    enabled: effect.enabled,
    params: applyPalette(effect.params, palette, path, notes),
  };
}

/**
 * Palette role links → literal colours (M17, palette.ts). This is the only place it happens:
 * the engine receives resolved hex and never learns that palettes exist, which is what keeps
 * the golden frames a statement about the engine rather than about the document model.
 *
 * A role that resolves to nothing has its parameter **removed**, so the module's own default
 * applies — the behaviour `parse.ts` already promises when it validates the role table — and
 * the caller is told which role and where.
 */
function applyPalette(
  params: Readonly<Record<string, unknown>>,
  palette: Palette,
  path: string,
  notes: SnapshotNote[],
): Readonly<Record<string, unknown>> {
  if (!hasPaletteLinks(params)) return params;
  const resolved: Record<string, unknown> = {};
  for (const [key, stored] of Object.entries(params)) {
    const { value, unresolved } = resolvePaletteValue(palette, stored);
    if (unresolved !== undefined) {
      notes.push({ path: `${path}.params.${key}`, detail: `palette role "${unresolved}" is not assigned to a colour; the module default is used` });
      continue;
    }
    resolved[key] = value;
  }
  return resolved;
}

/**
 * Document binding → engine binding. The two are deliberately separate types: the engine may
 * not import `src/project/`, and the document's `extra` bags have no meaning past this point.
 * A source the engine does not recognise still arrives intact and is reported by the compiler.
 */
function toEngineBinding(binding: DocumentBinding): ModulationBinding {
  const { source } = binding;
  return {
    id: binding.id,
    enabled: binding.enabled,
    source: {
      type: source.type,
      stem: source.stem,
      band: source.band,
      shape: source.shape,
      rateHz: source.rateHz,
      phase: source.phase,
      syncDivision: source.syncDivision,
      noiseScale: source.noiseScale,
      octaves: source.octaves,
      from: source.from,
      to: source.to,
    },
    target: binding.target,
    inputRange: binding.inputRange,
    curve: { type: binding.curve.type, amount: binding.curve.amount },
    envelope: { attackMs: binding.envelope.attackMs, releaseMs: binding.envelope.releaseMs, mode: binding.envelope.mode },
    quantise: binding.quantise === null
      ? null
      : { division: binding.quantise.division, mode: binding.quantise.mode, swing: binding.quantise.swing, humanise: binding.quantise.humanise },
    lookAheadMs: binding.lookAheadMs,
    amount: binding.amount,
    offset: binding.offset,
    invert: binding.invert,
    mode: binding.mode,
    order: binding.order,
    clampOutput: binding.clampOutput,
  };
}

/**
 * Base → aspect override, step 2 of the value resolution pipeline (module-spec §5). The
 * override *replaces* the properties it declares and leaves the rest inheriting the base —
 * which is why `AspectOverride.transform` is a partial and not a whole transform.
 */
function resolveTransform(layer: Layer, override: AspectOverride | undefined): LayerTransform {
  const { extra: _extra, ...base } = layer.transform;
  return override === undefined ? base : { ...base, ...override.transform };
}

function resolveParams(layer: Layer & { params: Readonly<Record<string, unknown>> }, override: AspectOverride | undefined): Readonly<Record<string, unknown>> {
  if (override === undefined || Object.keys(override.params).length === 0) return layer.params;
  return { ...layer.params, ...override.params };
}

/**
 * Document → engine snapshot. Layer order, nesting and everything resolved per aspect.
 *
 * Solo is the one rule that cannot be decided locally (ui-spec §5): when anything is soloed, only
 * soloed layers draw — and a group must still draw if it *contains* one, or soloing a layer inside
 * a group would hide it along with its group.
 */
export function toRenderProject(document: ProjectDocument): SnapshotResult {
  const notes: SnapshotNote[] = [];
  const { canvas } = document;
  const aspect = aspectBucket(canvas.width, canvas.height);

  const anySoloed = [...walkLayers(document.layers)].some(({ layer }) => layer.soloed);
  const containsSolo = (layer: Layer): boolean =>
    layer.soloed || (layer.kind === 'group' && layer.children.some(containsSolo));

  let index = 0;
  const convert = (layer: Layer, soloedAbove: boolean): LayerSpec | GroupLayerSpec => {
    const path = `layers[${index}]`;
    index += 1;
    const override = layer.aspectOverrides[aspect];
    const soloed = soloedAbove || layer.soloed;
    const enabled = layer.enabled && (!anySoloed || soloed || containsSolo(layer));

    if (layer.maskLayerId !== null) {
      notes.push({ path, detail: 'masking (S7) is not implemented; the layer renders unmasked' });
    }
    let blend: BlendMode = 'normal';
    if (ENGINE_BLEND_MODES.includes(layer.blend)) {
      blend = layer.blend as BlendMode;
    } else {
      notes.push({ path, detail: `blend mode "${layer.blend}" is not implemented by the compositor; rendering as normal` });
    }

    const common = {
      id: layer.id,
      enabled,
      opacity: layer.opacity,
      blend,
      timeRange: { inTicks: layer.timeRange.inTicks, outTicks: layer.timeRange.outTicks },
      transform: resolveTransform(layer, override),
      effects: layer.effects.map((effect) => toEngineEffect(effect, document.palette, `${path}.effects.${effect.id}`, notes)),
    };

    if (layer.kind === 'group') {
      return { ...common, kind: 'group', children: layer.children.map((child) => convert(child, soloed)) };
    }
    return {
      ...common,
      module: layer.module,
      params: applyPalette(resolveParams(layer, override), document.palette, path, notes),
      modulations: layer.modulations.map(toEngineBinding),
    };
  };

  const layers = document.layers.map((layer) => convert(layer, false));

  const project: RenderProject = {
    schemaVersion: 0,
    seed: document.seed,
    canvas: {
      width: canvas.width,
      height: canvas.height,
      fps: canvas.fps,
      background: canvas.background,
    },
    audio: {
      leadInTicks: document.audio.leadInTicks,
      clipInTicks: document.audio.clipInTicks,
      // "To the end of the file" is the file's length, when it is known.
      clipOutTicks: document.audio.clipOutTicks ?? (document.audio.durationTicks > 0 ? document.audio.durationTicks : null),
    },
    layers,
    durationTicks: timelineDurationTicks(document),
    globalModulations: document.globalModulations.map(toEngineBinding),
    globalEffects: document.globalEffects.map((effect) => toEngineEffect(effect, document.palette, `globalEffects.${effect.id}`, notes)),
    ...(document.lyrics.lines.length > 0 ? { lyrics: toRenderLyrics(document.lyrics) } : {}),
    // Files are not the engine's business: it gets id → hash, and the host registers the pixels.
    ...(document.assets.length > 0
      ? { assets: Object.fromEntries(document.assets.filter((a) => a.kind === 'image' || a.kind === 'font' || a.kind === 'video').map((a) => [a.id, { kind: a.kind, hash: a.hash, name: a.name }])) }
      : {}),
  };

  return { project, notes, aspect };
}

/**
 * Document lyrics → the engine's: timed lines only, in time order (ties keep document order, so
 * the sort is stable and the snapshot deterministic). Untimed lines are counted, so the layer can
 * say "12 lines have no timing yet" instead of drawing an unexplained gap.
 */
export function toRenderLyrics(lyrics: Lyrics): RenderLyrics {
  const timed: { line: RenderLyricLine; order: number }[] = [];
  let untimedLines = 0;
  lyrics.lines.forEach((line, order) => {
    if (line.startTicks === null || line.endTicks === null) {
      untimedLines += 1;
      return;
    }
    const style = line.style;
    timed.push({
      order,
      line: {
        id: line.id,
        text: line.text,
        startTicks: line.startTicks,
        endTicks: Math.max(line.startTicks, line.endTicks),
        role: line.role,
        words: line.words.map((word) => ({ startTicks: word.startTicks, endTicks: Math.max(word.startTicks, word.endTicks) })),
        style: style === null
          ? null
          : { scale: style.scale, opacity: style.opacity, offsetX: style.offsetX, offsetY: style.offsetY, color: style.color },
      },
    });
  });
  timed.sort((a, b) => a.line.startTicks - b.line.startTicks || a.order - b.order);
  return { lines: timed.map((entry) => entry.line), untimedLines };
}

/**
 * Total frames to render: the audio clip plus its lead-in and lead-out (PROJECT.md §8.10).
 * Layers extending past the audio do not lengthen the video — the timeline is defined by the
 * audio placement, so an accidental long time range cannot silently produce a 40-minute export.
 */
export function timelineDurationTicks(document: ProjectDocument): number {
  const { audio } = document;
  const clipEnd = audio.clipOutTicks ?? audio.durationTicks;
  const clipLength = Math.max(0, clipEnd - audio.clipInTicks);
  return audio.leadInTicks + clipLength + audio.leadOutTicks;
}
