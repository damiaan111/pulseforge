// What a preset thumbnail shows (S8, D45): the preset applied to a small blank project, drawn at a
// few moments of the reference track (src/analysis/reference-track.ts).
//
// Pure, so it is testable without a GPU. The renderer draws the frames and packs them into one
// PNG strip — THUMBNAIL.frames pictures side by side — which the browser animates by stepping
// through them. Always the reference track, never the song that happens to be loaded: a thumbnail
// is how a preset looks in general, it is cached by the preset's content alone, and two machines
// must draw the same one. Previewing a preset with *your* music is the later refinement D45 names.

import { rational } from '../engine/core/time.ts';
import { createDocument, createModuleLayer } from './create.ts';
import type { ProjectDocument } from './document.ts';
import { applyLayerPreset, applyProjectPreset, type ManifestLookup, type Preset } from './presets.ts';

export const THUMBNAIL = {
  width: 192,
  height: 108,
  frames: 8,
  fps: 30,
  /** Seconds of reference audio the frames are spread over, and where they start. */
  start: 0.6,
  step: 0.35,
  /** How long the reference track must be to cover every frame. */
  referenceSeconds: 4,
} as const;

/** Frame indices (at THUMBNAIL.fps) the strip is made of. */
export function thumbnailFrames(): number[] {
  return Array.from({ length: THUMBNAIL.frames }, (_, i) => Math.round((THUMBNAIL.start + i * THUMBNAIL.step) * THUMBNAIL.fps));
}

/**
 * The project a thumbnail is drawn from. A layer preset is applied onto a fresh layer of its own
 * module; a project preset replaces the look of a blank project. The canvas is small and dark so
 * glow and colour read at card size. Notes from applying (a module that is not installed, say) are
 * returned for the browser to show on the card.
 */
export function thumbnailDocument(
  preset: Preset,
  manifests: ManifestLookup,
  newId: () => string,
): { readonly document: ProjectDocument; readonly notes: readonly string[] } {
  const blank = createDocument({
    id: newId(),
    name: preset.name,
    timestamp: '2026-01-01T00:00:00.000Z',
    canvas: { width: THUMBNAIL.width, height: THUMBNAIL.height, fps: rational(THUMBNAIL.fps), background: '#05060a' },
  });
  if (preset.scope === 'project') {
    const applied = applyProjectPreset(preset, blank, { newId, manifests });
    return { document: applied.document, notes: applied.notes };
  }
  const target = createModuleLayer(preset.module.id, { id: newId(), name: preset.name });
  const applied = applyLayerPreset(preset, target, { newId, manifests });
  return { document: { ...blank, layers: [applied.layer] }, notes: applied.notes };
}
