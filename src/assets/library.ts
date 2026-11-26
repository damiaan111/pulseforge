// The managed library (M40, D6): a folder of backgrounds, logos and (later) fonts that every
// project can draw from.
//
// A plain folder on purpose — no database, no import step that renames files into hashes. The
// user can fill it from Explorer as well as from the app, and a project that uses a library file
// references it by path and hash like any other file, so relink and "collect files" treat it the
// same way. Sub-folders are categories (`backgrounds/`, `logos/`); one level deep is enough.

import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

import { IMAGE_EXTENSIONS } from './image-decode.ts';
import { sha256File } from './find-in-folder.ts';

export const LIBRARY_CATEGORIES = ['backgrounds', 'logos'] as const;

export interface LibraryEntry {
  readonly path: string;
  readonly name: string;
  readonly size: number;
  readonly category: string;
}

const isImage = (name: string) => (IMAGE_EXTENSIONS as readonly string[]).includes(extname(name).slice(1).toLowerCase());

/** Creates the folder and its category folders if needed, then lists every image, sorted by category then name. */
export async function listLibrary(folder: string): Promise<LibraryEntry[]> {
  await mkdir(folder, { recursive: true });
  for (const category of LIBRARY_CATEGORIES) await mkdir(join(folder, category), { recursive: true });
  const entries: LibraryEntry[] = [];
  const scan = async (dir: string, category: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && category === '' && !entry.name.startsWith('.')) {
        await scan(join(dir, entry.name), entry.name);
      } else if (entry.isFile() && isImage(entry.name)) {
        const path = join(dir, entry.name);
        entries.push({ path, name: entry.name, size: (await stat(path)).size, category });
      }
    }
  };
  await scan(folder, '');
  return entries.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

/**
 * Copies files into the library. A file already there with the same bytes is skipped; a different
 * file with the same name gets `name-2.ext`. Nothing in the library is ever overwritten.
 */
export async function addToLibrary(folder: string, files: readonly string[], category: string): Promise<{ added: string[]; skipped: string[] }> {
  const safeCategory = category === '' ? '' : basename(category); // no ../ out of the library
  const target = join(folder, safeCategory);
  await mkdir(target, { recursive: true });
  const added: string[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    const name = basename(file);
    const stem = name.slice(0, name.length - extname(name).length);
    const hash = await sha256File(file);
    for (let n = 1; ; n += 1) {
      const candidate = join(target, n === 1 ? name : `${stem}-${n}${extname(name)}`);
      if (!existsSync(candidate)) {
        await copyFile(file, candidate);
        added.push(candidate);
        break;
      }
      if ((await sha256File(candidate)) === hash) {
        skipped.push(candidate);
        break;
      }
    }
  }
  return { added, skipped };
}
