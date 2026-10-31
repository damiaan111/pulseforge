// Video as audio (C14) and several files as one (C13): the sound comes out of a real container and
// plays as FLAC, a video without sound says so, and a join is the parts in the order given.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FFMPEG_EXE, FFPROBE_EXE } from '../../setup/lib/paths.ts';
import { AudioWorkError, combineAudio, combineAudioArgs, combinedStem, extractAudio, extractAudioArgs } from '../../src/assets/audio-work.ts';
import { isVideoFile, needsWorkingAudio } from '../../src/assets/media-types.ts';
import { decodeMono48k } from '../../src/analysis/decode.ts';
import { encodeWavFloat32 } from '../../src/export/audio.ts';

describe('media types', () => {
  it('knows a video by its extension, whatever the case and the folder', () => {
    expect(isVideoFile('C:\\clips.mp3\\Live.MKV')).toBe(true);
    expect(isVideoFile('/music/song.mp3')).toBe(false);
    expect(isVideoFile('no-extension')).toBe(false);
  });

  it('takes a working copy of whatever the preview cannot play, and of no plain audio file', () => {
    for (const name of ['a.mp4', 'a.webm', 'a.mkv', 'a.aiff', 'a.xyz']) expect(needsWorkingAudio(name)).toBe(true);
    for (const name of ['a.mp3', 'a.wav', 'a.flac', 'a.m4a', 'a.ogg', 'a.opus', 'a.aac']) expect(needsWorkingAudio(name)).toBe(false);
  });
});

describe('FFmpeg arguments', () => {
  it('extracts the first audio stream and no picture', () => {
    const args = extractAudioArgs('in.mkv', 'out.flac');
    expect(args.join(' ')).toContain('-map 0:a:0 -vn -c:a flac');
  });

  it('joins in the order given, each file converted on the way in, and names the parts', () => {
    const args = combineAudioArgs(['b.mp3', 'a.wav'], 'out.flac', ['b.mp3', 'a.wav']);
    expect(args.filter((a, i) => args[i - 1] === '-i')).toEqual(['b.mp3', 'a.wav']);
    const filter = args[args.indexOf('-filter_complex') + 1] as string;
    expect(filter).toContain('[a0][a1]concat=n=2:v=0:a=1[out]');
    expect(filter.match(/sample_rates=48000:channel_layouts=stereo/g)).toHaveLength(2);
    expect(args).toContain('comment=Combined from: b.mp3; a.wav');
  });

  it('names a combined file after what went in, and counts what does not fit', () => {
    expect(combinedStem(['intro.wav', 'verse.mp3'])).toBe('Combined - intro + verse');
    expect(combinedStem(['a.wav', 'b?c.wav', 'd.wav', 'e.wav', 'f.wav'])).toBe('Combined - a + b c + d + 2 more');
  });
});

describe.skipIf(!existsSync(FFMPEG_EXE))('with the vendored FFmpeg', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pulseforge-audio-work-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function tone(name: string, rate: number, seconds: number, hz: number): Promise<string> {
    const samples = Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => 0.25 * Math.sin((2 * Math.PI * hz * i) / rate));
    const path = join(root, name);
    await writeFile(path, encodeWavFloat32([samples, samples], rate));
    return path;
  }

  const video = (name: string, audio: string | null) => {
    const path = join(root, name);
    const result = spawnSync(FFMPEG_EXE, [
      '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:r=10:d=1',
      ...(audio === null ? [] : ['-i', audio, '-shortest', '-c:a', 'aac']),
      '-c:v', 'mpeg4', path,
    ]);
    expect(result.status, result.stderr.toString()).toBe(0);
    return path;
  };

  /** Zero crossings a second: enough to tell which of two tones is playing. */
  function pitchOf(pcm: Float32Array, from: number, to: number): number {
    let crossings = 0;
    const start = Math.round(from * 48_000);
    const end = Math.round(to * 48_000);
    for (let i = start + 1; i < end; i += 1) {
      if (((pcm[i - 1] as number) < 0) !== ((pcm[i] as number) < 0)) crossings += 1;
    }
    return crossings / 2 / (to - from);
  }

  it('takes the sound out of a video as a FLAC the analysis can read, and reuses it', async () => {
    const clip = video('Live set.mkv', await tone('sound.wav', 44_100, 1, 440));
    const folder = join(root, 'Audio');
    const path = await extractAudio({ ffmpegExe: FFMPEG_EXE, input: clip, folder, contentHash: 'abcdef0123456789' });
    expect(path).toBe(join(folder, 'Live set (sound) abcdef01.flac'));

    const probe = spawnSync(FFPROBE_EXE, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'csv=p=0', path]).stdout.toString();
    expect(probe.trim()).toBe('flac,audio');
    const { pcm } = await decodeMono48k(FFMPEG_EXE, path);
    expect(pitchOf(pcm, 0.2, 0.8)).toBeCloseTo(440, -1);

    const before = await stat(path);
    await extractAudio({ ffmpegExe: FFMPEG_EXE, input: clip, folder, contentHash: 'abcdef0123456789' });
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
  });

  it('says so when a video has no sound, and leaves nothing behind', async () => {
    const clip = video('silent.mkv', null);
    const folder = join(root, 'Audio');
    await expect(extractAudio({ ffmpegExe: FFMPEG_EXE, input: clip, folder, contentHash: '00000000' })).rejects.toThrow('silent.mkv has no sound to use.');
    expect(await readdir(folder)).toEqual([]);
  });

  it('joins files of different rates in the order given', async () => {
    const low = await tone('low.wav', 44_100, 1, 220);
    const high = await tone('high.wav', 48_000, 1, 880);
    const folder = join(root, 'Audio');

    const first = await combineAudio({ ffmpegExe: FFMPEG_EXE, inputs: [low, high], folder });
    expect(first.parts).toEqual(['low.wav', 'high.wav']);
    const { pcm } = await decodeMono48k(FFMPEG_EXE, first.path);
    expect(pcm.length / 48_000).toBeCloseTo(2, 2);
    expect(pitchOf(pcm, 0.2, 0.8)).toBeCloseTo(220, -1);
    expect(pitchOf(pcm, 1.2, 1.8)).toBeCloseTo(880, -1);

    // The same files the other way round are another song, not the first file again.
    const second = await combineAudio({ ffmpegExe: FFMPEG_EXE, inputs: [high, low], folder });
    expect(second.path).not.toBe(first.path);
    expect(pitchOf((await decodeMono48k(FFMPEG_EXE, second.path)).pcm, 0.2, 0.8)).toBeCloseTo(880, -1);
  });

  it('refuses one file, and names a file that cannot be read', async () => {
    const low = await tone('low.wav', 48_000, 0.2, 220);
    await expect(combineAudio({ ffmpegExe: FFMPEG_EXE, inputs: [low], folder: root })).rejects.toThrow(AudioWorkError);
    const broken = join(root, 'broken.mp3');
    await writeFile(broken, 'not audio');
    await expect(combineAudio({ ffmpegExe: FFMPEG_EXE, inputs: [low, broken], folder: join(root, 'Audio') })).rejects.toThrow(/Could not combine/);
    expect((await readdir(join(root, 'Audio'))).filter((name) => name.endsWith('.part'))).toEqual([]);
  });
});
