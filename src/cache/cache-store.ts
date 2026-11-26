// The cache, as the user sees it (M33, PROJECT.md §8.14): what is in it, what it is for, what it
// costs, and how to get the space back.
//
// Everything under the cache root is **rebuildable** — deleting any of it costs time, never data
// (analysis, stems, video proxies, preset thumbnails, scratch). So this module can offer to delete
// anything, and the only rule it enforces is not to delete what the open project is using *right
// now* (a ceiling that evicted the stems you are listening to would be a bug that looks like data
// loss).
//
// The cache is keyed by content hashes, which say nothing to a person. A small usage index
// (`usage.json` at the root) remembers, per hash, what it was (the track's or video's file name)
// and when it was last used. It is itself rebuildable: without it every unit is still listed, by
// hash, with its files' modification time standing in for "last used".
//
// Units: a **track** is its analysis and its stems together (they are made from, and only useful
// with, the same audio); a **video** is its extracted frames; **preset thumbnails** and **scratch**
// are one unit each; anything else under the root is listed as "other", never silently ignored.
//
// Plain Node: used by the main process, tested directly.

import { readFile, readdir, rm, stat, statfs, writeFile, mkdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import { renameIntoPlace, tempPathFor } from '../node/rename-into-place.ts';

export const CACHE_CATEGORIES = ['track', 'video', 'thumbnails', 'scratch', 'other'] as const;
export type CacheCategory = (typeof CACHE_CATEGORIES)[number];

export interface CacheUnit {
  /** Stable within a scan: `track:<hash>`, `video:<hash>`, `thumbnails`, `scratch`, `other:<name>`. */
  readonly id: string;
  readonly category: CacheCategory;
  /** A person's name for it: the track's file name, or the hash when it is not known. */
  readonly label: string;
  readonly bytes: number;
  /** Milliseconds since the epoch; from the usage index, or the newest file time. */
  readonly lastUsed: number;
  /** For a track: how its bytes split. */
  readonly parts: Readonly<Record<string, number>>;
  /** The directories or files it consists of, absolute. */
  readonly paths: readonly string[];
}

export interface CacheInventory {
  readonly root: string;
  readonly units: readonly CacheUnit[];
  readonly totalBytes: number;
  readonly byCategory: Readonly<Record<CacheCategory, number>>;
  /** Free space on the cache's drive, bytes; null when it could not be read. */
  readonly freeBytes: number | null;
}

interface UsageEntry {
  readonly name: string;
  readonly lastUsed: number;
}

interface UsageFile {
  readonly version: 1;
  readonly entries: Readonly<Record<string, UsageEntry>>;
}

const USAGE_FILE = 'usage.json';
/** Directories under the root that belong to a known category. */
const KNOWN = new Set(['analysis', 'stems', 'video', 'preset-thumbnails', 'scratch']);

export class CacheStore {
  readonly root: string;
  private readonly now: () => number;

  constructor(options: { readonly root: string; readonly now?: () => number }) {
    this.root = resolve(options.root);
    this.now = options.now ?? (() => Date.now());
  }

  // --- the usage index -------------------------------------------------------------------------

  private async readUsage(): Promise<Record<string, UsageEntry>> {
    try {
      const raw = JSON.parse(await readFile(join(this.root, USAGE_FILE), 'utf8')) as Partial<UsageFile>;
      const out: Record<string, UsageEntry> = {};
      for (const [key, value] of Object.entries(raw.entries ?? {})) {
        if (typeof value?.name === 'string' && typeof value.lastUsed === 'number') out[key] = { name: value.name, lastUsed: value.lastUsed };
      }
      return out;
    } catch {
      // Missing or damaged: the index is rebuildable, and every unit is still listed without it.
      return {};
    }
  }

  /**
   * Records that a track (`track:<audioHash>`) or video (`video:<hash>`) was just used, and what it
   * is called. Best-effort: failing to write the index never fails the work that used the cache.
   */
  async touch(id: string, name: string): Promise<void> {
    try {
      const entries = await this.readUsage();
      entries[id] = { name, lastUsed: this.now() };
      await mkdir(this.root, { recursive: true });
      const path = join(this.root, USAGE_FILE);
      const temp = tempPathFor(path);
      await writeFile(temp, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, 'utf8');
      await renameIntoPlace(temp, path);
    } catch {
      // Best-effort, as above.
    }
  }

  // --- scanning --------------------------------------------------------------------------------

  async inventory(): Promise<CacheInventory> {
    const usage = await this.readUsage();
    const units: CacheUnit[] = [];
    const tracks = new Map<string, { parts: Record<string, number>; paths: string[]; newest: number }>();
    const addTrack = (hash: string, part: string, size: { bytes: number; newest: number }, path: string) => {
      const t = tracks.get(hash) ?? { parts: {}, paths: [], newest: 0 };
      t.parts[part] = (t.parts[part] ?? 0) + size.bytes;
      t.paths.push(path);
      t.newest = Math.max(t.newest, size.newest);
      tracks.set(hash, t);
    };

    for (const hash of await dirs(join(this.root, 'analysis'))) {
      const path = join(this.root, 'analysis', hash);
      addTrack(hash, 'analysis', await sizeOf(path), path);
    }
    for (const hash of await dirs(join(this.root, 'stems'))) {
      const path = join(this.root, 'stems', hash);
      addTrack(hash, 'stems', await sizeOf(path), path);
    }
    for (const [hash, t] of tracks) {
      const known = usage[`track:${hash}`];
      units.push({
        id: `track:${hash}`, category: 'track', label: known?.name ?? `Track ${hash.slice(0, 10)}…`,
        bytes: Object.values(t.parts).reduce((a, b) => a + b, 0), lastUsed: known?.lastUsed ?? t.newest, parts: t.parts, paths: t.paths,
      });
    }
    for (const hash of await dirs(join(this.root, 'video'))) {
      const path = join(this.root, 'video', hash);
      const size = await sizeOf(path);
      const known = usage[`video:${hash}`];
      units.push({ id: `video:${hash}`, category: 'video', label: known?.name ?? `Video ${hash.slice(0, 10)}…`, bytes: size.bytes, lastUsed: known?.lastUsed ?? size.newest, parts: {}, paths: [path] });
    }
    for (const [name, category] of [['preset-thumbnails', 'thumbnails'], ['scratch', 'scratch']] as const) {
      const path = join(this.root, name);
      const size = await sizeOf(path);
      if (size.bytes > 0) units.push({ id: category, category, label: category === 'thumbnails' ? 'Preset thumbnails' : 'Scratch files', bytes: size.bytes, lastUsed: size.newest, parts: {}, paths: [path] });
    }
    for (const name of await entries(this.root)) {
      if (KNOWN.has(name) || name === USAGE_FILE || name.endsWith('.tmp')) continue;
      const path = join(this.root, name);
      const size = await sizeOf(path);
      units.push({ id: `other:${name}`, category: 'other', label: name, bytes: size.bytes, lastUsed: size.newest, parts: {}, paths: [path] });
    }

    units.sort((a, b) => b.bytes - a.bytes);
    const byCategory = Object.fromEntries(CACHE_CATEGORIES.map((c) => [c, 0])) as Record<CacheCategory, number>;
    for (const u of units) byCategory[u.category] += u.bytes;
    let freeBytes: number | null;
    try {
      await mkdir(this.root, { recursive: true });
      const fs = await statfs(this.root);
      freeBytes = Number(fs.bavail) * Number(fs.bsize);
    } catch {
      freeBytes = null;
    }
    return { root: this.root, units, totalBytes: units.reduce((a, u) => a + u.bytes, 0), byCategory, freeBytes };
  }

  // --- removing --------------------------------------------------------------------------------

  /**
   * Deletes units by id. Ids in `protect` (what the open project uses) are skipped and returned,
   * so the caller can say why they are still there. Every path is checked to lie inside the root
   * before anything is removed.
   */
  async remove(ids: readonly string[], protect: ReadonlySet<string> = new Set()): Promise<{ removed: CacheUnit[]; skipped: string[]; freedBytes: number }> {
    const inventory = await this.inventory();
    const removed: CacheUnit[] = [];
    const skipped: string[] = [];
    for (const id of ids) {
      const unit = inventory.units.find((u) => u.id === id);
      if (unit === undefined) continue;
      if (protect.has(id)) {
        skipped.push(id);
        continue;
      }
      for (const path of unit.paths) await rm(this.inside(path), { recursive: true, force: true });
      removed.push(unit);
    }
    return { removed, skipped, freedBytes: removed.reduce((a, u) => a + u.bytes, 0) };
  }

  /** Everything in one category (or every category), except what is protected. */
  async clear(category: CacheCategory | 'all', protect: ReadonlySet<string> = new Set()) {
    const inventory = await this.inventory();
    return this.remove(inventory.units.filter((u) => category === 'all' || u.category === category).map((u) => u.id), protect);
  }

  /** "Keep the last N": every track but the N most recently used goes. */
  async keepRecentTracks(keep: number, protect: ReadonlySet<string> = new Set()) {
    const tracks = (await this.inventory()).units.filter((u) => u.category === 'track').sort((a, b) => b.lastUsed - a.lastUsed);
    return this.remove(tracks.slice(Math.max(0, keep)).map((u) => u.id), protect);
  }

  /**
   * The LRU ceiling (§8.14): least recently used units go first until the cache fits. Protected
   * units never go; if they alone are over the ceiling, it stays over and says so.
   */
  async enforceCeiling(ceilingBytes: number, protect: ReadonlySet<string> = new Set()): Promise<{ removed: CacheUnit[]; totalBytes: number; overBy: number }> {
    const inventory = await this.inventory();
    if (ceilingBytes <= 0 || inventory.totalBytes <= ceilingBytes) return { removed: [], totalBytes: inventory.totalBytes, overBy: 0 };
    let total = inventory.totalBytes;
    const victims: string[] = [];
    for (const unit of [...inventory.units].sort((a, b) => a.lastUsed - b.lastUsed)) {
      if (total <= ceilingBytes) break;
      if (protect.has(unit.id)) continue;
      victims.push(unit.id);
      total -= unit.bytes;
    }
    const { removed } = await this.remove(victims, protect);
    return { removed, totalBytes: total, overBy: Math.max(0, total - ceilingBytes) };
  }

  private inside(path: string): string {
    const full = resolve(path);
    const rel = relative(this.root, full);
    if (rel === '' || rel.startsWith('..') || rel.includes(`..${sep}`) || resolve(this.root, rel) !== full) {
      throw new Error(`Refusing to delete ${full}: it is not inside the cache folder ${this.root}.`);
    }
    return full;
  }
}

async function entries(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function dirs(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of await entries(dir)) {
    try {
      if ((await stat(join(dir, name))).isDirectory()) out.push(name);
    } catch {
      // Vanished between listing and stat: nothing to count.
    }
  }
  return out;
}

/** Total bytes under a path and the newest modification time in it. */
export async function sizeOf(path: string): Promise<{ bytes: number; newest: number }> {
  let bytes = 0;
  let newest = 0;
  const walk = async (p: string): Promise<void> => {
    let info;
    try {
      info = await stat(p);
    } catch {
      return;
    }
    newest = Math.max(newest, info.mtimeMs);
    if (!info.isDirectory()) {
      bytes += info.size;
      return;
    }
    for (const name of await entries(p)) await walk(join(p, name));
  };
  await walk(path);
  return { bytes, newest };
}
