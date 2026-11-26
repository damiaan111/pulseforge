// The refined grid (S16): what is stored, when it applies, and what it moves. The tracker itself is
// checked against known beat times at the bottom, when librosa is installed.

import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { analyzeMix } from '../../src/analysis/analyze.ts';
import { AnalysisCache } from '../../src/analysis/cache.ts';
import { analyzeCached } from '../../src/analysis/cached.ts';
import { parseBeatRefinement, refineSections, refinementState, withRefinedGrid, type BeatRefinement } from '../../src/analysis/beat-refinement.ts';
import { cacheOptionsFor, parseProjectAnalysisSettings } from '../../src/analysis/project-settings.ts';
import type { Section } from '../../src/analysis/sections.ts';
import { refineBeats, worthFollowing } from '../../src/ml/beats.ts';
import { createDocument } from '../../src/project/create.ts';
import { setBeatRefinement } from '../../src/project/commands.ts';
import { parseDocument } from '../../src/project/parse.ts';
import { stringifyDocument } from '../../src/project/serialize.ts';
import { PYTHON_EXE, ROOT } from '../../setup/lib/paths.ts';
import { pythonEnv } from '../../setup/lib/env.ts';

const RATE = 48_000;
const HASH = 'a'.repeat(64);
const refinement = (overrides: Partial<BeatRefinement> = {}): BeatRefinement => ({
  audioHash: HASH, tool: 'librosa', bpm: 100, beats: [0.5, 1.1, 1.7, 2.3], confidence: 0.8, sections: [1.7], ...overrides,
});
const section = (startSeconds: number, endSeconds: number): Section => ({ startSeconds, endSeconds, label: 'main', energy: 0.5 });

describe('a stored refinement', () => {
  it('round-trips through a project file, and is absent when there is none', () => {
    const plain = createDocument({ name: 'Song' });
    expect(stringifyDocument(plain)).not.toContain('beatRefinement');
    const refined = setBeatRefinement(refinement()).apply(plain);
    const { document, issues } = parseDocument(JSON.parse(stringifyDocument(refined)));
    expect(issues).toEqual([]);
    expect(document.analysisSettings.beatRefinement).toEqual(refinement());
    expect(setBeatRefinement(null).apply(document).analysisSettings.beatRefinement).toBeNull();
  });

  it('that does not read is reported, and the detected beats stay in use', () => {
    const refined = setBeatRefinement(refinement()).apply(createDocument({ name: 'Song' }));
    const raw = JSON.parse(stringifyDocument(refined)) as { analysisSettings: { beatRefinement: { beats: number[] } } };
    raw.analysisSettings.beatRefinement.beats = [2, 1];
    const { document, issues } = parseDocument(raw);
    expect(document.analysisSettings.beatRefinement).toBeNull();
    expect(issues.map((i) => i.path)).toEqual(['analysisSettings.beatRefinement']);
  });

  it('refuses what it cannot use', () => {
    expect(parseBeatRefinement(null)).toBeNull();
    expect(() => parseBeatRefinement({ ...refinement(), audioHash: 'x' })).toThrow(/audio hash/);
    expect(() => parseBeatRefinement({ ...refinement(), bpm: 0 })).toThrow(/tempo/);
    expect(() => parseBeatRefinement({ ...refinement(), sections: [Number.NaN] })).toThrow(/sections/);
  });

  it('crosses IPC with the rest of the settings, which the cache key does not include', () => {
    const settings = createDocument({ name: 'Song' }).analysisSettings;
    const parsed = parseProjectAnalysisSettings({ ...settings, beatRefinement: refinement() });
    expect(parsed.beatRefinement).toEqual(refinement());
    expect(cacheOptionsFor(parsed).beatRefinement).toEqual(refinement());
  });
});

