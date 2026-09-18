import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createModuleLayer } from '../../src/project/create.ts';
import { createLayerPreset, stringifyPreset, type ManifestLookup, type Preset } from '../../src/project/presets.ts';
import {
  PresetStore,
  presetThumbnailKey,
  searchPresets,
  slugify,
  tagCounts,
  type PresetEntry,
} from '../../src/project/preset-store.ts';

const manifests: ManifestLookup = () => ({ version: '1.0.0', paramsSchemaVersion: 1, defaults: { glow: 0.4 } });

let root: string;

function preset(name: string, tags: readonly string[] = [], module = 'core.visualizer.bars'): Preset {
  return createLayerPreset(createModuleLayer(module, { name, params: { glow: 0.9 } }), manifests, { name, tags });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pulseforge-presets-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('slugify', () => {
  it('turns a human name into a filename without losing the name', () => {
    // The name lives inside the file; the slug only has to survive a filesystem.
    expect(slugify('Neon Pulse ⚡ (v2)')).toBe('neon-pulse-v2');
    expect(slugify('Café Crème')).toBe('cafe-creme');
    expect(slugify('///')).toBe('preset');
    expect(slugify('x'.repeat(200))).toHaveLength(60);
  });
});

describe('PresetStore', () => {
  it('saves and reads a preset back', async () => {
    const store = new PresetStore({ root });
    const slug = await store.save(preset('Neon Pulse', ['neon', 'bars']));
    expect(slug).toBe('neon-pulse');

    const read = await store.read('layer', slug);
    expect(read.name).toBe('Neon Pulse');
    expect(read.tags).toEqual(['neon', 'bars']);
  });

  it('saving the same name twice keeps both', async () => {
    // Silently replacing the first would destroy a look that took real effort to dial in.
    const store = new PresetStore({ root });
    expect(await store.save(preset('Neon Pulse'))).toBe('neon-pulse');
    expect(await store.save(preset('Neon Pulse'))).toBe('neon-pulse-2');
    expect(await store.save(preset('Neon Pulse'))).toBe('neon-pulse-3');
    expect((await store.list()).entries).toHaveLength(3);
  });

  it('overwrite replaces deliberately', async () => {
    const store = new PresetStore({ root });
    await store.save(preset('Neon Pulse', ['old']));
    await store.save(preset('Neon Pulse', ['new']), { slug: 'neon-pulse', overwrite: true });
    const entries = (await store.list()).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.tags).toEqual(['new']);
  });

  it('lists an empty library without complaint', async () => {
    const store = new PresetStore({ root });
    expect(await store.list()).toEqual({ entries: [], problems: [] });
  });

  it('a user preset shadows a built-in with the same slug', async () => {
    const builtinRoot = join(root, 'shipped');
    await mkdir(join(builtinRoot, 'layer'), { recursive: true });
    await writeFile(join(builtinRoot, 'layer', 'neon-pulse.json'), stringifyPreset(preset('Neon Pulse', ['shipped'])));

    const store = new PresetStore({ root, builtinRoot });
    expect((await store.list()).entries[0]!.origin).toBe('builtin');

    await store.save(preset('Neon Pulse', ['mine']), { slug: 'neon-pulse', overwrite: true });
    const entries = (await store.list()).entries;
    // One entry, the user's — an app update improving the built-in must not fight the user's edit.
    expect(entries).toHaveLength(1);
    expect(entries[0]!.origin).toBe('user');
    expect(entries[0]!.tags).toEqual(['mine']);
  });

  it('one bad file does not hide the rest of the library', async () => {
    const store = new PresetStore({ root });
    await store.save(preset('Good One'));
    await writeFile(join(store.userDir('layer'), 'broken.json'), '{ not json');

    const { entries, problems } = await store.list();
    expect(entries.map((entry) => entry.name)).toEqual(['Good One']);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.path).toContain('broken.json');
  });

  it('reports a preset from another format version as a problem, not a crash', async () => {
    const store = new PresetStore({ root });
    await store.save(preset('Fine'));
    await writeFile(join(store.userDir('layer'), 'future.json'), JSON.stringify({ formatVersion: 99, scope: 'layer' }));
    const { entries, problems } = await store.list();
    expect(entries).toHaveLength(1);
    expect(problems[0]!.message).toContain('format 99');
  });

  it('ignores non-JSON files in the folder', async () => {
    const store = new PresetStore({ root });
    await store.save(preset('Real'));
    await writeFile(join(store.userDir('layer'), 'notes.txt'), 'scratch');
    await writeFile(join(store.userDir('layer'), 'Thumbs.db'), 'x');
    expect((await store.list()).entries).toHaveLength(1);
  });

  it('a file where the preset folder should be reads as an empty library', async () => {
    // The same lesson as the analysis cache: a stray file must not throw ENOTDIR at the browser.
    await mkdir(join(root, 'user'), { recursive: true });
    await writeFile(join(root, 'user', 'layer'), 'not a folder');
    const store = new PresetStore({ root });
    await expect(store.list()).resolves.toEqual({ entries: [], problems: [] });
  });

  it('separates layer and project scopes', async () => {
    const store = new PresetStore({ root });
    await store.save(preset('A Layer'));
    await store.save({ formatVersion: 1, scope: 'project', name: 'A Project', tags: [], palette: { colors: [], roles: {}, extra: {} }, layers: [], globalEffects: [] });

    const { entries } = await store.list();
    expect(entries.map((entry) => entry.scope).sort()).toEqual(['layer', 'project']);
    await expect(store.read('project', 'a-project')).resolves.toMatchObject({ name: 'A Project' });
    await expect(store.read('layer', 'a-project')).rejects.toThrow(/No preset/);
  });

  it('deletes a user preset and refuses to delete a built-in', async () => {
    const builtinRoot = join(root, 'shipped');
    await mkdir(join(builtinRoot, 'layer'), { recursive: true });
    await writeFile(join(builtinRoot, 'layer', 'shipped.json'), stringifyPreset(preset('Shipped')));

    const store = new PresetStore({ root, builtinRoot });
    const slug = await store.save(preset('Mine'));
    await store.remove('layer', slug);
    expect((await store.list()).entries.map((entry) => entry.name)).toEqual(['Shipped']);

    await expect(store.remove('layer', 'shipped')).rejects.toThrow(/cannot be deleted/);
  });

  it('renames by writing a new slug', async () => {
    const store = new PresetStore({ root });
    const slug = await store.save(preset('Old Name', ['keep']));
    const renamed = await store.rename('layer', slug, 'New Name');

    expect(renamed).toBe('new-name');
    const { entries } = await store.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe('New Name');
    expect(entries[0]!.tags).toEqual(['keep']); // everything else survives
  });

  it('writes files a person can read and edit', async () => {
    const store = new PresetStore({ root });
    const slug = await store.save(preset('Readable'));
    const text = await readFile(join(store.userDir('layer'), `${slug}.json`), 'utf8');
    expect(text).toContain('\n  "name": "Readable"');
    expect(text.endsWith('\n')).toBe(true);
  });
});

