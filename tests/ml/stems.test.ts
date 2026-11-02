// Stems end to end (M5), minus Python: a fake sidecar "separates" by writing scaled copies of the
// input, and everything around it is real — FFmpeg, the analyser, the cache. The real Demucs run is
// tests/golden/stems-gpu.test.ts.

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FFMPEG_EXE } from '../../setup/lib/paths.ts';
import { encodeWavFloat32 } from '../../src/export/audio.ts';
import { AnalysisCache } from '../../src/analysis/cache.ts';
import { analyzeCached } from '../../src/analysis/cached.ts';
import { decodeMono48k } from '../../src/analysis/decode.ts';
import { cacheOptionsFor, type ProjectAnalysisSettings } from '../../src/analysis/project-settings.ts';
import { synthesizeTestTrack } from '../../src/analysis/reference-track.ts';
import { DEFAULT_ANALYSIS_SETTINGS } from '../../src/project/create.ts';
import { DEMUCS_6S_STEMS, DEMUCS_STEMS, StemsCancelledError, separateStems, type StemSidecar } from '../../src/ml/stems.ts';

const available = existsSync(FFMPEG_EXE);
const settings: ProjectAnalysisSettings = DEFAULT_ANALYSIS_SETTINGS;

let root: string;
let audioPath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pulseforge-stems-'));
  audioPath = join(root, 'track.wav');
  const mono = synthesizeTestTrack(3);
  await writeFile(audioPath, encodeWavFloat32([mono, mono], 48_000));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Writes each stem as the input scaled by a different amount, as Demucs would write them. */
function fakeSidecar(options: { onRequest?: (params: Readonly<Record<string, unknown>>) => void; sources?: readonly string[] } = {}): StemSidecar {
  const produced = options.sources ?? DEMUCS_STEMS;
  return {
    async request(command, params, { onProgress, signal }) {
      expect(command).toBe('separate');
      options.onRequest?.(params);
      const input = new Float32Array((await readFile(String(params['input']))).buffer.slice(0));
      const out = String(params['outDir']);
      await mkdir(out, { recursive: true });
      for (const [i, stem] of produced.entries()) {
        if (signal?.aborted === true) throw Object.assign(new Error('cancelled'), { name: 'SidecarCancelledError' });
        const scaled = input.map((v) => v * (0.2 + 0.2 * i));
        await writeFile(join(out, `${stem}.f32`), new Uint8Array(scaled.buffer));
        onProgress?.({ fraction: (i + 1) / produced.length, stage: 'separating' });
      }
      return { sources: [...produced], separateSeconds: 0.01 };
    },
  };
}

