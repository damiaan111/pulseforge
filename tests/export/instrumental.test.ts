// Karaoke export (S15): the instrumental is exactly the sum of every stem but the vocals, built from
// the FLACs separation keeps; a track whose stems are missing is refused, naming them.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FFMPEG_EXE } from '../../setup/lib/paths.ts';
import { encodeWavFloat32 } from '../../src/export/audio.ts';
import { InstrumentalError, buildInstrumental, instrumentalStems } from '../../src/export/instrumental.ts';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pulseforge-karaoke-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const RATE = 44_100;
const sine = (hz: number, amplitude: number, t: number) => amplitude * Math.sin(2 * Math.PI * hz * t);

/** A stem as separation writes it: stereo FLAC at 44.1 kHz, here a sine of its own pitch. */
async function stem(name: string, hz: number, amplitude = 0.2): Promise<void> {
  const samples = Float32Array.from({ length: RATE }, (_, i) => sine(hz, amplitude, i / RATE));
  const wav = join(root, `${name}.wav`);
  await writeFile(wav, encodeWavFloat32([samples, samples], RATE));
  spawnSync(FFMPEG_EXE, ['-v', 'error', '-y', '-i', wav, '-c:a', 'flac', join(root, `${name}.flac`)]);
}

/**
 * The instrumental's left channel, as written (48 kHz). Not `-ac 1`: FFmpeg's stereo→mono downmix
 * scales the sum by 1/√2, which would read √2 too loud here.
 */
function decode48k(path: string): Float32Array {
  const out = spawnSync(FFMPEG_EXE, ['-v', 'error', '-i', path, '-af', 'pan=mono|c0=c0', '-f', 'f32le', 'pipe:1'], { maxBuffer: 1 << 26 }).stdout;
  return new Float32Array(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
}

describe('instrumentalStems', () => {
  it('is every stem the model makes but the vocals', () => {
    expect(instrumentalStems('htdemucs')).toEqual(['drums', 'bass', 'other']);
    expect(instrumentalStems('htdemucs_6s')).toEqual(['drums', 'bass', 'other', 'guitar', 'piano']);
  });
});

describe.skipIf(!existsSync(FFMPEG_EXE))('buildInstrumental', () => {
  it('sums the stems but the vocals, at full level (not averaged)', async () => {
    await stem('drums', 110);
    await stem('bass', 55);
    await stem('other', 440);
    await stem('vocals', 880, 0.5);
    const built = await buildInstrumental({ ffmpegExe: FFMPEG_EXE, stemDir: root, model: 'htdemucs', outPath: join(root, 'out', 'instrumental.wav') });
    expect(built.stems).toEqual(['drums', 'bass', 'other']);
    const mixed = decode48k(built.path);
    // Sample for sample the three sines (no vocal at 880 Hz), at full level and with no delay.
    let error = 0;
    let signal = 0;
    for (let i = 2000; i < 46_000; i += 1) {
      const t = i / 48_000;
      const want = sine(110, 0.2, t) + sine(55, 0.2, t) + sine(440, 0.2, t);
      error += (mixed[i]! - want) ** 2;
      signal += want ** 2;
    }
    expect(error / signal).toBeLessThan(1e-3);
  });

  it('refuses when stems are missing, naming them and the fix', async () => {
    await stem('drums', 110);
    const attempt = buildInstrumental({ ffmpegExe: FFMPEG_EXE, stemDir: root, model: 'htdemucs', outPath: join(root, 'x.wav') });
    await expect(attempt).rejects.toThrow(InstrumentalError);
    await expect(attempt).rejects.toThrow(/bass, other are not separated/);
  });
});
