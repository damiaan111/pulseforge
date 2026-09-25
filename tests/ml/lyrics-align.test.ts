// Lyrics alignment end to end (M26), minus Python: a fake sidecar answers `transcribe` and `align`
// with canned results; FFmpeg, hashing, the stem lookup, matching and the sanity pass are real.
// The real WhisperX run is tests/golden/lyrics-align-gpu.test.ts.

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FFMPEG_EXE } from '../../setup/lib/paths.ts';
import { decodeMono48k } from '../../src/analysis/decode.ts';
import { synthesizeTestTrack } from '../../src/analysis/reference-track.ts';
import { TICKS_PER_SECOND } from '../../src/engine/core/time.ts';
import { encodeWavFloat32 } from '../../src/export/audio.ts';
import { ALIGN_MODEL_FILES, alignLyrics, installedAlignLanguages, LyricsLanguageError, LyricsNeedStemsError, type LyricsAlignOptions } from '../../src/ml/lyrics-align.ts';
import type { StemSidecar } from '../../src/ml/stems.ts';

const available = existsSync(FFMPEG_EXE);
const T = (s: number) => Math.round(s * TICKS_PER_SECOND);

let root: string;
let audioPath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pulseforge-lyrics-align-'));
  audioPath = join(root, 'track.wav');
  const mono = synthesizeTestTrack(3);
  await writeFile(audioPath, encodeWavFloat32([mono, mono], 48_000));
  // Languages are what is installed: an (empty) English model file stands in for the lyrics tier.
  await mkdir(join(root, 'align'), { recursive: true });
  await writeFile(join(root, 'align', ALIGN_MODEL_FILES['en'] as string), '');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function withVocalStem(): Promise<void> {
  const hash = (await decodeMono48k(FFMPEG_EXE, audioPath)).pcmSha256;
  await mkdir(join(root, 'stems', hash, 'htdemucs'), { recursive: true });
  await writeFile(join(root, 'stems', hash, 'htdemucs', 'vocals.flac'), 'not read by the fake sidecar');
}

/** Hears "hello there" at 0.5 s and "general kenobi" at 1.8 s; aligns every word it is given. */
function fakeSidecar(calls: string[]): StemSidecar {
  return {
    async request(command, params, { onProgress }) {
      calls.push(command);
      expect(String(params['audio'])).toMatch(/vocals\.flac$/);
      onProgress?.({ fraction: 1 });
      if (command === 'transcribe') {
        return {
          language: 'en',
          duration: 3,
          segments: [
            { start: 0.5, end: 1.2, text: 'hello there', words: [{ text: 'hello', start: 0.5, end: 0.8 }, { text: 'there', start: 0.85, end: 1.2 }] },
            { start: 1.8, end: 2.6, text: 'general kenobi', words: [{ text: 'general', start: 1.8, end: 2.2 }, { text: 'kenobi', start: 2.2, end: 2.6 }] },
          ],
        };
      }
      const segments = params['segments'] as { id: string; text: string; start: number; end: number }[];
      return {
        lines: segments.map((s) => {
          const runs = s.text.split(' ');
          const step = (s.end - s.start) / runs.length;
          return { id: s.id, error: null, words: runs.map((word, i) => ({ word, start: s.start + i * step, end: s.start + (i + 1) * step, score: 0.8 })) };
        }),
      };
    },
  };
}

const base = (calls: string[]): LyricsAlignOptions => ({
  ffmpegExe: FFMPEG_EXE,
  sidecar: fakeSidecar(calls),
  stemsRoot: join(root, 'stems'),
  stemModel: 'htdemucs',
  audioPath,
  whisperDir: 'w',
  alignDir: join(root, 'align'),
  language: 'en',
  mode: 'align',
  lines: [{ id: 'l1', text: 'Hello there' }, { id: 'l2', text: 'General Kenobi' }],
  placement: { leadInTicks: T(1), clipInTicks: 0 },
});

describe.skipIf(!available)('lyrics alignment without Python', () => {
  it('refuses without a vocal stem, and in a language with no alignment model', async () => {
    await expect(alignLyrics(base([]))).rejects.toThrow(LyricsNeedStemsError);
    await expect(alignLyrics({ ...base([]), language: 'nl' })).rejects.toThrow(LyricsLanguageError);
    // French is provisionable (an extra) but not installed here: refused, and told where to get it.
    await expect(alignLyrics({ ...base([]), language: 'fr' })).rejects.toThrow(/Settings/);
    await writeFile(join(root, 'align', ALIGN_MODEL_FILES['fr'] as string), '');
    expect(installedAlignLanguages(join(root, 'align'))).toEqual(['en', 'fr']);
  });

  it('aligns the given lines inside the windows the transcript gives them, on the timeline', async () => {
    await withVocalStem();
    const calls: string[] = [];
    const progress: number[] = [];
    const result = await alignLyrics({ ...base(calls), onProgress: (p) => progress.push(p.fraction) });
    expect(calls).toEqual(['transcribe', 'align']);
    expect(result.rejected).toEqual([]);
    expect(result.aligned.map((l) => l.lineId)).toEqual(['l1', 'l2']);
    // Window 0.5..1.2 padded by 0.35 → 0.15; a 1 s lead-in puts it at 1.15 s on the timeline.
    expect(result.aligned[0]?.startTicks).toBe(T(1.15));
    expect(result.aligned[0]?.words.map((w) => w.text)).toEqual(['Hello', 'there']);
    expect(progress[progress.length - 1]).toBeCloseTo(1);
    expect(progress.every((p, i) => i === 0 || p >= (progress[i - 1] as number))).toBe(true);
  });

  it('transcribes into new lines when there is no text', async () => {
    await withVocalStem();
    const result = await alignLyrics({ ...base([]), mode: 'transcribe', lines: [] });
    expect(result.created.map((l) => l.text)).toEqual(['hello there', 'general kenobi']);
    expect(result.created[1]?.words).toHaveLength(2);
  });

  it('reports lines the sanity pass refuses, with why', async () => {
    await withVocalStem();
    const result = await alignLyrics({ ...base([]), vocalSegments: [{ start: 3, end: 4 }] });
    // Only the second line (timeline 2.45–3.95 s) overlaps the detected singing.
    expect(result.rejected.map((r) => [r.lineId, r.reason])).toEqual([['l1', 'no singing was detected where it landed']]);
    expect(result.aligned.map((l) => l.lineId)).toEqual(['l2']);
  });
});