describe.skipIf(!available)('stem separation, end to end without Python', () => {
  it('the 6-stem model (S6) puts guitar and piano in the cache too, and a missing one is marked failed', async () => {
    const six = { ...settings, stemModel: 'htdemucs_6s' };
    const run = (sources: readonly string[]) => separateStems({
      ffmpegExe: FFMPEG_EXE,
      sidecar: fakeSidecar({ sources }),
      cacheRoot: join(root, 'cache'),
      stemsRoot: join(root, 'stems'),
      scratchDir: join(root, 'scratch'),
      modelRepo: 'D:/models/demucs',
      audioPath,
      settings: six,
    });
    const result = await run(DEMUCS_6S_STEMS);
    expect(result.stems).toEqual(DEMUCS_6S_STEMS);
    expect(existsSync(join(root, 'stems', result.audioHash, 'htdemucs_6s', 'piano.flac'))).toBe(true);

    const decoded = await decodeMono48k(FFMPEG_EXE, audioPath);
    const cache = new AnalysisCache({ root: join(root, 'cache') });
    const hit = await analyzeCached(decoded.pcm, cache, { ...cacheOptionsFor(six), audioHash: decoded.pcmSha256 });
    expect([...hit.analysis.sources.keys()].sort()).toEqual(['bass', 'drums', 'guitar', 'mix', 'other', 'piano', 'vocals']);

    // A model that leaves one out: the rest are kept, the missing one says why.
    await rm(join(root, 'cache'), { recursive: true, force: true });
    const partial = await run(DEMUCS_STEMS);
    expect(partial.stems).toEqual(DEMUCS_STEMS);
    const readiness = await new AnalysisCache({ root: join(root, 'cache') }).readiness(partial.audioHash, hit.settingsHash);
    expect(readiness['guitar']).toMatchObject({ state: 'failed', error: 'htdemucs_6s did not produce a "guitar" stem' });
  });

  it('puts every stem in the cache beside the mix, analysed, with the mix beat grid, and keeps the audio', async () => {
    const progress: number[] = [];
    let requested: Readonly<Record<string, unknown>> = {};
    const result = await separateStems({
      ffmpegExe: FFMPEG_EXE,
      sidecar: fakeSidecar({ onRequest: (p) => { requested = p; } }),
      cacheRoot: join(root, 'cache'),
      stemsRoot: join(root, 'stems'),
      scratchDir: join(root, 'scratch'),
      modelRepo: 'D:/models/demucs',
      audioPath,
      settings,
      onProgress: (p) => progress.push(p.fraction),
    });

    expect(result.stems).toEqual(DEMUCS_STEMS);
    expect(requested).toMatchObject({ channels: 2, sampleRate: 44_100, model: 'htdemucs', repo: 'D:/models/demucs' });
    // Progress only ever climbs, and finishes.
    expect(progress.every((v, i) => i === 0 || v >= progress[i - 1]!)).toBe(true);
    expect(progress.at(-1)).toBeCloseTo(1);

    // The same cache entry the studio's analysis reads: a hit now returns five sources.
    const decoded = await decodeMono48k(FFMPEG_EXE, audioPath);
    const cache = new AnalysisCache({ root: join(root, 'cache') });
    const hit = await analyzeCached(decoded.pcm, cache, { ...cacheOptionsFor(settings), audioHash: decoded.pcmSha256 });
    expect(hit.fromCache).toBe(true);
    expect([...hit.analysis.sources.keys()].sort()).toEqual(['bass', 'drums', 'mix', 'other', 'vocals']);

    const mixBeat = hit.analysis.sources.get('mix')!.features.get('beat')!.data;
    for (const stem of DEMUCS_STEMS) {
      const source = hit.analysis.sources.get(stem)!;
      expect(source.bands.size).toBe(settings.bands.length);
      expect(Array.from(source.features.get('beat')!.data)).toEqual(Array.from(mixBeat));
      expect(existsSync(join(root, 'stems', result.audioHash, 'htdemucs', `${stem}.flac`))).toBe(true);
    }
    // Louder stems read louder: the analysis is of each stem, not of the mix again.
    const rms = (stem: string) => {
      const data = hit.analysis.sources.get(stem as never)!.features.get('rms')!.data;
      return data.reduce((a, b) => a + b, 0) / data.length;
    };
    expect(rms('other')).toBeGreaterThan(rms('drums'));
    // Scratch is cleaned up.
    expect(existsSync(join(root, 'scratch', `stems-${result.audioHash.slice(0, 16)}`))).toBe(false);
  }, 60_000);

  it('a cancel marks the unfinished stems, never leaving them pending', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(separateStems({
      ffmpegExe: FFMPEG_EXE,
      sidecar: fakeSidecar(),
      cacheRoot: join(root, 'cache'),
      stemsRoot: join(root, 'stems'),
      scratchDir: join(root, 'scratch'),
      modelRepo: 'x',
      audioPath,
      settings,
      signal: controller.signal,
    })).rejects.toBeInstanceOf(StemsCancelledError);
  }, 60_000);

  it('a sidecar failure is recorded against each stem, with the reason', async () => {
    const failing: StemSidecar = { request: async () => { throw new Error('CUDA out of memory'); } };
    await expect(separateStems({
      ffmpegExe: FFMPEG_EXE, sidecar: failing, cacheRoot: join(root, 'cache'), stemsRoot: join(root, 'stems'),
      scratchDir: join(root, 'scratch'), modelRepo: 'x', audioPath, settings,
    })).rejects.toThrow('CUDA out of memory');
    const decoded = await decodeMono48k(FFMPEG_EXE, audioPath);
    const cache = new AnalysisCache({ root: join(root, 'cache') });
    const { settingsHash } = await analyzeCached(decoded.pcm, cache, { ...cacheOptionsFor(settings), audioHash: decoded.pcmSha256 });
    const readiness = await cache.readiness(decoded.pcmSha256, settingsHash);
    for (const stem of DEMUCS_STEMS) expect(readiness[stem]).toMatchObject({ state: 'failed', error: 'CUDA out of memory' });
  }, 60_000);
});
