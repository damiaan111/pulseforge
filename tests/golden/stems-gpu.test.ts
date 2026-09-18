// Stems for real (M5, M27, M28): Demucs on the GPU through the supervised sidecar, the analysis of
// each stem, and the cache — on the reference track (kicks, a bassline, a chord pad, a sweep, hats).
// Skipped where the stems part of setup is not installed.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { pythonEnv } from '../../setup/lib/env.ts';
import { FFMPEG_EXE, MODELS, PYTHON_EXE, ROOT } from '../../setup/lib/paths.ts';
import { AnalysisCache } from '../../src/analysis/cache.ts';
import { analyzeCached } from '../../src/analysis/cached.ts';
import { decodeMono48k } from '../../src/analysis/decode.ts';
import { cacheOptionsFor } from '../../src/analysis/project-settings.ts';
import { synthesizeTestTrack } from '../../src/analysis/reference-track.ts';
import { encodeWavFloat32 } from '../../src/export/audio.ts';
import { SidecarSupervisor, spawnPythonSidecar } from '../../src/ml/supervisor.ts';
import { DEMUCS_STEMS, separateStems } from '../../src/ml/stems.ts';
import { GpuQueue } from '../../src/node/gpu-queue.ts';
import { DEFAULT_ANALYSIS_SETTINGS } from '../../src/project/create.ts';

const available = [FFMPEG_EXE, PYTHON_EXE, join(MODELS, 'demucs', 'htdemucs.yaml')].every((p) => existsSync(p));

let root: string;
let audioPath: string;
let supervisor: SidecarSupervisor;
let counter = 0;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'pulseforge-stems-gpu-'));
  audioPath = join(root, 'reference.wav');
  const mono = synthesizeTestTrack(8);
  await writeFile(audioPath, encodeWavFloat32([mono, mono], 48_000));
  supervisor = new SidecarSupervisor({
    spawn: spawnPythonSidecar(PYTHON_EXE, join(ROOT, 'python'), pythonEnv()),
    newId: () => `t${counter++}`,
    idleTimeoutMs: 0,
  });
});

afterAll(async () => {
  await supervisor?.stop();
  await rm(root, { recursive: true, force: true });
});

describe.skipIf(!available)('stem separation on the GPU', () => {
  it('separates the reference track into four analysed stems that the cache returns with the mix', async () => {
    const progress: string[] = [];
    const gpu = new GpuQueue();
    const result = await gpu.run('ml', 'stems', () => separateStems({
      ffmpegExe: FFMPEG_EXE,
      sidecar: supervisor,
      cacheRoot: join(root, 'cache'),
      stemsRoot: join(root, 'stems'),
      scratchDir: join(root, 'scratch'),
      modelRepo: join(MODELS, 'demucs'),
      audioPath,
      settings: DEFAULT_ANALYSIS_SETTINGS,
      onProgress: (p) => progress.push(p.stage),
    }));
    expect(result.stems).toEqual(DEMUCS_STEMS);
    expect(new Set(progress)).toEqual(new Set(['decoding', 'separating', 'analysing']));

    const decoded = await decodeMono48k(FFMPEG_EXE, audioPath);
    const cache = new AnalysisCache({ root: join(root, 'cache') });
    const hit = await analyzeCached(decoded.pcm, cache, { ...cacheOptionsFor(DEFAULT_ANALYSIS_SETTINGS), audioHash: decoded.pcmSha256 });
    expect([...hit.analysis.sources.keys()].sort()).toEqual(['bass', 'drums', 'mix', 'other', 'vocals']);

    // It really separated, and nothing was lost on the way. Which stem Demucs files a synthetic
    // sound under is Demucs' business (a pure sine "kick" is not obviously a drum), so the check is
    // what must hold regardless: the kept stems add back up to the original, and the energy is
    // split between them rather than all left in one.
    const decode = (path: string) => {
      const out = spawnSync(FFMPEG_EXE, ['-v', 'error', '-i', path, '-ac', '1', '-ar', '44100', '-f', 'f32le', 'pipe:1'], { maxBuffer: 1 << 28 }).stdout;
      return new Float32Array(out.buffer, out.byteOffset, Math.floor(out.byteLength / 4));
    };
    const original = decode(audioPath);
    const stems = DEMUCS_STEMS.map((stem) => decode(join(root, 'stems', result.audioHash, 'htdemucs', `${stem}.flac`)));
    const length = Math.min(original.length, ...stems.map((s) => s.length));
    let signal = 0;
    let error = 0;
    for (let i = 0; i < length; i += 1) {
      const sum = stems.reduce((acc, s) => acc + s[i]!, 0);
      signal += original[i]! ** 2;
      error += (original[i]! - sum) ** 2;
    }
    // Reconstruction within -20 dB of the signal (Demucs is not perfectly lossless).
    expect(error / signal).toBeLessThan(0.01);
    const energy = stems.map((s) => s.reduce((acc, v) => acc + v * v, 0));
    const total = energy.reduce((a, b) => a + b, 0);
    expect(energy.filter((e) => e / total > 0.05).length).toBeGreaterThanOrEqual(2);
  }, 300_000);

  it('the sidecar stays usable, and stops cleanly to free the GPU', async () => {
    const health = await supervisor.request('health', {});
    expect(health['cudaAvailable']).toBe(true);
    await supervisor.stop();
    expect(supervisor.state).toBe('stopped');
  }, 120_000);
});
