import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ANALYSIS_RATE, type SourceAnalysis } from '../../src/engine/core/analysis.ts';
import {
  AnalysisCache,
  analysisKeyInputs,
  hashAnalysisSettings,
  hashPcm,
  type CacheMeta,
} from '../../src/analysis/cache.ts';
import { DEFAULT_SPECTRUM_SETTINGS } from '../../src/analysis/spectrum.ts';
import { analyzeCached } from '../../src/analysis/cached.ts';

let root: string;
let clockStep = 0;

function makeCache(): AnalysisCache {
  clockStep = 0;
  // A monotonic, byte-stable clock: real timestamps would make meta.json unassertable.
  return new AnalysisCache({ root, now: () => `2026-09-15T00:00:${String(clockStep++).padStart(2, '0')}.000Z` });
}

function fakeSource(seed = 1): SourceAnalysis {
  const track = (length: number, scale: number) => ({
    rate: ANALYSIS_RATE,
    channels: 1,
    data: Float32Array.from({ length }, (_, i) => ((i * seed) % 17) / 17 / scale),
  });
  return {
    spectrum: { rate: ANALYSIS_RATE, channels: 4, data: Float32Array.from({ length: 4 * 8 }, (_, i) => i / 32) },
    bands: new Map([['bass', track(8, 1)]]),
    features: new Map([
      ['rms', track(8, 1)],
      ['onset', track(8, 2)],
    ]),
  };
}

const grid = { bpm: 120, confidence: 0.8, beats: [0.5, 1, 1.5] };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pulseforge-cache-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('cache keys', () => {
  it('hashes the decoded samples, not the file', () => {
    const a = Float32Array.from([0, 0.5, -0.5, 1]);
    const b = Float32Array.from([0, 0.5, -0.5, 1]);
    expect(hashPcm(a)).toBe(hashPcm(b));
    expect(hashPcm(a)).not.toBe(hashPcm(Float32Array.from([0, 0.5, -0.5, 0.999])));
  });

  it('ignores band names but not band edges', () => {
    const renamed = {
      ...DEFAULT_SPECTRUM_SETTINGS,
      bands: [{ name: 'low', minHz: 40, maxHz: 160 }],
    };
    const moved = {
      ...DEFAULT_SPECTRUM_SETTINGS,
      bands: [{ name: 'bass', minHz: 50, maxHz: 160 }],
    };
    // A rename must not throw away a valid cache; moving an edge must (data-formats §4.3).
    expect(hashAnalysisSettings({ settings: renamed })).toBe(hashAnalysisSettings({ settings: DEFAULT_SPECTRUM_SETTINGS }));
    expect(hashAnalysisSettings({ settings: moved })).not.toBe(hashAnalysisSettings({ settings: DEFAULT_SPECTRUM_SETTINGS }));
  });

  it('separates every other input that changes the numbers', () => {
    const base = hashAnalysisSettings({});
    expect(hashAnalysisSettings({ onsetSensitivity: 0.7 })).not.toBe(base);
    expect(hashAnalysisSettings({ bpmOverride: 128 })).not.toBe(base);
    expect(hashAnalysisSettings({ stemModel: 'htdemucs_ft' })).not.toBe(base);
    expect(hashAnalysisSettings({ settings: { ...DEFAULT_SPECTRUM_SETTINGS, fftSize: 4096 } })).not.toBe(base);
  });

  it('carries the analysis version, so a fixed detector invalidates old caches', () => {
    // The trap data-formats §4.3 names: without this, a bug fix keeps serving the old numbers.
    expect(analysisKeyInputs({})['analysisVersion']).toBeTypeOf('number');
  });
});

