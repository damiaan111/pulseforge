// The cache screen's model (M33, PROJECT.md §8.14): inventory by category and track, named by the
// usage index; clear, keep-the-last-N and the LRU ceiling, never deleting what is protected or
// anything outside the cache root.

import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CacheStore } from '../../src/cache/cache-store.ts';

let root: string;
let clock: number;

async function file(path: string, bytes: number): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, new Uint8Array(bytes));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pf-cache-'));
  clock = 1_000;
  // Two tracks (analysis + stems for A, analysis only for B), a video, thumbnails, scratch, and an
  // unknown folder that must be listed, not ignored.
  await file(join(root, 'analysis', 'aaaa', 's1', 'mix.bin'), 1000);
  await file(join(root, 'stems', 'aaaa', 'htdemucs', 'drums.flac'), 5000);
  await file(join(root, 'analysis', 'bbbb', 's1', 'mix.bin'), 2000);
  await file(join(root, 'video', 'vvvv', '30-1-640', '000001.rgba'), 3000);
  await file(join(root, 'preset-thumbnails', 'x.png'), 100);
  await file(join(root, 'scratch', 'tmp.wav'), 50);
  await file(join(root, 'contact-sheet-analysis', 'old.bin'), 70);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const store = () => new CacheStore({ root, now: () => clock });

describe('the cache inventory', () => {
  it('groups a track\'s analysis and stems, names it from the usage index, and lists everything biggest first', async () => {
    await store().touch('track:aaaa', 'Neon Dreams.wav');
    const inv = await store().inventory();
    expect(inv.units.map((u) => [u.id, u.bytes])).toEqual([
      ['track:aaaa', 6000], ['video:vvvv', 3000], ['track:bbbb', 2000], ['thumbnails', 100], ['other:contact-sheet-analysis', 70], ['scratch', 50],
    ]);
    const a = inv.units.find((u) => u.id === 'track:aaaa')!;
    expect(a.label).toBe('Neon Dreams.wav');
    expect(a.parts).toEqual({ analysis: 1000, stems: 5000 });
    expect(inv.units.find((u) => u.id === 'track:bbbb')!.label).toMatch(/^Track bbbb/);
    expect(inv.byCategory).toEqual({ track: 8000, video: 3000, thumbnails: 100, scratch: 50, other: 70 });
    expect(inv.totalBytes).toBe(11220);
    expect(inv.freeBytes).toBeGreaterThan(0);
  });
});

describe('getting the space back', () => {
  it('clears a category, skipping what the open project uses', async () => {
    const result = await store().clear('track', new Set(['track:aaaa']));
    expect(result.removed.map((u) => u.id)).toEqual(['track:bbbb']);
    expect(result.skipped).toEqual(['track:aaaa']);
    expect(await readdir(join(root, 'analysis'))).toEqual(['aaaa']);
  });

  it('keeps the N most recently used tracks', async () => {
    await store().touch('track:bbbb', 'B');
    clock = 2_000;
    await store().touch('track:aaaa', 'A');
    const result = await store().keepRecentTracks(1);
    expect(result.removed.map((u) => u.id)).toEqual(['track:bbbb']);
  });

  it('evicts least recently used first until under the ceiling, never the protected', async () => {
    await store().touch('video:vvvv', 'clip.mp4');
    clock = 2_000;
    await store().touch('track:bbbb', 'B');
    clock = 3_000;
    await store().touch('track:aaaa', 'A');
    // Unindexed units (thumbnails, scratch, other) count as used when their files were written —
    // now, in the test — so the old video goes first, then B; A is protected.
    const result = await store().enforceCeiling(6500, new Set(['track:aaaa']));
    expect(result.removed.map((u) => u.id)).toEqual(['video:vvvv', 'track:bbbb']);
    expect(result.overBy).toBe(0);
  });

  it('refuses to delete outside the root', async () => {
    const s = store();
    expect(() => (s as unknown as { inside(p: string): string }).inside(join(root, '..', 'elsewhere'))).toThrow(/not inside the cache folder/);
    expect(() => (s as unknown as { inside(p: string): string }).inside(root)).toThrow(/not inside/);
  });

  it('a damaged usage index is ignored, not fatal', async () => {
    await writeFile(join(root, 'usage.json'), '{ nope');
    expect((await store().inventory()).units.length).toBe(6);
  });
});
