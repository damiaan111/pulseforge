import { describe, expect, it } from 'vitest';

import { setLoopEnd, toggleLoop } from '../../src/ui/loop-region.ts';

describe('the loop region', () => {
  it('starts from either end, running to the other end of the timeline', () => {
    expect(setLoopEnd(null, 'in', 10, 60)).toEqual({ startSeconds: 10, endSeconds: 60, on: true });
    expect(setLoopEnd(null, 'out', 10, 60)).toEqual({ startSeconds: 0, endSeconds: 10, on: true });
  });

  it('keeps the other end when it can', () => {
    const loop = { startSeconds: 10, endSeconds: 20, on: false };
    expect(setLoopEnd(loop, 'out', 30, 60)).toEqual({ startSeconds: 10, endSeconds: 30, on: true });
    expect(setLoopEnd(loop, 'in', 15, 60)).toEqual({ startSeconds: 15, endSeconds: 20, on: true });
  });

  it('moves the other end rather than turning inside out', () => {
    const loop = { startSeconds: 10, endSeconds: 20, on: true };
    expect(setLoopEnd(loop, 'in', 25, 60).endSeconds).toBeCloseTo(25.1, 5);
    expect(setLoopEnd(loop, 'out', 5, 60).startSeconds).toBeCloseTo(4.9, 5);
  });

  it('toggles and keeps the region', () => {
    const loop = { startSeconds: 1, endSeconds: 2, on: true };
    expect(toggleLoop(loop)).toEqual({ ...loop, on: false });
    expect(toggleLoop(null)).toBeNull();
  });
});
