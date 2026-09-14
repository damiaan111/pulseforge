import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeMono48k } from '../../src/analysis/decode.ts';
import { createFft, hannWindow } from '../../src/analysis/fft.ts';
import { ANALYSIS_SAMPLE_RATE, DEFAULT_SPECTRUM_SETTINGS, analysisFrameCount, computeSourceAnalysis } from '../../src/analysis/spectrum.ts';
import { sampleTrack, sampleTrackInto, trackFrames, type AnalysisTrack } from '../../src/engine/core/analysis.ts';
import { binsToBars } from '../../src/engine/modules/bars.ts';

function sine(hz: number, amplitude: number, seconds: number): Float32Array {
  const pcm = new Float32Array(Math.round(seconds * ANALYSIS_SAMPLE_RATE));
  for (let i = 0; i < pcm.length; i++) pcm[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / ANALYSIS_SAMPLE_RATE);
  return pcm;
}

describe('fft', () => {
  it('puts a bin-centred sine in its bin with magnitude A·N/4 after a Hann window', () => {
    const n = 1024;
    const fft = createFft(n);
    const w = hannWindow(n);
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = 0.5 * Math.sin((2 * Math.PI * 37 * i) / n) * (w[i] ?? 0);
    fft.transform(re, im);
    const magnitude = (k: number) => Math.hypot(re[k] ?? 0, im[k] ?? 0);
    expect(magnitude(37)).toBeCloseTo((0.5 * n) / 4, 6);
    expect(magnitude(50)).toBeLessThan(1e-9);
  });

  it('rejects sizes that are not powers of two', () => {
    expect(() => createFft(1000)).toThrow(RangeError);
  });
});

describe('spectrum analysis', () => {
  const settings = DEFAULT_SPECTRUM_SETTINGS;

  it('produces 240 Hz frames centred on multiples of 200 samples', () => {
    expect(analysisFrameCount(0)).toBe(0);
    expect(analysisFrameCount(1)).toBe(1);
    expect(analysisFrameCount(201)).toBe(2);
    const result = computeSourceAnalysis(sine(1000, 0.5, 1), settings);
    expect(result.spectrum.rate).toBe(240);
    expect(trackFrames(result.spectrum)).toBe(240);
  });

  it('lights the log bin containing a tone, at its level', () => {
    const result = computeSourceAnalysis(sine(1000, 0.5, 1), settings);
    const frame = 120;
    const values = Array.from({ length: settings.bins }, (_, b) => result.spectrum.data[frame * settings.bins + b] ?? 0);
    const loudest = values.indexOf(Math.max(...values));
    const edge = (b: number) => settings.minHz * (settings.maxHz / settings.minHz) ** (b / settings.bins);
    expect(edge(loudest)).toBeLessThanOrEqual(1030);
    expect(edge(loudest + 1)).toBeGreaterThanOrEqual(970);
    // 0.5 amplitude = −6.02 dBFS → (72 − 6.02) / 72
    expect(values[loudest]).toBeCloseTo((72 - 6.0206) / 72, 1);
  });

  it('measures band energy as sine-equivalent level', () => {
    const inBand = computeSourceAnalysis(sine(80, 0.5, 1), settings).bands.get('bass');
    const outOfBand = computeSourceAnalysis(sine(2000, 0.5, 1), settings).bands.get('bass');
    expect(sampleTrack(inBand!, 0.5)).toBeCloseTo((72 - 6.0206) / 72, 1);
    expect(sampleTrack(outOfBand!, 0.5)).toBeLessThan(0.15);
  });

  it('is deterministic to the byte', () => {
    const pcm = sine(440, 0.3, 2);
    const a = computeSourceAnalysis(pcm, settings);
    const b = computeSourceAnalysis(pcm, settings);
    expect(Buffer.from(a.spectrum.data.buffer).equals(Buffer.from(b.spectrum.data.buffer))).toBe(true);
  });

  it('reads silence as 0', () => {
    const result = computeSourceAnalysis(new Float32Array(48_000), settings);
    expect(Math.max(...result.spectrum.data)).toBe(0);
  });
});

describe('analysis track reads', () => {
  const track: AnalysisTrack = { rate: 240, channels: 2, data: new Float32Array([0, 10, 1, 20, 2, 30]) };

  it('interpolates linearly between samples', () => {
    expect(sampleTrack(track, 0.5 / 240, 0)).toBeCloseTo(0.5, 6);
    expect(sampleTrack(track, 1.5 / 240, 1)).toBeCloseTo(25, 6);
  });

  it('clamps at both ends instead of extrapolating', () => {
    expect(sampleTrack(track, -1, 1)).toBe(10);
    expect(sampleTrack(track, 99, 0)).toBe(2);
    const out = new Float32Array(2);
    sampleTrackInto(track, 99, out);
    expect(Array.from(out)).toEqual([2, 30]);
  });
});

describe('binsToBars', () => {
  it('averages when there are more bins than bars', () => {
    const out = new Float32Array(2);
    binsToBars(new Float32Array([0, 1, 1, 1]), 4, 2, out);
    expect(Array.from(out)).toEqual([0.5, 1]);
  });

  it('interpolates when there are more bars than bins', () => {
    const out = new Float32Array(4);
    binsToBars(new Float32Array([0, 1]), 2, 4, out);
    expect(out[0]).toBe(0);
    expect(out[3]).toBe(1);
    expect(out[1]).toBeGreaterThan(0);
    expect(out[1]).toBeLessThan(out[2]!);
  });
});

const FFMPEG = resolve(import.meta.dirname, '..', '..', 'vendor', 'ffmpeg', 'bin', 'ffmpeg.exe');

describe.skipIf(!existsSync(FFMPEG))('decode (vendored FFmpeg; skipped until `npm run setup`)', () => {
  it('decodes a file to mono 48 kHz float PCM with a stable content hash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pulseforge-decode-'));
    try {
      const file = join(dir, 'tone.flac');
      const made = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=44100:duration=1', '-ac', '2', file]);
      expect(made.status).toBe(0);
      const a = await decodeMono48k(FFMPEG, file);
      const b = await decodeMono48k(FFMPEG, file);
      expect(a.sampleRate).toBe(48_000);
      expect(Math.abs(a.pcm.length - 48_000)).toBeLessThanOrEqual(64);
      expect(a.pcmSha256).toBe(b.pcmSha256);
      const level = computeSourceAnalysis(a.pcm).spectrum;
      expect(Math.max(...level.data)).toBeGreaterThan(0.5);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('explains a file that is not audio', async () => {
    await expect(decodeMono48k(FFMPEG, resolve(import.meta.dirname, 'analysis.test.ts'))).rejects.toThrow(/could not decode/);
  });
});
