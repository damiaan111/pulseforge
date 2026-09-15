// Presets on disk (M25, S8, module-spec §10, data-formats §3).
//
// A folder of small JSON files, not a database: presets are meant to be copied between machines,
// dropped into a folder, kept in git and hand-edited when something is one value off. A binary
// store would make all four awkward for no gain — the whole library is a few hundred kilobytes.
//
// Two sources, merged on read:
//   builtin/  ships with the app; read-only, so an update can improve it (D16)
//   user/     saved from the app; writable, and always wins a name collision
//
// The browser (S8) is a view over `list()`; nothing here draws anything.

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { renameIntoPlace } from '../node/rename-into-place.ts';
import { join } from 'node:path';

import { parsePreset, stringifyPreset, PresetError, type Preset } from './presets.ts';

export type PresetOrigin = 'builtin' | 'user';

export interface PresetEntry {
  /** Stable within a store: the filename stem, which is also what a reference would use. */
  readonly slug: string;
  readonly origin: PresetOrigin;
  readonly path: string;
  readonly name: string;
  readonly scope: 'layer' | 'project';
  readonly tags: readonly string[];
  /** The module a layer preset is for; undefined for project presets. */
  readonly moduleId: string | undefined;
  readonly preset: Preset;
}

/** A file that could not be read, kept so the browser can say so rather than showing a gap. */
export interface PresetProblem {
  readonly path: string;
  readonly message: string;
}

export interface PresetLibrary {
  readonly entries: readonly PresetEntry[];
  readonly problems: readonly PresetProblem[];
}

export interface PresetStoreOptions {
  /** Where user presets are written. `builtin/` and `user/` live under it. */
  readonly root: string;
  /** Read-only presets shipped with the app; defaults to `<root>/builtin`. */
  readonly builtinRoot?: string;
}

/**
 * A filename from a preset name: lowercase, ASCII-ish, no separators.
 *
 * Presets are named by people — "Neon Pulse ⚡ (v2)" is a perfectly good name and a terrible
 * filename. The slug is for the filesystem; the name inside the file is what is displayed, so
 * nothing about the name is lost by slugging it.
 */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug === '' ? 'preset' : slug;
}

export class PresetStore {
  private readonly root: string;
  private readonly builtinRoot: string;

  constructor(options: PresetStoreOptions) {
    this.root = options.root;
    this.builtinRoot = options.builtinRoot ?? join(options.root, 'builtin');
  }

  userDir(scope: 'layer' | 'project'): string {
    return join(this.root, 'user', scope);
  }

  builtinDir(scope: 'layer' | 'project'): string {
    return join(this.builtinRoot, scope);
  }

  /**
   * Everything in the library.
   *
   * A file that will not parse becomes a **problem**, not an exception: one bad preset must not
   * hide the other two hundred, and the browser can show what is wrong with it. User presets are
   * read last so a user preset with the same slug shadows the built-in one it was derived from.
   */
  async list(): Promise<PresetLibrary> {
    const entries: PresetEntry[] = [];
    const problems: PresetProblem[] = [];
    const bySlug = new Map<string, number>();

    for (const origin of ['builtin', 'user'] as const) {
      for (const scope of ['layer', 'project'] as const) {
        const dir = origin === 'builtin' ? this.builtinDir(scope) : this.userDir(scope);
        for (const file of await jsonFilesIn(dir)) {
          const path = join(dir, file);
          try {
            const preset = parsePreset(JSON.parse(await readFile(path, 'utf8')));
            const entry: PresetEntry = {
              slug: file.replace(/\.json$/i, ''),
              origin,
              path,
              name: preset.name,
              scope: preset.scope,
              tags: preset.tags,
              moduleId: preset.scope === 'layer' ? preset.module.id : undefined,
              preset,
            };
            const existing = bySlug.get(`${scope}/${entry.slug}`);
            if (existing === undefined) {
              bySlug.set(`${scope}/${entry.slug}`, entries.length);
              entries.push(entry);
            } else {
              entries[existing] = entry; // user shadows builtin
            }
          } catch (cause) {
            problems.push({ path, message: cause instanceof Error ? cause.message : String(cause) });
          }
        }
      }
    }
    entries.sort((a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug));
    return { entries, problems };
  }

