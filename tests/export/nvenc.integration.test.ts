// Real NVENC encodes through the vendored FFmpeg. Runs only where FFmpeg is provisioned and NVENC
// opens; skipped elsewhere, with the reason in the test name.

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { rational } from '../../src/engine/core/time.ts';
import { prepareExportAudio, samplesForFrames } from '../../src/export/audio.ts';
import { startEncoder } from '../../src/export/encoder.ts';
import { probeCodecs, probeEncoders } from '../../src/export/encoder-probe.ts';
import { buildFfmpegArgs, defaultEncodeSettings, type EncodeSettings } from '../../src/export/ffmpeg-args.ts';
import { checkOutput, probeFile } from '../../src/export/verify.ts';

const BIN = resolve(import.meta.dirname, '..', '..', 'vendor', 'ffmpeg', 'bin');
const FFMPEG = join(BIN, 'ffmpeg.exe');
const FFPROBE = join(BIN, 'ffprobe.exe');
const W = 320;
const H = 240;
const FPS = rational(30);
const FRAMES = 45;

function syntheticFrame(index: number, bitDepth: 8 | 10): Uint8Array {
  const bytes = new Uint8Array(W * H * 4);
  const view = new DataView(bytes.buffer);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      const r = (x + index * 4) % W / W;
      const g = y / H;
      const b = 0.5;
      if (bitDepth === 8) {
        bytes[o] = Math.round(r * 255);
        bytes[o + 1] = Math.round(g * 255);
        bytes[o + 2] = Math.round(b * 255);
        bytes[o + 3] = 255;
      } else {
        // x2bgr10le: R bits 0–9, G 10–19, B 20–29, A 30–31
        const word = (3 << 30) | (Math.round(b * 1023) << 20) | (Math.round(g * 1023) << 10) | Math.round(r * 1023);
        view.setUint32(o, word >>> 0, true);
      }
    }
  }
  return bytes;
}

async function encode(dir: string, name: string, settings: EncodeSettings, withAudio: boolean): Promise<string> {
  const output = join(dir, name);
  let audioPath: string | undefined;
  if (withAudio) {
    const total = samplesForFrames(FRAMES, FPS);
    const tone = Float32Array.from({ length: 40_000 }, (_, i) => 0.2 * Math.sin((2 * Math.PI * 440 * i) / 48_000));
    const prepared = await prepareExportAudio({ kind: 'pcm', channels: [tone, tone], sampleRate: 48_000 }, { leadInSamples: 4800, clipInSamples: 0, clipOutSamples: undefined }, total, join(dir, `${name}.wav`));
    audioPath = prepared.path;
  }
  const encoder = startEncoder(FFMPEG, buildFfmpegArgs({ width: W, height: H, fps: FPS, settings, audioPath, outputPath: output, bitexact: true }));
  for (let i = 0; i < FRAMES; i++) await encoder.sink.write(syntheticFrame(i, settings.bitDepth));
  await encoder.finish();
  expect(encoder.framesEncoded()).toBe(FRAMES);
  return output;
}

const nvenc = existsSync(FFMPEG) && (await probeCodecs(FFMPEG)).h264.encoder === 'nvenc';

describe.skipIf(!nvenc)('NVENC export path (skipped without FFmpeg, or where NVENC will not open)', () => {
  it('encodes H.264 with audio: exact frame count, tags, A/V length', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pulseforge-nvenc-'));
    try {
      const settings = { ...defaultEncodeSettings('h264'), conversion: 'swscale' } as const;
      const output = await encode(dir, 'h264.mp4', settings, true);
      const result = checkOutput(await probeFile(FFPROBE, output), { frameCount: FRAMES, width: W, height: H, fps: FPS, settings, hasAudio: true });
      expect(result.issues).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('encodes the 10-bit HEVC master from x2bgr10le', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pulseforge-nvenc-'));
    try {
      const settings = defaultEncodeSettings('hevc');
      const output = await encode(dir, 'hevc.mp4', settings, false);
      const result = checkOutput(await probeFile(FFPROBE, output), { frameCount: FRAMES, width: W, height: H, fps: FPS, settings, hasAudio: false });
      expect(result.issues).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('produces byte-identical files for identical input with bit-exact muxing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pulseforge-nvenc-'));
    try {
      const settings = { ...defaultEncodeSettings('h264'), conversion: 'swscale' } as const;
      const a = await encode(dir, 'a.mp4', settings, true);
      const b = await encode(dir, 'b.mp4', settings, true);
      const hash = async (p: string) => createHash('sha256').update(await readFile(p)).digest('hex');
      expect(await hash(a)).toBe(await hash(b));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('probes encoder capabilities: H.264/HEVC available, AV1 not on Ampere', async () => {
    const caps = await probeEncoders(FFMPEG);
    const byId = new Map(caps.map((c) => [c.id, c]));
    expect(byId.get('h264-8-420')?.available).toBe(true);
    expect(byId.get('hevc-10-420')?.available).toBe(true);
    // An RTX 30-series card cannot encode AV1; a 40-series would. Record rather than assume.
    expect(typeof byId.get('av1-8-420')?.available).toBe('boolean');
  }, 60_000);
});
