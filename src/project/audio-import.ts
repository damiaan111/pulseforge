// A file becoming the project's audio, as one undoable step: on its own, or with the video it came
// from placed as a background. Undoing "use this video" must not leave half of it behind.

import { secondsToTicks } from '../engine/core/time.ts';
import { addAsset, addLayer, findAssetByHash, sequence, setAudio } from './commands.ts';
import { createModuleLayer } from './create.ts';
import type { AssetRef, ProjectDocument } from './document.ts';
import type { Command } from './history.ts';

/** What the track's file is: the timeline takes its length from here, and export the path. */
export function useAudioCommand(path: string, durationSeconds: number): Command {
  return setAudio({ path, durationTicks: secondsToTicks(durationSeconds), clipOutTicks: null });
}

/**
 * The audio, the clip and a video layer under everything else. A clip the project already holds is
 * shared, not imported twice (the id the layer points at is the one already there).
 */
export function useVideoAsBackground(
  document: ProjectDocument,
  options: { readonly path: string; readonly durationSeconds: number; readonly asset: AssetRef; readonly layerId: string; readonly videoModule: string },
): Command {
  const { asset } = options;
  const existing = findAssetByHash(document, asset.hash);
  const layer = createModuleLayer(options.videoModule, { id: options.layerId, name: asset.name, params: { video: existing?.id ?? asset.id } });
  return sequence(`Use ${asset.name}: sound and picture`, [
    useAudioCommand(options.path, options.durationSeconds),
    ...(existing === undefined ? [addAsset(asset)] : []),
    addLayer(layer, { index: 0 }),
  ]);
}
