// User settings on disk (data-formats §6): defaults, defensive reading, unknown keys kept, a newer
// file never written over.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, SettingsStore, validateSettingsPatch } from '../../src/shell/settings-store.ts';

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pulseforge-settings-'));
  path = join(dir, 'nested', 'settings.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('SettingsStore', () => {
  it('gives defaults when there is no file, and saves a patch', async () => {
    const store = new SettingsStore(path);
    expect((await store.read()).settings).toEqual(DEFAULT_SETTINGS);
    await store.update({ tapLatencyMs: 112 });
    expect((await store.read()).settings.tapLatencyMs).toBe(112);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, ...DEFAULT_SETTINGS, tapLatencyMs: 112 });
  });

  it('reports a damaged file and a nonsense value, using defaults for them', async () => {
    const store = new SettingsStore(path);
    await store.update({});
    await writeFile(path, '{ nope');
    expect((await store.read()).problems).toHaveLength(1);
    await writeFile(path, JSON.stringify({ version: 1, tapLatencyMs: 'fast' }));
    const read = await store.read();
    expect(read.settings.tapLatencyMs).toBe(null);
    expect(read.problems[0]).toContain('tapLatencyMs');
  });

  it('keeps keys it does not know through a save', async () => {
    const store = new SettingsStore(path);
    await store.update({});
    await writeFile(path, JSON.stringify({ version: 1, futureThing: 'kept', tapLatencyMs: 90 }));
    await store.update({ tapLatencyMs: 95 });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ futureThing: 'kept', version: 1, ...DEFAULT_SETTINGS, tapLatencyMs: 95 });
  });

  it('reads a newer file but refuses to write over it', async () => {
    const store = new SettingsStore(path);
    await store.update({});
    await writeFile(path, JSON.stringify({ version: 9, tapLatencyMs: 80 }));
    const read = await store.read();
    expect(read).toMatchObject({ readOnly: true, settings: { tapLatencyMs: 80 } });
    await expect(store.update({ tapLatencyMs: 1 })).rejects.toThrow(/newer version/);
    expect(JSON.parse(await readFile(path, 'utf8')).version).toBe(9);
  });
});

describe("the settings screen's fields (M36)", () => {
  it('reads each field, falling back to its default and saying so when a value is out of range', async () => {
    const store = new SettingsStore(path);
    await store.update({});
    await writeFile(path, JSON.stringify({ version: 1, autosaveMinutes: 5, theme: 'light', cacheCeilingGb: -3, previewScale: 0.3 }));
    const read = await store.read();
    expect(read.settings).toMatchObject({ autosaveMinutes: 5, theme: 'light', cacheCeilingGb: 20, previewScale: 1 });
    expect(read.problems.map((p) => p.split(' ')[0])).toEqual(['previewScale', 'cacheCeilingGb']);
  });

  it('refuses a bad patch with the reason, rather than defaulting it', () => {
    expect(validateSettingsPatch({ autosaveMinutes: 10, cacheRoot: null })).toEqual({ autosaveMinutes: 10, cacheRoot: null });
    expect(() => validateSettingsPatch({ autosaveMinutes: 0 })).toThrow(/autosaveMinutes must be a number from 1 to 30/);
    expect(() => validateSettingsPatch({ cacheRoot: 'relative/folder' })).toThrow(/absolute/);
    expect(() => validateSettingsPatch({ nonsense: 1 })).toThrow(/not a setting/);
    expect(() => validateSettingsPatch({ stemModel: '../escape' })).toThrow(/model name/);
  });
});
