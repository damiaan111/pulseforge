// Key detection on synthetic harmony: known chords in a known key, with harmonics as an instrument
// has them, and the things that have no key.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { AnalysisCache } from '../../src/analysis/cache.ts';
import { analyzeCached } from '../../src/analysis/cached.ts';
import { chromagram, detectKey, keyName, keyWheelPosition } from '../../src/analysis/key.ts';

const RATE = 48_000;

/** Four bars per chord; each chord is MIDI notes, with decaying harmonics. */
function progression(chords: readonly (readonly number[])[], secondsPerChord = 2, repeats = 3): Float32Array {
  const samples = Math.floor(chords.length * secondsPerChord * repeats * RATE);
  const pcm = new Float32Array(samples);
  for (let i = 0; i < samples; i += 1) {
    const t = i / RATE;
    const chord = chords[Math.floor(t / secondsPerChord) % chords.length] as readonly number[];
    let v = 0;
    for (const midi of chord) {
      const hz = 440 * 2 ** ((midi - 69) / 12);
      for (let h = 1; h <= 4; h += 1) v += Math.sin(2 * Math.PI * hz * h * t) / h;
    }
    pcm[i] = v * 0.08;
  }
  return pcm;
}

const transpose = (chords: readonly (readonly number[])[], by: number) => chords.map((c) => c.map((n) => n + by));
// I IV V I, with the scale's own notes.
const C_MAJOR = [[48, 60, 64, 67], [53, 60, 65, 69], [55, 59, 62, 67], [48, 60, 64, 67]];
// i iv v i in natural minor.
const A_MINOR = [[45, 57, 60, 64], [50, 57, 62, 65], [52, 55, 59, 64], [45, 57, 60, 64]];

describe('detectKey', () => {
  it('finds C major and A minor from their chords', () => {
    expect(detectKey(progression(C_MAJOR))).toMatchObject({ tonic: 0, mode: 'major' });
    expect(detectKey(progression(A_MINOR))).toMatchObject({ tonic: 9, mode: 'minor' });
  });

  it('follows a transposition', () => {
    for (const by of [2, 5, 7, -3]) {
      expect(detectKey(progression(transpose(C_MAJOR, by))), `${by}`).toMatchObject({ tonic: (by + 12) % 12, mode: 'major' });
    }
  });

  it('gives no key for silence, for noise-free clicks with no pitch, or for audio too short to read', () => {
    expect(detectKey(new Float32Array(RATE * 5))).toBeNull();
    expect(detectKey(new Float32Array(100))).toBeNull();
    const clicks = new Float32Array(RATE * 10);
    for (let i = 0; i < clicks.length; i += RATE / 2) clicks[i] = 1;
    expect(detectKey(clicks)).toBeNull();
  });

  it('is deterministic', () => {
    const pcm = progression(A_MINOR, 1, 2);
    expect([...chromagram(pcm, RATE)]).toEqual([...chromagram(pcm, RATE)]);
    expect(detectKey(pcm)).toEqual(detectKey(pcm));
  });

  it('reads a bounded number of frames, so a long track costs no more than a short one', () => {
    const long = progression(C_MAJOR, 15, 2);
    const started = process.hrtime.bigint();
    expect(detectKey(long)).toMatchObject({ tonic: 0, mode: 'major' });
    expect(Number(process.hrtime.bigint() - started) / 1e9).toBeLessThan(10);
  });
});

describe('the key wheel', () => {
  it('names keys and seats a minor key on its relative major', () => {
    expect(keyName({ tonic: 9, mode: 'minor', confidence: 1 })).toBe('A minor');
    expect(keyWheelPosition({ tonic: 9, mode: 'minor', confidence: 1 })).toBe(keyWheelPosition({ tonic: 0, mode: 'major', confidence: 1 }));
  });

  it('puts a fifth one step round the wheel', () => {
    const c = keyWheelPosition({ tonic: 0, mode: 'major', confidence: 1 });
    const g = keyWheelPosition({ tonic: 7, mode: 'major', confidence: 1 });
    expect(g - c).toBeCloseTo(1 / 12);
  });
});

describe('the key in the analysis cache', () => {
  const root = mkdtempSync(join(tmpdir(), 'pf-key-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('is written once, read back on a hit, and rebuilt for an entry older than it', async () => {
    const cache = new AnalysisCache({ root });
    const pcm = progression(C_MAJOR, 2, 2);
    const first = await analyzeCached(pcm, cache);
    expect(first.fromCache).toBe(false);
    expect(first.key).toMatchObject({ tonic: 0, mode: 'major' });
    const file = join(cache.entryPath(first.audioHash, first.settingsHash), 'key.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ formatVersion: 1, key: { tonic: 0 } });

    const hit = await analyzeCached(pcm, cache);
    expect(hit.fromCache).toBe(true);
    expect(hit.key).toEqual(first.key);

    // An entry from before keys existed: a hit all the same, with the key filled in.
    rmSync(file);
    const old = await analyzeCached(pcm, cache);
    expect(old.fromCache).toBe(true);
    expect(old.key).toEqual(first.key);
    expect(JSON.parse(readFileSync(file, 'utf8')).key.tonic).toBe(0);
  }, 60_000);
});
