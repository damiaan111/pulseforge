// Reading and writing `.pvproj` files. Bytes only — parsing and serialisation live in
// `src/project/`, which is pure and runs on either side of the IPC boundary.
//
// Two properties, both cheap here and expensive to retrofit:
//
//  1. **Writes are atomic.** The text goes to a temporary file in the same directory, is
//     flushed to disk, and is then renamed over the target. A crash or a full disk mid-save
//     leaves the previous version intact instead of a half-written file. Same directory
//     matters: `rename` is only atomic within a filesystem.
//  2. **A migration backs up first.** Before the first save of a document that was migrated
//     forward, the original is copied to `name.v3.bak` (data-formats §2.2). If the migration
//     was wrong, last year's project is still there.

import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { backupPathFor } from '../project/migrate.ts';

export class ProjectIoError extends Error {
  readonly path: string;
  readonly fixes: readonly string[];

  constructor(message: string, path: string, fixes: readonly string[] = [], options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProjectIoError';
    this.path = path;
    this.fixes = fixes;
  }
}

export async function readProjectText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new ProjectIoError(`This project file no longer exists: ${path}`, path, ['Check whether it was moved or renamed'], { cause });
    }
    if (code === 'EACCES' || code === 'EPERM') {
      throw new ProjectIoError(`Pulseforge is not allowed to read ${path}.`, path, ['Check the file’s permissions', 'Close it in any other application that may have locked it'], { cause });
    }
    throw new ProjectIoError(`Could not read ${path}: ${(cause as Error).message}`, path, [], { cause });
  }
}

export interface WriteOptions {
  /** Present when this is the first save after a migration; triggers the `.bak` copy. */
  readonly backupFromVersion?: number;
}

export interface WriteResult {
  readonly path: string;
  readonly backupPath?: string;
}

export async function writeProjectText(path: string, text: string, options: WriteOptions = {}): Promise<WriteResult> {
  const directory = dirname(path);
  try {
    await mkdir(directory, { recursive: true });
  } catch (cause) {
    throw new ProjectIoError(`Could not create the folder ${directory}.`, path, ['Choose a different location'], { cause });
  }

  let backupPath: string | undefined;
  if (options.backupFromVersion !== undefined && existsSync(path)) {
    const candidate = backupPathFor(path, options.backupFromVersion);
    // Never overwrite an existing backup: the first one is the original, and later saves in
    // the same session would otherwise replace it with already-migrated content.
    if (!existsSync(candidate)) {
      try {
        await copyFile(path, candidate);
        backupPath = candidate;
      } catch (cause) {
        throw new ProjectIoError(
          `Could not back up the original before saving the migrated project.`,
          path,
          ['Check free space and permissions on the project folder', 'The project has not been modified'],
          { cause },
        );
      }
    }
  }

  // A distinctive name, in the same directory so the rename stays atomic.
  const temporary = join(directory, `.${Date.now().toString(36)}.pulseforge.tmp`);
  try {
    await writeFile(temporary, text, 'utf8');
    await rename(temporary, path);
  } catch (cause) {
    await rm(temporary, { force: true });
    const code = (cause as NodeJS.ErrnoException).code;
    const fixes = code === 'ENOSPC'
      ? ['Free some disk space and save again']
      : ['Check permissions on the project folder', 'The previous version of the file is untouched'];
    throw new ProjectIoError(`Could not save ${path}: ${(cause as Error).message}`, path, fixes, { cause });
  }

  return backupPath === undefined ? { path } : { path, backupPath };
}