describe('AnalysisCache', () => {
  it('misses cleanly on an empty root', async () => {
    const cache = makeCache();
    expect(await cache.readMeta('a', 'b')).toBeNull();
    expect(await cache.readSource('a', 'b', 'mix')).toBeNull();
    expect(await cache.readSet('a', 'b')).toBeNull();
    expect(await cache.readiness('a', 'b')).toEqual({});
  });

  it('round-trips a source through the tree', async () => {
    const cache = makeCache();
    const source = fakeSource();
    await cache.writeSource('audio1', 'set1', 'mix', source, { durationSeconds: 12.5, beatGrid: grid });

    const read = await cache.readSource('audio1', 'set1', 'mix');
    expect(read).not.toBeNull();
    expect([...read!.bands.keys()]).toEqual(['bass']);
    expect(read!.features.get('rms')!.data).toEqual(source.features.get('rms')!.data);

    const set = await cache.readSet('audio1', 'set1');
    expect([...set!.sources.keys()]).toEqual(['mix']);
    expect(set!.beatGrid).toEqual(grid);
  });

  it('writes the documented tree layout', async () => {
    const cache = makeCache();
    await cache.writeSource('audio1', 'set1', 'mix', fakeSource(), { beatGrid: grid });
    const dir = cache.entryPath('audio1', 'set1');
    expect(dir).toBe(join(root, 'analysis', 'audio1', 'set1'));
    await expect(readFile(join(dir, 'mix.bin'))).resolves.toBeInstanceOf(Buffer);
    await expect(readFile(join(dir, "beatgrid.json"), "utf8")).resolves.toContain("\"bpm\": 120");
    const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as CacheMeta;
    expect(meta.sources['mix']!.state).toBe('ready');
    expect(meta.keyInputs['fftSize']).toBe(DEFAULT_SPECTRUM_SETTINGS.fftSize);
  });

  it('reports readiness per source while stems are still running', async () => {
    const cache = makeCache();
    await cache.writeSource('audio1', 'set1', 'mix', fakeSource(), { durationSeconds: 10 });
    await cache.markSource('audio1', 'set1', 'drums', 'pending');

    expect(await cache.readiness('audio1', 'set1')).toEqual({
      mix: { state: 'ready', bytes: expect.any(Number) },
      drums: { state: 'pending' },
    });

    // A pending source reads as absent, never as a track of zeros (data-formats §4.4).
    expect(await cache.readSource('audio1', 'set1', 'drums')).toBeNull();
    const set = await cache.readSet('audio1', 'set1');
    expect([...set!.sources.keys()]).toEqual(['mix']);
  });

  it('records why a source failed', async () => {
    const cache = makeCache();
    await cache.writeSource('audio1', 'set1', 'mix', fakeSource());
    await cache.markSource('audio1', 'set1', 'vocals', 'failed', 'demucs exited with code 1');
    const entry = (await cache.readiness('audio1', 'set1'))['vocals'];
    expect(entry).toEqual({ state: 'failed', error: 'demucs exited with code 1' });
  });

  it('merges sources written one at a time', async () => {
    const cache = makeCache();
    await cache.writeSource('audio1', 'set1', 'mix', fakeSource(1), { beatGrid: grid });
    await cache.writeSource('audio1', 'set1', 'drums', fakeSource(2));
    await cache.writeSource('audio1', 'set1', 'bass', fakeSource(3));

    const set = await cache.readSet('audio1', 'set1');
    expect([...set!.sources.keys()].sort()).toEqual(['bass', 'drums', 'mix']);
    // The grid written with the first source survives later writes.
    expect(set!.beatGrid).toEqual(grid);
    const meta = await cache.readMeta('audio1', 'set1');
    expect(meta!.createdAt).toBe('2026-09-15T00:00:00.000Z');
    expect(meta!.updatedAt).not.toBe(meta!.createdAt);
  });

  it('treats a corrupt entry as a miss rather than an error', async () => {
    const cache = makeCache();
    await cache.writeSource('audio1', 'set1', 'mix', fakeSource());
    await writeFile(join(cache.entryPath('audio1', 'set1'), 'meta.json'), '{ not json');
    expect(await cache.readMeta('audio1', 'set1')).toBeNull();
    expect(await cache.readSet('audio1', 'set1')).toBeNull();
  });

  it('refuses an entry written by another analysis version', async () => {
    const cache = makeCache();
    await cache.writeSource('audio1', 'set1', 'mix', fakeSource());
    const path = join(cache.entryPath('audio1', 'set1'), 'meta.json');
    const meta = JSON.parse(await readFile(path, 'utf8')) as CacheMeta;
    await writeFile(path, JSON.stringify({ ...meta, analysisVersion: meta.analysisVersion + 1 }));
    // Stale numbers surviving a bug fix is the failure this guards against.
    expect(await cache.readMeta('audio1', 'set1')).toBeNull();
    expect(await cache.readSource('audio1', 'set1', 'mix')).toBeNull();
  });

  it('lists entries biggest-first with their sizes', async () => {
    const cache = makeCache();
    await cache.writeSource('audio1', 'set1', 'mix', fakeSource());
    await cache.writeSource('audio2', 'set1', 'mix', fakeSource());
    await cache.writeSource('audio2', 'set1', 'drums', fakeSource());

    const entries = await cache.list();
    expect(entries).toHaveLength(2);
    expect(entries[0]!.audioHash).toBe('audio2'); // two sources, so larger
    expect(entries[0]!.bytes).toBeGreaterThan(entries[1]!.bytes);
    expect(await cache.totalBytes()).toBe(entries[0]!.bytes + entries[1]!.bytes);
  });

  it('prunes least-recently-updated entries down to a ceiling', async () => {
    const cache = makeCache();
    await cache.writeSource('old', 'set1', 'mix', fakeSource());
    await cache.writeSource('new', 'set1', 'mix', fakeSource());

    const total = await cache.totalBytes();
    const removed = await cache.prune(Math.floor(total / 2));
    expect(removed.map((entry) => entry.audioHash)).toEqual(['old']);
    expect(await cache.readSet('old', 'set1')).toBeNull();
    expect(await cache.readSet('new', 'set1')).not.toBeNull();
  });

  it('prune keeps everything when already under the ceiling', async () => {
    const cache = makeCache();
    await cache.writeSource('audio1', 'set1', 'mix', fakeSource());
    expect(await cache.prune(10 ** 9)).toEqual([]);
    expect(await cache.readSet('audio1', 'set1')).not.toBeNull();
  });

  it('removing the last entry removes its audio directory too', async () => {
    const cache = makeCache();
    await cache.writeSource('audio1', 'set1', 'mix', fakeSource());
    await cache.remove('audio1', 'set1');
    expect(await cache.list()).toEqual([]);
  });

  it('clears the whole tree, which only ever costs time', async () => {
    const cache = makeCache();
    await cache.writeSource('audio1', 'set1', 'mix', fakeSource());
    await cache.clear();
    expect(await cache.list()).toEqual([]);
    expect(await cache.totalBytes()).toBe(0);
  });
});

