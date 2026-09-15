// "Find missing files in a folder" (M40 relink): the user points at a folder, and every missing
// asset whose file is somewhere under it is found — by content, not by name.
//
// The hash decides. A file with the right name but different bytes is a different image (a
// re-export, a crop) and is not silently accepted (data-formats §1.2); a renamed file with the
// same bytes is the one that went missing. Hashing every file under a photo library would take
// minutes, so only *candidates* are hashed: files whose size matches the recorded size, or —
// for assets recorded before sizes were — whose name matches.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

export interface WantedFile {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly hash: string;
}

export interface FoundFile {
  readonly id: string;
  readonly path: string;
  readonly size: number;
  readonly name: string;
  readonly hash: string;
}

export interface SearchLimits {
  /** Folder depth below the chosen folder. */
  readonly maxDepth?: number;
  /** Stop listing after this many files, so a drive root cannot hang the app. */
  readonly maxFiles?: number;
}

export interface SearchResult {
  readonly found: readonly FoundFile[];
  readonly filesListed: number;
  /** True when a limit stopped the listing before the whole tree was seen. */
  readonly truncated: boolean;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export async function findFilesInFolder(folder: string, wanted: readonly WantedFile[], limits: SearchLimits = {}): Promise<SearchResult> {
  const maxDepth = limits.maxDepth ?? 8;
  const maxFiles = limits.maxFiles ?? 50_000;
  const open = new Map(wanted.filter((w) => w.hash !== '').map((w) => [w.id, w]));
  const found: FoundFile[] = [];
  const hashed = new Map<string, string>();
  let filesListed = 0;
  let truncated = false;

  const consider = async (path: string, size: number) => {
    const name = basename(path).toLowerCase();
    const candidates = [...open.values()].filter((w) => (w.size > 0 ? w.size === size : w.name.toLowerCase() === name));
    if (candidates.length === 0) return;
    let hash = hashed.get(path);
    if (hash === undefined) {
      try {
        hash = await sha256File(path);
      } catch {
        return; // unreadable: not a match, and not worth failing the search over
      }
      hashed.set(path, hash);
    }
    for (const candidate of candidates) {
      if (candidate.hash !== hash) continue;
      found.push({ id: candidate.id, path, size, name: basename(path), hash });
      open.delete(candidate.id);
    }
  };

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (open.size === 0 || truncated) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // permission denied and the like: skip that folder
    }
    // Files before folders, so a match next to the project is found before a deep walk.
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      filesListed += 1;
      if (filesListed > maxFiles) {
        truncated = true;
        return;
      }
      const path = join(dir, entry.name);
      try {
        await consider(path, (await stat(path)).size);
      } catch {
        // vanished mid-walk
      }
      if (open.size === 0) return;
    }
    if (depth >= maxDepth) {
      if (entries.some((e) => e.isDirectory())) truncated = true;
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        await walk(join(dir, entry.name), depth + 1);
      }
    }
  };

  await walk(folder, 0);
  return { found, filesListed: Math.min(filesListed, maxFiles), truncated };
}
