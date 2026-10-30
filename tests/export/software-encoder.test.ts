// The export on a machine with no usable NVENC: real encodes through the vendored FFmpeg's OpenH264,
// which needs no GPU and no particular driver, so this runs wherever setup has.

import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { rational } from '../../src/engine/core/time.ts';
import { probeCodecs } from '../../src/export/encoder-probe.ts';
import { startEncoder } from '../../src/export/encoder.ts';
import { buildFfmpegArgs, defaultEncodeSettings, settingsProblems, softwareBitrate, type EncodeSettings } from '../../src/export/ffmpeg-args.ts';
import { checkOutput, probeFile } from '../../src/export/verify.ts';

const BIN = resolve(import.meta.dirname, '..', '..', 'vendor', 'ffmpeg', 'bin');
const FFMPEG = join(BIN, 'ffmpeg.exe');
const FFPROBE = join(BIN, 'ffprobe.exe');
const W = 320;
const H = 240;
const FPS = rational(30);
const FRAMES = 30;
const SOFTWARE: EncodeSettings = { ...defaultEncodeSettings('h264'), encoder: 'software' };

function frame(index: number, settings: EncodeSettings): Uint8Array {
  if (settings.conversion === 'swscale') {
    return new Uint8Array(W * H * 4).map((_, i) => (i % 4 === 3 ? 255 : (i + index * 7) & 255));
  }
  return new Uint8Array((W * H * 3) / 2).fill(16 + index);
}

describe('software encoding, as arguments', () => {
  const job = { width: 1920, height: 1080, fps: rational(60), settings: SOFTWARE, audioPath: undefined, outputPath: 'o.mp4', bitexact: false };

  it('asks for OpenH264 and none of NVENC\'s options', () => {
    const args = buildFfmpegArgs(job);
    expect(args).toContain('libopenh264');
    expect(args).not.toContain('h264_nvenc');
    expect(args).not.toContain('-rc-lookahead');
    expect(args).toContain('-color_primaries');
  });

  it('leaves the NVENC command as it was when no encoder is named', () => {
    expect(buildFfmpegArgs({ ...job, settings: defaultEncodeSettings('h264') })).toContain('h264_nvenc');
  });

  it('turns a quality into a bitrate that scales with the picture', () => {
    expect(softwareBitrate(1920, 1080, rational(60), 17)).toBe(49_766_400);
    expect(softwareBitrate(3840, 2160, rational(60), 17)).toBe(4 * 49_766_400);
    expect(softwareBitrate(1920, 1080, rational(60), 23)).toBe(24_883_200);
  });

  it('refuses what it cannot make', () => {
    expect(settingsProblems({ ...defaultEncodeSettings('hevc'), encoder: 'software' }, W, H).join(' ')).toContain('H.264 only');
  });
});

describe.skipIf(!existsSync(FFMPEG))('a real software encode', () => {
  it('says H.264 is available on every machine, and which encoder that is', async () => {
    const { h264 } = await probeCodecs(FFMPEG);
    expect(h264.available).toBe(true);
    expect(['nvenc', 'software']).toContain(h264.encoder);
  }, 60_000);

  it.each([['the GPU\'s NV12', SOFTWARE], ['RGBA', { ...SOFTWARE, conversion: 'swscale' } as EncodeSettings]])('makes a verified file from %s', async (_name, settings) => {
    const dir = await mkdtemp(join(tmpdir(), 'pf-software-'));
    try {
      const output = join(dir, 'out.mp4');
      const encoder = startEncoder(FFMPEG, buildFfmpegArgs({ width: W, height: H, fps: FPS, settings, audioPath: undefined, outputPath: output, bitexact: true }));
      for (let i = 0; i < FRAMES; i += 1) await encoder.sink.write(frame(i, settings));
      await encoder.finish();
      const check = checkOutput(await probeFile(FFPROBE, output), { frameCount: FRAMES, width: W, height: H, fps: FPS, settings, hasAudio: false });
      expect(check.issues).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
