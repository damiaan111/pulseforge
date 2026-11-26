// The preview's render size (S18): the quality scale, and in draft a fixed 640 px long side.

import { describe, expect, it } from 'vitest';

import { previewRenderSize, previewScaleFor } from '../../src/ui/preview/render-size.ts';

describe('previewRenderSize', () => {
  it('scales, keeping dimensions even', () => {
    expect(previewRenderSize({ width: 1920, height: 1080 }, 1, false)).toEqual({ width: 1920, height: 1080 });
    expect(previewRenderSize({ width: 1920, height: 1080 }, 0.5, false)).toEqual({ width: 960, height: 540 });
  });

  it('draft caps the long side at 640, in either orientation, and never enlarges', () => {
    expect(previewRenderSize({ width: 3840, height: 2160 }, 1, true)).toEqual({ width: 640, height: 360 });
    expect(previewRenderSize({ width: 1080, height: 1920 }, 1, true)).toEqual({ width: 360, height: 640 });
    // Already smaller than the cap: the quality scale stands.
    expect(previewRenderSize({ width: 1920, height: 1080 }, 0.25, true)).toEqual({ width: 480, height: 270 });
    expect(previewScaleFor({ width: 640, height: 360 }, 1, true)).toBe(1);
  });
});
