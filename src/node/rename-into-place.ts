// The last step of every atomic write: move a finished temp file over its destination.
//
// `rename` is atomic and is always tried first. It fails with EXDEV ("cross-device link not
// permitted") when Windows redirects a folder behind the caller's back — on the build machine
// `%APPDATA%\Electron` is transparently redirected to `C:\WpSystem\…`, so a temp file and its
// destination in the *same* directory count as different devices, and the render queue could not
// save its state at startup. Copy-then-delete is not atomic, but it is the only move that works
// there, and the temp file is complete before it starts, so the window for a torn file is the
// copy itself rather than the whole write.

import { copyFile, rename, rm } from 'node:fs/promises';

let tempCounter = 0;

/**
 * A temp name beside `path` that no other write in this process will pick. It used to be
 * `path.<pid>.tmp`, which two concurrent writes of the same file share — the preview analysing a
 * track while a queued render analyses the same one, or the queue persisting from its loop while
 * an IPC call persists too — and the second rename then fails because the first already moved it.
 * Still ends in `.tmp`, which the cache's cleanup recognises.
 */
export function tempPathFor(path: string): string {
  tempCounter += 1;
  return `${path}.${process.pid}-${tempCounter}.tmp`;
}

export async function renameIntoPlace(temp: string, destination: string): Promise<void> {
  try {
    await rename(temp, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await copyFile(temp, destination);
    await rm(temp, { force: true });
  }
}