describe('when it applies', () => {
  it('needs the same audio, and no tempo override', () => {
    expect(refinementState(null, HASH, null)).toBe('none');
    expect(refinementState(refinement(), HASH, null)).toBe('applied');
    expect(refinementState(refinement(), 'b'.repeat(64), null)).toBe('stale');
    expect(refinementState(refinement(), HASH, 128)).toBe('overridden');
  });
});

describe('sections', () => {
  const sections = [section(0, 20), section(20, 50), section(50, 80)];
  const beats = Array.from({ length: 200 }, (_, i) => i * 0.5 + 0.1);

  it('moves a boundary to a structural change nearby, then onto a beat', () => {
    const refined = refineSections(sections, [22.2, 70], beats);
    expect(refined[1]?.startSeconds).toBeCloseTo(22.1, 5);
    expect(refined[0]?.endSeconds).toBeCloseTo(22.1, 5);
    // No structural change near 50: only onto the beat.
    expect(refined[2]?.startSeconds).toBeCloseTo(50.1, 5);
  });

  it('keeps the ends and the labels', () => {
    const refined = refineSections(sections, [22.2], beats);
    expect(refined[0]?.startSeconds).toBe(0);
    expect(refined[2]?.endSeconds).toBe(80);
    expect(refined.map((s) => s.label)).toEqual(['main', 'main', 'main']);
  });

  it('never crushes a section', () => {
    const tight = [section(0, 3), section(3, 6), section(6, 9)];
    const refined = refineSections(tight, [7.5], [3, 6, 7.5]);
    expect(refined.map((s) => s.startSeconds)).toEqual([0, 3, 6]);
  });
});

describe('the analysis it produces', () => {
  it('replaces the grid and the beat track, for the mix only', () => {
    const pcm = new Float32Array(RATE * 4);
    for (let i = 0; i < pcm.length; i += RATE / 2) pcm[i] = 1;
    const { analysis } = analyzeMix(pcm);
    const { analysis: refined, beatGrid } = withRefinedGrid(analysis, refinement());
    expect(beatGrid.beats).toEqual(refinement().beats);
    expect(refined.beatGrid).toEqual(beatGrid);
    const before = analysis.sources.get('mix')?.features.get('beat')?.data as Float32Array;
    const after = refined.sources.get('mix')?.features.get('beat')?.data as Float32Array;
    expect(after.length).toBe(before.length);
    expect([...after]).not.toEqual([...before]);
    expect(refined.sources.get('mix')?.features.get('rms')).toBe(analysis.sources.get('mix')?.features.get('rms'));
  });

  describe('through the cache', () => {
    let root: string;
    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), 'pulseforge-beats-'));
    });
    afterAll(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it('lays over a hit without touching the cached entry', async () => {
      const cache = new AnalysisCache({ root });
      const pcm = new Float32Array(RATE * 6);
      for (let i = 0; i < pcm.length; i += RATE / 2) pcm[i] = 1;
      const first = await analyzeCached(pcm, cache);
      expect(first.beatRefinement).toBe('none');

      const refined = await analyzeCached(pcm, cache, { beatRefinement: refinement({ audioHash: first.audioHash }) });
      expect(refined.fromCache).toBe(true);
      expect(refined.settingsHash).toBe(first.settingsHash);
      expect(refined.beatRefinement).toBe('applied');
      expect(refined.beatGrid?.beats).toEqual(refinement().beats);

      const again = await analyzeCached(pcm, cache);
      expect(again.beatGrid?.beats).toEqual(first.beatGrid?.beats);

      const stale = await analyzeCached(pcm, cache, { beatRefinement: refinement() });
      expect(stale.beatRefinement).toBe('stale');
      expect(stale.beatGrid?.beats).toEqual(first.beatGrid?.beats);
    });
  });
});

describe('worthFollowing', () => {
  it('takes a drum stem with something in it, and not one that is nearly silent', () => {
    const mix = new Float32Array(32_000).fill(0.5);
    expect(worthFollowing(new Float32Array(32_000).fill(0.3), mix)).toBe(true);
    expect(worthFollowing(new Float32Array(32_000).fill(0.05), mix)).toBe(false);
  });
});