describe('searchPresets', () => {
  const entries = [
    { name: 'Neon Pulse', slug: 'neon-pulse', tags: ['neon', 'bars'], scope: 'layer', moduleId: 'core.visualizer.bars' },
    { name: 'Minimal Type', slug: 'minimal-type', tags: ['minimal'], scope: 'layer', moduleId: 'core.text.title' },
    { name: 'Whole Look', slug: 'whole-look', tags: ['neon'], scope: 'project', moduleId: undefined },
  ] as unknown as PresetEntry[];

  it('matches name, tag and module', () => {
    expect(searchPresets(entries, { text: 'neon' }).map((e) => e.slug)).toEqual(['neon-pulse', 'whole-look']);
    expect(searchPresets(entries, { text: 'title' }).map((e) => e.slug)).toEqual(['minimal-type']);
    expect(searchPresets(entries, { text: 'PULSE' }).map((e) => e.slug)).toEqual(['neon-pulse']);
  });

  it('narrows by scope and module', () => {
    expect(searchPresets(entries, { scope: 'project' }).map((e) => e.slug)).toEqual(['whole-look']);
    expect(searchPresets(entries, { moduleId: 'core.visualizer.bars' }).map((e) => e.slug)).toEqual(['neon-pulse']);
  });

  it('requires every tag, because filters narrow', () => {
    expect(searchPresets(entries, { tags: ['neon'] })).toHaveLength(2);
    expect(searchPresets(entries, { tags: ['neon', 'bars'] }).map((e) => e.slug)).toEqual(['neon-pulse']);
    expect(searchPresets(entries, { tags: ['neon', 'nope'] })).toHaveLength(0);
  });

  it('an empty query returns everything', () => {
    expect(searchPresets(entries, {})).toHaveLength(3);
    expect(searchPresets(entries, { text: '   ' })).toHaveLength(3);
  });

  it('counts tags most-used first', () => {
    expect([...tagCounts(entries)]).toEqual([['neon', 2], ['bars', 1], ['minimal', 1]]);
  });
});

