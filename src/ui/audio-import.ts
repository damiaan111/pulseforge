// Putting a file into the project as its audio, for the import button and for Combine audio files.

import { useAudioCommand, useVideoAsBackground } from '../project/audio-import.ts';
import type { AssetRef } from '../project/document.ts';
import { newId } from '../project/ids.ts';
import { videoManifest } from '../engine/modules/video.ts';
import { history, useStudio } from './store.ts';

/**
 * Loads `path` and records it, only once it has actually loaded: after a failure the store still
 * holds the previous track, and recording the new path with the old track's length made a document
 * whose timeline and file disagree. With `picture`, the video it came from goes in too, as one step.
 */
export async function adoptAudio(path: string, picture: AssetRef | null = null): Promise<boolean> {
  const studio = useStudio.getState();
  await studio.loadAudio(path);
  const loaded = useStudio.getState().audio;
  if (loaded === null || loaded.path !== path) return false;
  studio.run(picture === null
    ? useAudioCommand(path, loaded.durationSeconds)
    : useVideoAsBackground(history.current, { path, durationSeconds: loaded.durationSeconds, asset: picture, layerId: newId(), videoModule: videoManifest.id }));
  return true;
}

/** A chosen file's sound (a working copy if it needs one), and with `picture` its picture as the bottom layer. */
export async function adoptFile(path: string, picture: boolean): Promise<void> {
  const studio = useStudio.getState();
  try {
    const prepared = await window.pulseforge.prepareAudio(path, picture);
    const { video } = prepared;
    const asset: AssetRef | null = video === null
      ? null
      : { id: newId(), kind: 'video', path: video.path, hash: video.hash, size: video.size, name: video.name, extra: {} };
    await adoptAudio(prepared.path, asset);
  } catch (error) {
    studio.notify({ text: `Importing the file failed. ${error instanceof Error ? error.message : String(error)}`, kind: 'bad' });
  }
}