  /**
   * Save a preset into the user library and return its slug.
   *
   * Slugs are made unique by suffixing rather than overwriting: saving "Neon Pulse" twice gives
   * two presets, because silently replacing the first would destroy work that took real effort to
   * dial in. `overwrite` is the explicit "replace it" path.
   */
  async save(preset: Preset, options: { readonly slug?: string; readonly overwrite?: boolean } = {}): Promise<string> {
    const dir = this.userDir(preset.scope);
    await mkdir(dir, { recursive: true });
    const taken = new Set((await jsonFilesIn(dir)).map((file) => file.replace(/\.json$/i, '')));

    let slug = options.slug ?? slugify(preset.name);
    if (!(options.overwrite === true && options.slug !== undefined)) {
      let suffix = 2;
      const base = slug;
      while (taken.has(slug)) slug = `${base}-${suffix++}`;
    }
    await writeAtomic(join(dir, `${slug}.json`), stringifyPreset(preset));
    return slug;
  }

  async read(scope: 'layer' | 'project', slug: string): Promise<Preset> {
    for (const dir of [this.userDir(scope), this.builtinDir(scope)]) {
      const path = join(dir, `${slug}.json`);
      try {
        return parsePreset(JSON.parse(await readFile(path, 'utf8')));
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
      }
    }
    throw new PresetError(`No preset "${slug}" in the ${scope} library.`, ['Check the preset browser for its exact name']);
  }

  /** Delete a user preset. Built-ins are shipped with the app and are not the user's to remove. */
  async remove(scope: 'layer' | 'project', slug: string): Promise<void> {
    const path = join(this.userDir(scope), `${slug}.json`);
    try {
      await rm(path);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
      // Two quite different situations, and saying which is which saves a confused minute:
      // the preset exists but is not the user's to delete, or there is no such preset at all.
      const isBuiltin = (await jsonFilesIn(this.builtinDir(scope))).includes(`${slug}.json`);
      throw isBuiltin
        ? new PresetError(`"${slug}" is a built-in preset and cannot be deleted.`, [
            'Save your own version and delete that instead',
          ])
        : new PresetError(`There is no preset "${slug}" in the ${scope} library.`);
    }
  }

  async rename(scope: 'layer' | 'project', slug: string, newName: string): Promise<string> {
    const preset = await this.read(scope, slug);
    await this.remove(scope, slug).catch(() => undefined);
    return this.save({ ...preset, name: newName } as Preset);
  }
}

/**
 * Search the library by free text and tags.
 *
 * Pure, so the browser's filtering is testable without a filesystem — and so the same function
 * can filter a list that came from anywhere.
 */
export function searchPresets(
  entries: readonly PresetEntry[],
  query: { readonly text?: string; readonly tags?: readonly string[]; readonly scope?: 'layer' | 'project'; readonly moduleId?: string },
): readonly PresetEntry[] {
  const text = query.text?.trim().toLowerCase() ?? '';
  return entries.filter((entry) => {
    if (query.scope !== undefined && entry.scope !== query.scope) return false;
    if (query.moduleId !== undefined && entry.moduleId !== query.moduleId) return false;
    // Every requested tag must be present — filters narrow, they do not widen.
    if (query.tags !== undefined && !query.tags.every((tag) => entry.tags.includes(tag))) return false;
    if (text === '') return true;
    const haystack = `${entry.name} ${entry.tags.join(' ')} ${entry.moduleId ?? ''}`.toLowerCase();
    return haystack.includes(text);
  });
}

/** Every tag in the library with how often it is used — the browser's tag list. */
export function tagCounts(entries: readonly PresetEntry[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    for (const tag of entry.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return new Map([...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

async function jsonFilesIn(dir: string): Promise<readonly string[]> {
  try {
    return (await readdir(dir)).filter((file) => file.toLowerCase().endsWith('.json'));
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    // ENOTDIR as well as ENOENT: a file where the folder should be is "no presets here", not a
    // crash — the same lesson as the analysis cache (§4.22).
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw cause;
  }
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, text, 'utf8');
  await renameIntoPlace(temp, path);
}