describe('delete messages distinguish the two cases', () => {
  it('says a built-in cannot be deleted, and that an unknown slug does not exist', async () => {
    const builtinRoot = join(root, 'shipped');
    await mkdir(join(builtinRoot, 'layer'), { recursive: true });
    await writeFile(join(builtinRoot, 'layer', 'shipped.json'), stringifyPreset(preset('Shipped')));
    const store = new PresetStore({ root, builtinRoot });

    await expect(store.remove('layer', 'shipped')).rejects.toThrow(/built-in preset and cannot be deleted/);
    await expect(store.remove('layer', 'never-existed')).rejects.toThrow(/no preset "never-existed"/);
  });
});

describe('favourites and thumbnails (S8)', () => {
  it('stars and unstars presets, and a deleted preset stops being a favourite', async () => {
    const store = new PresetStore({ root });
    expect(await store.favourites()).toEqual(new Set());
    const slug = await store.save(preset('Neon Pulse'));
    await store.setFavourite('layer', slug, true);
    expect(await store.favourites()).toEqual(new Set(['layer/neon-pulse']));
    await store.remove('layer', slug);
    expect(await store.favourites()).toEqual(new Set());
  });

  it('a corrupt favourites file is no favourites, not a crash', async () => {
    const store = new PresetStore({ root });
    await writeFile(join(root, 'favourites.json'), '{not json');
    expect(await store.favourites()).toEqual(new Set());
  });

  it('caches thumbnails by key and refuses a key that could name a path', async () => {
    const store = new PresetStore({ root });
    const key = presetThumbnailKey(preset('A'), '1.0');
    expect(await store.readThumbnail(key)).toBeNull();
    await store.writeThumbnail(key, new Uint8Array([1, 2, 3]));
    expect([...(await store.readThumbnail(key))!]).toEqual([1, 2, 3]);
    await expect(store.writeThumbnail('../escape', new Uint8Array([1]))).rejects.toThrow();
    expect(await store.readThumbnail('../escape')).toBeNull();
  });

  it('the thumbnail key follows the look and the engine', () => {
    const a = preset('A');
    expect(presetThumbnailKey(a, '1.0')).toBe(presetThumbnailKey(preset('A'), '1.0'));
    expect(presetThumbnailKey(a, '1.0')).not.toBe(presetThumbnailKey(a, '1.1'));
    expect(presetThumbnailKey(a, '1.0')).not.toBe(presetThumbnailKey({ ...a, values: { glow: 0.1 } } as Preset, '1.0'));
    expect(presetThumbnailKey(a, '1.0')).toMatch(/^[0-9a-f]{32}$/);
  });
});
