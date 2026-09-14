// Document → the immutable snapshot the engine renders.
//
// This is the only bridge between the editable document and `src/engine/`. The engine never
// sees a ProjectDocument: it sees a flat, resolved RenderProject, which is what makes headless
// rendering and golden-frame tests possible.
//
// The snapshot is built up across P2. Where the document asks for something this build's
// engine cannot yet draw — a transform, an effect chain, a blend mode the compositor lacks —
// the request is **reported as a note, never dropped** (CLAUDE.md constraint 4). A caller that
// ignores the notes still gets a correct render of everything that is implemented; a caller
// that surfaces them tells the user exactly what is missing and why.

import type { BlendMode, LayerSpec, RenderProject } from '../engine/core/project.ts';
import { aspectBucket, walkLayers, type AspectBucket, type Layer, type ProjectDocument } from './document.ts';

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

/** Blend modes the compositor implements today; the rest fall back to `normal` with a note. */
const ENGINE_BLEND_MODES: readonly BlendMode[] = ['normal', 'add', 'screen'];

function isIdentityTransform(layer: Layer): boolean {
  const t = layer.transform;
  return t.x === 0.5 && t.y === 0.5 && t.scaleX === 1 && t.scaleY === 1
    && t.rotationDeg === 0 && t.skewXDeg === 0 && t.skewYDeg === 0;
}

/**
 * Flattens groups into the engine's flat layer list. Group nesting itself (M38 — shared
 * transform, opacity, blend and effect chain) lands with the compositor work in P2 step 2;
 * until then a group's children render in place and the group's own settings are reported.
 */
export function toRenderProject(document: ProjectDocument): SnapshotResult {
  const notes: SnapshotNote[] = [];
  const { canvas } = document;
  const aspect = aspectBucket(canvas.width, canvas.height);

  const anySoloed = [...walkLayers(document.layers)].some(({ layer }) => layer.soloed);

  const layers: LayerSpec[] = [];
  let index = 0;
  for (const { layer, parents } of walkLayers(document.layers)) {
    const path = `layers[${index}]`;
    index += 1;

    if (layer.kind === 'group') {
      if (layer.opacity !== 1 || layer.blend !== 'normal' || layer.effects.length > 0 || !isIdentityTransform(layer)) {
        notes.push({ path, detail: `group "${layer.name || layer.id}" has its own transform, opacity, blend or effects; group compositing (M38) is not implemented yet, so its children render in place` });
      }
      continue;
    }

    // A disabled group hides its children, which flattening would otherwise lose.
    const hiddenByParent = parents.some((parent) => !parent.enabled);
    const enabled = layer.enabled && !hiddenByParent && (!anySoloed || layer.soloed);

    if (!isIdentityTransform(layer)) {
      notes.push({ path, detail: 'layer transform is not yet applied by the compositor (P2 step 2)' });
    }
    if (layer.effects.length > 0) {
      notes.push({ path, detail: `${layer.effects.length} effect(s) are not yet applied (P2 step 4)` });
    }
    if (layer.modulations.length > 0) {
      notes.push({ path, detail: `${layer.modulations.length} modulation binding(s) are not yet evaluated (P2 step 3)` });
    }
    if (layer.maskLayerId !== null) {
      notes.push({ path, detail: 'masking (S7) is not implemented; the layer renders unmasked' });
    }
    const override = layer.aspectOverrides[aspect];
    if (override !== undefined && (Object.keys(override.transform).length > 0 || Object.keys(override.params).length > 0)) {
      notes.push({ path, detail: `overrides for aspect ${aspect} are not yet applied (P2 step 2)` });
    }

    let blend: BlendMode = 'normal';
    if (ENGINE_BLEND_MODES.includes(layer.blend as BlendMode)) {
      blend = layer.blend as BlendMode;
    } else {
      notes.push({ path, detail: `blend mode "${layer.blend}" is not implemented by the compositor; rendering as normal` });
    }

    layers.push({
      id: layer.id,
      module: layer.module,
      enabled,
      opacity: layer.opacity,
      blend,
      params: layer.params,
      timeRange: { inTicks: layer.timeRange.inTicks, outTicks: layer.timeRange.outTicks },
    });
  }

  if (document.globalEffects.length > 0) {
    notes.push({ path: 'globalEffects', detail: `${document.globalEffects.length} global effect(s) are not yet applied (P2 step 4)` });
  }
  if (document.globalModulations.length > 0) {
    notes.push({ path: 'globalModulations', detail: `${document.globalModulations.length} global modulation binding(s) are not yet evaluated (P2 step 3)` });
  }

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
    },
    layers,
  };

  return { project, notes, aspect };
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