/** Kicks on the beat, hats between them, on a tempo that wanders: the case a straight grid cannot fit. */
function rubato(seconds: number): { pcm: Float32Array; beats: number[] } {
  const beats: number[] = [];
  for (let t = 0; t < seconds; t += 60 / (100 + 12 * Math.sin((2 * Math.PI * t) / 16))) beats.push(t);
  const pcm = new Float32Array(seconds * RATE);
  const put = (at: number, length: number, sample: (t: number) => number) => {
    const start = Math.round(at * RATE);
    for (let i = 0; i < length && start + i < pcm.length; i += 1) pcm[start + i] = (pcm[start + i] as number) + sample(i / RATE);
  };
  let noise = 1;
  const hiss = () => {
    noise = (noise * 16807) % 2147483647;
    return noise / 1073741823.5 - 1;
  };
  beats.forEach((beat, i) => {
    put(beat, 6000, (t) => Math.sin(2 * Math.PI * (55 + 120 * Math.exp(-t * 40)) * t) * Math.exp(-t * 25) * 0.7);
    const next = beats[i + 1];
    if (next !== undefined) put((beat + next) / 2, 1500, (t) => hiss() * Math.exp(-t * 200) * 0.2);
  });
  return { pcm, beats };
}

function fMeasure(found: readonly number[], truth: readonly number[], window = 0.07): number {
  const last = truth[truth.length - 1] as number;
  const wanted = truth.filter((t) => t > 5 && t < last - 2);
  const kept = found.filter((b) => b > 5 && b < last + 1);
  if (kept.length === 0) return 0;
  const near = (x: number, list: readonly number[]) => list.some((y) => Math.abs(x - y) <= window);
  const recall = wanted.filter((t) => near(t, kept)).length / wanted.length;
  const precision = kept.filter((b) => near(b, wanted)).length / kept.length;
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

const hasLibrosa = spawnSync(PYTHON_EXE, ['-c', 'import importlib.util as u; raise SystemExit(0 if u.find_spec("librosa") else 1)'], { env: pythonEnv() }).status === 0;

describe.skipIf(!hasLibrosa)('librosa on a known answer', () => {
  it('follows a tempo the built-in grid cannot, within a beat tolerance, and on the beat rather than between', async () => {
    const { pcm, beats } = rubato(45);
    const work = await mkdtemp(join(tmpdir(), 'pulseforge-beats-run-'));
    try {
      const refined = await refineBeats({ pythonExe: PYTHON_EXE, packageDir: join(ROOT, 'python'), env: pythonEnv(), pcm, audioHash: HASH, workDir: work });
      const builtIn = fMeasure(analyzeMix(pcm).beatGrid.beats, beats);
      const librosa = fMeasure(refined.beats, beats);
      expect(librosa).toBeGreaterThan(0.95);
      expect(librosa).toBeGreaterThan(builtIn + 0.3);
      expect(refined.audioHash).toBe(HASH);
      expect(refined.tool).toBe('librosa');
      // Tight too: within 15 ms of true, once the detector's lag is taken off.
      const inner = refined.beats.filter((b) => b > 5 && b < 40).map((b) => Math.min(...beats.map((t) => Math.abs(t - b))));
      expect([...inner].sort((a, b) => a - b)[Math.floor(inner.length / 2)]).toBeLessThan(0.015);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }, 120_000);

  it('says so when there is no pulse to find', async () => {
    const work = await mkdtemp(join(tmpdir(), 'pulseforge-beats-run-'));
    try {
      await expect(refineBeats({ pythonExe: PYTHON_EXE, packageDir: join(ROOT, 'python'), env: pythonEnv(), pcm: new Float32Array(RATE * 8), audioHash: HASH, workDir: work }))
        .rejects.toThrow(/No steady pulse/);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }, 60_000);
});
