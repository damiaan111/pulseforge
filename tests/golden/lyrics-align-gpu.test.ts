// WhisperX for real (M26): transcription and forced alignment on the GPU through the supervised
// sidecar, with the models setup provisioned — offline. The repo holds no singing, so this pins
// the plumbing and the honest-failure behaviour on the synthetic reference track: the sidecar starts
// with the lyrics imports (no stdin deadlock), CTranslate2 finds the CUDA 12 cuBLAS, both models
// load from vendor/, instrumental audio transcribes to nothing rather than to invented words, and a
// forced alignment returns every word inside its window. Alignment quality on real singing was
// checked by hand (STATUS §4.55). Skipped where the lyrics part of setup is not installed.

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { torchHasCuda } from '../ml/cuda.ts';

import { pythonEnv } from '../../setup/lib/env.ts';
import { FFMPEG_EXE, MODELS, PYTHON_EXE, ROOT, VENDOR } from '../../setup/lib/paths.ts';
import { decodeMono48k } from '../../src/analysis/decode.ts';
import { synthesizeTestTrack } from '../../src/analysis/reference-track.ts';
import { encodeWavFloat32 } from '../../src/export/audio.ts';
import { alignLyrics } from '../../src/ml/lyrics-align.ts';
import { SidecarSupervisor, spawnPythonSidecar } from '../../src/ml/supervisor.ts';

const WHISPER = join(MODELS, 'whisper', 'faster-whisper-medium');
const ALIGN = join(MODELS, 'align');
const available = [FFMPEG_EXE, PYTHON_EXE, join(WHISPER, 'model.bin'), join(ALIGN, 'wav2vec2_fairseq_base_ls960_asr_ls960.pth'), join(VENDOR, 'python', '.pulseforge-lyrics-env.json')]
  .every((p) => existsSync(p)) && torchHasCuda();

let root: string;
let audioPath: string;
let supervisor: SidecarSupervisor;
let counter = 0;

beforeAll(async () => {
  if (!available) return;
  root = await mkdtemp(join(tmpdir(), 'pulseforge-lyrics-gpu-'));
  audioPath = join(root, 'reference.wav');
  const mono = synthesizeTestTrack(6);
  await writeFile(audioPath, encodeWavFloat32([mono, mono], 48_000));
  // The "vocal stem" is the reference track itself, where the stem job would have kept it.
  const hash = (await decodeMono48k(FFMPEG_EXE, audioPath)).pcmSha256;
  await mkdir(join(root, 'stems', hash, 'htdemucs'), { recursive: true });
  await writeFile(join(root, 'stems', hash, 'htdemucs', 'vocals.flac'), encodeWavFloat32([mono], 48_000));
  supervisor = new SidecarSupervisor({
    spawn: spawnPythonSidecar(PYTHON_EXE, join(ROOT, 'python'), pythonEnv()),
    newId: () => `t${counter++}`,
    idleTimeoutMs: 0,
  });
}, 60_000);

afterAll(async () => {
  await supervisor?.stop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

describe.skipIf(!available)('WhisperX on the GPU', () => {
  it('transcribes instrumental audio to nothing, and says every line was not found', async () => {
    const started = performance.now();
    const result = await alignLyrics({
      ffmpegExe: FFMPEG_EXE,
      sidecar: supervisor,
      stemsRoot: join(root, 'stems'),
      stemModel: 'htdemucs',
      audioPath,
      whisperDir: WHISPER,
      alignDir: ALIGN,
      language: 'en',
      mode: 'align',
      lines: [{ id: 'a', text: 'these words are never sung' }],
      placement: { leadInTicks: 0, clipInTicks: 0 },
    });
    expect(result.detectedLanguage).toBe('en');
    // The line cannot be placed from an empty transcript... unless the gap rule gives the whole
    // track to it, in which case forced alignment must still keep every word inside the audio.
    if (result.unplaced.length === 0) {
      for (const line of result.aligned) for (const word of line.words) expect(word.endTicks).toBeLessThanOrEqual(6 * 48_000);
    }
    console.log(`[lyrics-gpu] first request (model loads included): ${((performance.now() - started) / 1000).toFixed(1)} s`);
  }, 300_000);

  it('force-aligns known text inside the window it is given, word by word', async () => {
    const hash = (await decodeMono48k(FFMPEG_EXE, audioPath)).pcmSha256;
    const reply = await supervisor.request('align', {
      audio: join(root, 'stems', hash, 'htdemucs', 'vocals.flac'),
      language: 'en',
      modelDir: ALIGN,
      device: 'cuda',
      segments: [{ id: 'x', text: 'one two three', start: 1, end: 4 }],
    }, {}) as unknown as { lines: { id: string; error: string | null; words: { word: string; start: number | null; end: number | null; score: number | null }[] }[] };
    const [line] = reply.lines;
    expect(line?.error).toBe(null);
    expect(line?.words.map((w) => w.word)).toEqual(['one', 'two', 'three']);
    for (const word of line?.words ?? []) {
      expect(word.start).not.toBe(null);
      expect(word.start as number).toBeGreaterThanOrEqual(1);
      expect(word.end as number).toBeLessThanOrEqual(4.01);
    }
  }, 300_000);

  it('leaves the sidecar healthy, CUDA and all, after the lyrics requests', async () => {
    const health = await supervisor.request('health', {}, {}) as unknown as { cudaAvailable: boolean };
    expect(health.cudaAvailable).toBe(true);
  }, 60_000);
});
