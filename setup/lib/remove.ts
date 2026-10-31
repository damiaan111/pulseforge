import { readdir, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { COLOR_EMOJI_FONT, EXTRA_ARTEFACTS, ISF_FILES, MILKDROP_PRESETS, type ExtraId } from '../manifest.ts';
import { dropArtefacts, readVendorLock, writeVendorLock } from './lockfile.ts';
import { createLogger } from './log.ts';
import { MODELS, SETUP_LOG, VENDOR, insideVendor } from './paths.ts';

// Taking a component off the disk: its files, and its lines in the lock, so `--verify` and the
// licence list do not go on naming it. Only what it alone owns: anything shared stays (components.ts).

async function dropIfEmpty(folder: string): Promise<void> {
  const left = await readdir(folder).catch(() => null);
  if (left !== null && left.length === 0) await rmdir(insideVendor(folder));
}

export async function removeComponent(id: string): Promise<void> {
  const lock = await readVendorLock(createLogger(SETUP_LOG));
  if (id === 'milkdrop') {
    await rm(insideVendor(join(VENDOR, 'milkdrop')), { recursive: true, force: true });
    dropArtefacts(lock, new Set([MILKDROP_PRESETS.id]));
    await writeVendorLock(lock);
    return;
  }
  if (id === 'isf') {
    await rm(insideVendor(join(VENDOR, ISF_FILES.installDir)), { recursive: true, force: true });
    dropArtefacts(lock, new Set([ISF_FILES.id]));
    await writeVendorLock(lock);
    return;
  }
  const files = id === 'emoji' ? [COLOR_EMOJI_FONT] : EXTRA_ARTEFACTS[id as ExtraId];
  if (files === undefined) throw new Error(`"${id}" cannot be removed on its own.`);
  for (const file of files) {
    await rm(insideVendor(join(VENDOR, file.installDir, file.fileName)), { force: true });
    await dropIfEmpty(join(VENDOR, file.installDir));
  }
  // The Demucs extras leave a yaml beside their weights: it is what makes the model selectable.
  if (id.startsWith('htdemucs')) await rm(insideVendor(join(MODELS, 'demucs', `${id}.yaml`)), { force: true });
  dropArtefacts(lock, new Set(files.map((file) => file.id)));
  await writeVendorLock(lock);
}
