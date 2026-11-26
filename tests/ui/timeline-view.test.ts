// The timeline's visible range: zoom around the pointer, pan, fit, follow the playhead.

import { describe, expect, it } from 'vitest';

import { clampView, fitView, follow, MIN_SPAN_SECONDS, panBy, zoomAt } from '../../src/ui/timeline-view.ts';

describe('timeline view', () => {
  it('zooms keeping the point under the pointer still, within one second and the whole track', () => {
    const view = zoomAt(fitView(100), 25, 0.5, 100);
    expect(view).toEqual({ start: 12.5, span: 50 });
    expect(zoomAt(view, 20, 0.0001, 100).span).toBe(MIN_SPAN_SECONDS);
    expect(zoomAt(view, 20, 10, 100)).toEqual({ start: 0, span: 100 });
  });

  it('pans within the track and pages to follow the playhead', () => {
    expect(panBy({ start: 10, span: 20 }, 100, 100)).toEqual({ start: 80, span: 20 });
    expect(panBy({ start: 10, span: 20 }, -100, 100)).toEqual({ start: 0, span: 20 });
    expect(follow({ start: 0, span: 20 }, 10, 100)).toEqual({ start: 0, span: 20 });
    expect(follow({ start: 0, span: 20 }, 30, 100)).toEqual({ start: 28, span: 20 });
    expect(clampView({ start: 5, span: 50 }, 10)).toEqual({ start: 0, span: 10 });
  });
});