describe('analyzeCached', () => {
  /** A second of noise with a click every 0.25 s: enough for onsets and a grid to exist. */
  function pcm(seconds = 2): Float32Array {
    const data = new Float32Array(48_000 * seconds);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.sin(i / 20) * 0.05;
    for (let click = 0; click < seconds * 4; click += 1) {
      const at = Math.floor(click * 0.25 * 48_000);
      for (let i = 0; i < 400; i += 1) data[at + i] = (1 - i / 400) * (i % 2 === 0 ? 1 : -1);
    }
    return data;
  }

  it('computes on a miss and reads back on a hit', async () => {
    const cache = makeCache();
    const audio = pcm();

    const first = await analyzeCached(audio, cache);
    expect(first.fromCache).toBe(false);

    const second = await analyzeCached(audio, cache);
    expect(second.fromCache).toBe(true);
    expect(second.audioHash).toBe(first.audioHash);
    expect(second.settingsHash).toBe(first.settingsHash);

    // The numbers a render reacts to must survive the round trip unchanged.
    const a = first.analysis.sources.get('mix')!;
    const b = second.analysis.sources.get('mix')!;
    for (const name of a.features.keys()) {
      expect(b.features.get(name)!.data).toEqual(a.features.get(name)!.data);
    }
    expect(b.spectrum.data).toEqual(a.spectrum.data);
    expect(second.beatGrid).toEqual(first.beatGrid);
    expect(second.onsetTimes).toEqual(first.onsetTimes);
  });

  it('keeps the onset times a hit would otherwise lose', async () => {
    const cache = makeCache();
    const audio = pcm();
    const first = await analyzeCached(audio, cache);
    expect(first.onsetTimes.length).toBeGreaterThan(0);
    expect((await analyzeCached(audio, cache)).onsetTimes).toEqual(first.onsetTimes);
  });

  it('different settings are a different entry', async () => {
    const cache = makeCache();
    const audio = pcm();
    await analyzeCached(audio, cache);
    const other = await analyzeCached(audio, cache, { onsetSensitivity: 0.9 });
    expect(other.fromCache).toBe(false);
    expect(await cache.list()).toHaveLength(2);
  });

  it('force recomputes without changing the key', async () => {
    const cache = makeCache();
    const audio = pcm();
    const first = await analyzeCached(audio, cache);
    const forced = await analyzeCached(audio, cache, { force: true });
    expect(forced.fromCache).toBe(false);
    expect(forced.settingsHash).toBe(first.settingsHash);
    expect(await cache.list()).toHaveLength(1);
  });

  it('a cache that cannot be written still analyses', async () => {
    // Read-only or full disk: speed is lost, correctness is not.
    const broken = new AnalysisCache({ root: join(root, 'nope') });
    broken.writeSource = async () => {
      throw new Error('disk full');
    };
    const result = await analyzeCached(pcm(), broken);
    expect(result.fromCache).toBe(false);
    expect(result.analysis.sources.get('mix')).toBeDefined();
  });
});
