import { describe, expect, it } from 'vitest';
import {
  TICKS_PER_SECOND,
  frameCount,
  frameStartTick,
  frameTimeSeconds,
  motionBlurProblems,
  rational,
  secondsToTicks,
  subframeTimes,
  timelineToSourceSeconds,
} from '../../src/engine/core/time.ts';

const FPS_60 = rational(60);
const FPS_5994 = rational(60000, 1001);

describe('time', () => {
  it('counts frames exactly, rounding up partial frames', () => {
    expect(frameCount(10 * TICKS_PER_SECOND, FPS_60)).toBe(600);
    expect(frameCount(10 * TICKS_PER_SECOND + 1, FPS_60)).toBe(601);
    expect(frameCount(0, FPS_60)).toBe(0);
    // 4 minutes at 59.94: 240 · 60000/1001 = 14385.61… → 14386
    expect(frameCount(240 * TICKS_PER_SECOND, FPS_5994)).toBe(14386);
  });

  it('derives frame time from the index without accumulating drift', () => {
    let accumulated = 0;
    for (let n = 0; n < 18_000; n++) accumulated += 1 / 60;
    expect(accumulated).not.toBe(300); // the bug the rule exists to avoid
    expect(frameTimeSeconds(18_000, FPS_60)).toBe(300);
    expect(frameTimeSeconds(1001, FPS_5994)).toBe(1001 * 1001 / 60000);
  });

  it('floors NTSC frame boundaries to ticks, exact for integer fps', () => {
    expect(frameStartTick(1, FPS_60)).toBe(800);
    expect(frameStartTick(1, FPS_5994)).toBe(800); // 800.8 → 800
    expect(frameStartTick(5, FPS_5994)).toBe(4004); // exactly 4004
    expect(frameStartTick(6, FPS_5994)).toBe(4804); // 4804.8 → 4804
  });

  it('rejects non-rational fps', () => {
    expect(() => rational(29.97)).toThrow(RangeError);
    expect(() => rational(60, 0)).toThrow(RangeError);
  });

  it('maps timeline time to source audio through lead-in and clip-in', () => {
    const placement = { leadInTicks: secondsToTicks(2), clipInTicks: secondsToTicks(30) };
    expect(timelineToSourceSeconds(0, placement)).toBe(28);
    expect(timelineToSourceSeconds(2, placement)).toBe(30);
    expect(timelineToSourceSeconds(1, { leadInTicks: secondsToTicks(3), clipInTicks: 0 })).toBe(-2);
  });
});

describe('motion-blur subframes (S10, export-spec §9)', () => {
  it('spreads the samples evenly across t ± (shutter/2)/fps, weighted equally', () => {
    // 10 fps, 180°: open for 0.05 s around t = 0.5 s; four samples at the middle of each quarter.
    const subs = subframeTimes(5, rational(10), { samples: 4, shutterDegrees: 180 });
    expect(subs.map((s) => s.t)).toEqual([0.48125, 0.49375, 0.50625, 0.51875].map((x) => expect.closeTo(x, 12)));
    expect(subs.map((s) => s.tick)).toEqual([23_100, 23_700, 24_300, 24_900]);
    expect(subs.reduce((sum, s) => sum + s.weight, 0)).toBe(1);
  });

  it('holds a time before the timeline at 0, and is the same for the same frame every time', () => {
    const first = subframeTimes(0, rational(30), { samples: 8, shutterDegrees: 360 });
    expect(first.slice(0, 4).every((s) => s.t === 0 && s.tick === 0)).toBe(true);
    expect(first[7]!.t).toBeGreaterThan(0);
    expect(subframeTimes(1234, rational(60000, 1001), { samples: 8, shutterDegrees: 180 }))
      .toEqual(subframeTimes(1234, rational(60000, 1001), { samples: 8, shutterDegrees: 180 }));
  });

  it('reports a setting out of range', () => {
    expect(motionBlurProblems({ samples: 8, shutterDegrees: 180 })).toEqual([]);
    expect(motionBlurProblems({ samples: 1, shutterDegrees: 180 })).toHaveLength(1);
    expect(motionBlurProblems({ samples: 2.5, shutterDegrees: 0 })).toHaveLength(2);
  });
});
