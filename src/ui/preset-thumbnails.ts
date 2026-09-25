// Preset thumbnails in the studio (S8, D45).
//
// A thumbnail is drawn once, then read from the main process's cache ever after: the key is the
// preset's content plus the engine version (preset-store.ts), so the same preset never renders
// twice and a changed one never shows a stale picture. Missing ones are drawn here, by the preview
// host's stills engine (host.ts `renderStills`), one at a time so a panel of fifty does not stall
// the preview, and only when a card actually asks — the browser asks as cards scroll into view.
//
// The strip is THUMBNAIL.frames pictures side by side in one PNG; the card steps through them.

import { analyzeMix } from '../analysis/analyze.ts';
import { synthesizeTestTrack } from '../analysis/reference-track.ts';
import type { AnalysisSet } from '../engine/core/analysis.ts';
import { newId } from '../project/ids.ts';
import { THUMBNAIL, thumbnailDocument, thumbnailFrames } from '../project/preset-thumbnail.ts';
import type { ManifestLookup, Preset } from '../project/presets.ts';
import { toRenderProject } from '../project/snapshot.ts';
import type { PresetListing } from '../shell/ipc.ts';
import type { PreviewHost } from './preview/host.ts';

let host: PreviewHost | null = null;

/** The canvas pane registers its host here; thumbnails wait until there is one. */
export function setThumbnailHost(next: PreviewHost | null): void {
  host = next;
}

/** The preview host stills are drawn on — the director's roll thumbnails use it too. */
export function thumbnailHost(): PreviewHost | null {
  return host;
}

let reference: AnalysisSet | undefined;
function referenceAnalysis(): AnalysisSet {
  if (reference === undefined) {
    const { analysis, beatGrid } = analyzeMix(synthesizeTestTrack(THUMBNAIL.referenceSeconds));
    reference = { ...analysis, beatGrid };
  }
  return reference;
}

const urls = new Map<string, string>();
const pending = new Map<string, Promise<string | null>>();
/** Renders run one after another: each one is a burst of GPU work on the preview's context. */
let queue: Promise<unknown> = Promise.resolve();

/** A thumbnail being drawn or fetched right now — e.g. just after Save — to wait on. */
export function pendingThumbnail(key: string): Promise<string | null> | undefined {
  return pending.get(key);
}

/** A thumbnail already in memory, without asking for one. */
export function cachedThumbnail(key: string): string | undefined {
  return urls.get(key);
}

/**
 * An object URL for the preset's strip: from memory, from the disk cache, or drawn now and cached.
 * Null when it cannot be drawn yet (no preview context) — asking again later tries again.
 */
export function thumbnailUrl(entry: PresetListing, manifests: ManifestLookup): Promise<string | null> {
  const known = urls.get(entry.thumbnailKey);
  if (known !== undefined) return Promise.resolve(known);
  const inFlight = pending.get(entry.thumbnailKey);
  if (inFlight !== undefined) return inFlight;

  const job = (async () => {
    let png = await window.pulseforge.presetThumbnail(entry.thumbnailKey);
    if (png === null) {
      const drawn = queue.then(() => drawThumbnail(entry.preset, manifests));
      queue = drawn.catch(() => undefined);
      png = await drawn;
      if (png === null) return null;
      await window.pulseforge.storePresetThumbnail(entry.thumbnailKey, png);
    }
    const url = URL.createObjectURL(new Blob([png as BlobPart], { type: 'image/png' }));
    urls.set(entry.thumbnailKey, url);
    return url;
  })();
  pending.set(entry.thumbnailKey, job);
  // Failures and "not yet" are not remembered: the next request tries again.
  void job.then((url) => { if (url === null) pending.delete(entry.thumbnailKey); }, () => pending.delete(entry.thumbnailKey));
  return job;
}

/** Draws the strip: the preset on a blank project, at THUMBNAIL.frames moments, side by side. */
export async function drawThumbnail(preset: Preset, manifests: ManifestLookup): Promise<Uint8Array | null> {
  if (host === null) return null;
  const { document } = thumbnailDocument(preset, manifests, newId);
  const { project } = toRenderProject(document);
  const frames = host.renderStills(project, referenceAnalysis(), thumbnailFrames());
  if (frames === null) return null;

  const { width, height } = THUMBNAIL;
  const strip = new OffscreenCanvas(width * frames.length, height);
  const context = strip.getContext('2d');
  if (context === null) return null;
  frames.forEach((pixels, index) => {
    context.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), index * width, 0);
  });
  const blob = await strip.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}
