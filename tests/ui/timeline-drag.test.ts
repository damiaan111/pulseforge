import { describe, expect, it } from 'vitest';

import { dragLayerRange, layerDragKind, trimClip } from '../../src/ui/timeline-drag.ts';

const END = 48_000 * 60;

describe('what a press on a layer block grabs', () => {
  it('takes the edges, the middle and nothing outside', () => {
    expect(layerDragKind(100, 100, 300, 6)).toBe('in');
    expect(layerDragKind(95, 100, 300, 6)).toBe('in');
    expect(layerDragKind(300, 100, 300, 6)).toBe('out');
    expect(layerDragKind(200, 100, 300, 6)).toBe('move');
    expect(layerDragKind(90, 100, 300, 6)).toBeNull();
  });

  it('leaves a short block a middle to hold', () => {
    expect(layerDragKind(106, 100, 112, 6)).toBe('move');
  });
});

describe('dragging a layer', () => {
  const range = { inTicks: 48_000, outTicks: 96_000 };

  it('moves with its length', () => {
    expect(dragLayerRange(range, 'move', 4800, END)).toEqual({ inTicks: 52_800, outTicks: 100_800 });
  });

  it('stops at zero rather than shortening', () => {
    expect(dragLayerRange(range, 'move', -100_000, END)).toEqual({ inTicks: 0, outTicks: 48_000 });
  });

  it('never crosses its own edges', () => {
    expect(dragLayerRange(range, 'in', 90_000, END).inTicks).toBe(91_200);
    expect(dragLayerRange(range, 'out', -90_000, END).outTicks).toBe(52_800);
  });

  it('keeps "to the end", and gives it back past the end', () => {
    expect(dragLayerRange({ inTicks: 0, outTicks: null }, 'move', 4800, END)).toEqual({ inTicks: 4800, outTicks: null });
    expect(dragLayerRange(range, 'out', END, END).outTicks).toBeNull();
    expect(dragLayerRange({ inTicks: 0, outTicks: null }, 'out', -4800, END).outTicks).toBe(END - 4800);
  });
});

describe('trimming the clip', () => {
  const clip = { leadInTicks: 96_000, clipInTicks: 48_000, clipOutTicks: 480_000, durationTicks: 960_000 };

  it('keeps the sound where it is on the timeline when the start is trimmed', () => {
    const trimmed = trimClip(clip, 'in', 24_000);
    expect(trimmed).toEqual({ leadInTicks: 120_000, clipInTicks: 72_000, clipOutTicks: 480_000 });
    // The same sample, at the same timeline time.
    expect(trimmed.leadInTicks - trimmed.clipInTicks).toBe(clip.leadInTicks - clip.clipInTicks);
  });

  it('stops at the start of the file and of the timeline', () => {
    expect(trimClip(clip, 'in', -500_000).clipInTicks).toBe(0);
    expect(trimClip({ ...clip, leadInTicks: 1000 }, 'in', -500_000)).toMatchObject({ leadInTicks: 0, clipInTicks: 47_000 });
  });

  it('never crosses the other edge', () => {
    expect(trimClip(clip, 'in', 900_000).clipInTicks).toBe(479_520);
    expect(trimClip(clip, 'out', -900_000).clipOutTicks).toBe(48_480);
  });

  it('gives "to the end of the file" back', () => {
    expect(trimClip(clip, 'out', 900_000).clipOutTicks).toBeNull();
    expect(trimClip({ ...clip, clipOutTicks: null }, 'out', -48_000).clipOutTicks).toBe(912_000);
  });
});
