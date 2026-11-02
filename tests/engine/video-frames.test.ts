// Frame mapping for video layers (M39): which still of the extracted sequence belongs on a
// timeline frame. Pure, so it is checked exhaustively here rather than by eye on the GPU.

import { describe, expect, it } from 'vitest';

import { videoSourceFrame } from '../../src/engine/core/video.ts';
import { videoPlayback } from '../../src/engine/modules/video.ts';
import { videoRequests } from '../../src/video/frame-feeder.ts';
import type { RenderProject } from '../../src/engine/core/project.ts';
import { rational } from '../../src/engine/core/time.ts';

const base = { frameIndex: 0, inFrame: 0, startFrame: 0, speed: 1, loop: true, frameCount: 100 };

describe('videoSourceFrame', () => {
  it('advances one source frame per timeline frame at speed 1', () => {
    expect(videoSourceFrame({ ...base, frameIndex: 0 })).toBe(0);
    expect(videoSourceFrame({ ...base, frameIndex: 37 })).toBe(37);
  });

  it('counts from the layer’s in point, and never before it', () => {
    expect(videoSourceFrame({ ...base, inFrame: 30, frameIndex: 30 })).toBe(0);
    expect(videoSourceFrame({ ...base, inFrame: 30, frameIndex: 42 })).toBe(12);
    expect(videoSourceFrame({ ...base, inFrame: 30, frameIndex: 5 })).toBe(0);
  });

  it('trims with startFrame, clamped into the sequence', () => {
    expect(videoSourceFrame({ ...base, startFrame: 20, frameIndex: 5 })).toBe(25);
    expect(videoSourceFrame({ ...base, startFrame: 500, frameIndex: 0 })).toBe(99);
  });

  it('floors the speed so a frame shows from the moment it begins', () => {
    expect(videoSourceFrame({ ...base, speed: 2, frameIndex: 10 })).toBe(20);
    expect(videoSourceFrame({ ...base, speed: 0.5, frameIndex: 5 })).toBe(2);
    expect(videoSourceFrame({ ...base, speed: 0.5, frameIndex: 6 })).toBe(3);
  });

  it('loops past the end, or parks on the last frame when looping is off', () => {
    expect(videoSourceFrame({ ...base, frameIndex: 100 })).toBe(0);
    expect(videoSourceFrame({ ...base, frameIndex: 143 })).toBe(43);
    expect(videoSourceFrame({ ...base, loop: false, frameIndex: 143 })).toBe(99);
  });

  it('survives an empty sequence rather than dividing by it', () => {
    expect(videoSourceFrame({ ...base, frameCount: 0, frameIndex: 10 })).toBe(0);
  });

  it('is a pure function of the frame index — scrubbing equals playing', () => {
    const forwards = Array.from({ length: 50 }, (_, i) => videoSourceFrame({ ...base, speed: 1.3, frameIndex: i }));
    const scrubbed = [49, 3, 20, 0].map((i) => videoSourceFrame({ ...base, speed: 1.3, frameIndex: i }));
    expect(scrubbed).toEqual([forwards[49], forwards[3], forwards[20], forwards[0]]);
  });
});

describe('videoPlayback defaults', () => {
  it('fills in and clamps what the document does not say', () => {
    expect(videoPlayback({}, rational(30))).toEqual({ speed: 1, loop: true, startFrame: 0 });
    expect(videoPlayback({ speed: 99, loop: false, startSeconds: 2 }, rational(30)))
      .toEqual({ speed: 4, loop: false, startFrame: 60 });
    expect(videoPlayback({ speed: 'fast' }, rational(30)).speed).toBe(1);
  });
});

describe('videoRequests', () => {
  const clip = (params: Record<string, unknown>, id = 'v1') => ({
    id, module: 'core.source.video', enabled: true, opacity: 1, blend: 'normal' as const, params,
  });
  const project = (layers: RenderProject['layers']): RenderProject => ({
    schemaVersion: 0,
    seed: 1,
    canvas: { width: 100, height: 100, fps: rational(30), background: '#000000' },
    audio: { leadInTicks: 0, clipInTicks: 0 },
    layers,
    assets: { a1: { kind: 'video', hash: 'h1', name: 'a.mp4' }, a2: { kind: 'video', hash: 'h2', name: 'b.mp4' } },
  });
  const counts = () => 100;

  it('asks for one frame per clip, de-duplicated, groups included', () => {
    const requests = videoRequests(project([
      clip({ video: 'a1' }),
      clip({ video: 'a1' }, 'v2'), // the same clip at the same moment: one decode
      { kind: 'group', id: 'g', enabled: true, opacity: 1, blend: 'normal', children: [clip({ video: 'a2' }, 'v3')] },
    ]), 10, counts);
    expect(requests).toEqual([{ hash: 'h1', sourceFrame: 10 }, { hash: 'h2', sourceFrame: 10 }]);
  });

  it('skips disabled layers, layers without a clip, and unknown assets', () => {
    const requests = videoRequests(project([
      { ...clip({ video: 'a1' }), enabled: false },
      clip({ video: '' }, 'v2'),
      clip({ video: 'nope' }, 'v3'),
      { id: 'bars', module: 'core.visualizer.bars', enabled: true, opacity: 1, blend: 'normal', params: {} },
    ]), 4, counts);
    expect(requests).toEqual([]);
  });

  it('applies each layer’s own trim and speed', () => {
    const requests = videoRequests(project([clip({ video: 'a1', startSeconds: 1, speed: 2 })]), 10, counts);
    expect(requests).toEqual([{ hash: 'h1', sourceFrame: 50 }]); // 30 + 10×2
  });
});
