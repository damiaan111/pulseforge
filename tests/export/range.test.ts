// Range renders (S9): the frames and samples of part of the timeline, derived from frame indices, and
// the audio of a range cut from the full render's audio rather than re-placed.

import { describe, expect, it } from 'vitest';

import { rational } from '../../src/engine/core/time.ts';
import { placeAudio, placeAudioWindow } from '../../src/export/audio.ts';
import { rangeFrames } from '../../src/export/range.ts';

const S = 48_000;

describe('rangeFrames', () => {
  it('the whole timeline without a range', () => {
    expect(rangeFrames(null, rational(60), 10 * S)).toEqual({ startFrame: 0, frames: 600, startSample: 0, totalSamples: 480_000 });
  });

  it('from the first frame at or after in, to the last before out, cut to the end', () => {
    expect(rangeFrames({ inTicks: 2 * S, outTicks: 5 * S }, rational(60), 10 * S)).toEqual({ startFrame: 120, frames: 180, startSample: 96_000, totalSamples: 144_000 });
    // In between frames: the next frame starts it.
    expect(rangeFrames({ inTicks: 2 * S + 1, outTicks: 5 * S }, rational(60), 10 * S).startFrame).toBe(121);
    expect(rangeFrames({ inTicks: 8 * S, outTicks: 99 * S }, rational(60), 10 * S).frames).toBe(120);
  });

  it('NTSC: samples follow the frames exactly, with no drift across a range', () => {
    const fps = rational(60_000, 1001);
    const r = rangeFrames({ inTicks: 30 * S, outTicks: 60 * S }, fps, 120 * S);
    const whole = rangeFrames(null, fps, 120 * S);
    expect(r.startSample + r.totalSamples).toBeLessThanOrEqual(whole.totalSamples);
    expect(rangeFrames({ inTicks: 0, outTicks: 30 * S }, fps, 120 * S).totalSamples).toBe(r.startSample);
  });

  it('refuses a range with no frame in it', () => {
    expect(() => rangeFrames({ inTicks: 5 * S, outTicks: 5 * S }, rational(60), 10 * S)).toThrow(/in < out/);
    expect(() => rangeFrames({ inTicks: 11 * S, outTicks: 12 * S }, rational(60), 10 * S)).toThrow(/no frame/);
  });
});

describe('placeAudioWindow', () => {
  it('is exactly the matching slice of the full placement, fades and lead-in included', () => {
    const source = [Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i / 7))];
    const placement = { leadInSamples: 100, clipInSamples: 50, clipOutSamples: 900, level: { gain: 0.7, fadeInTicks: 200, fadeOutTicks: 150, fadeInCurve: 'linear' as const, fadeOutCurve: 'linear' as const } };
    const full = placeAudio(source, placement, 1200);
    const window = placeAudioWindow(source, placement, 300, 500);
    expect(Array.from(window.channels[0]!)).toEqual(Array.from(full.channels[0]!.slice(300, 800)));
  });
});
