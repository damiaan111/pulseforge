import { describe, expect, it } from 'vitest';

import { extendSelection } from '../../src/ui/layer-selection.ts';
import { dragLayersTogether } from '../../src/ui/timeline-drag.ts';

const order = ['a', 'b', 'c', 'd'];

describe('selecting several layers', () => {
  it('Ctrl adds a layer and makes it the one the inspector shows', () => {
    expect(extendSelection({ primary: 'a', ids: ['a'] }, 'c', 'toggle', order)).toEqual({ primary: 'c', ids: ['a', 'c'] });
  });

  it('Ctrl on a selected layer takes it out, and the inspector falls back', () => {
    expect(extendSelection({ primary: 'c', ids: ['a', 'c'] }, 'c', 'toggle', order)).toEqual({ primary: 'a', ids: ['a'] });
    expect(extendSelection({ primary: 'a', ids: ['a'] }, 'a', 'toggle', order)).toEqual({ primary: null, ids: [] });
  });

  it('Shift takes the range, either way, and keeps its anchor', () => {
    expect(extendSelection({ primary: 'b', ids: ['b'] }, 'd', 'range', order)).toEqual({ primary: 'b', ids: ['b', 'c', 'd'] });
    expect(extendSelection({ primary: 'b', ids: ['b', 'c', 'd'] }, 'a', 'range', order)).toEqual({ primary: 'b', ids: ['a', 'b'] });
  });

  it('Shift with nothing to anchor to selects the one layer', () => {
    expect(extendSelection({ primary: null, ids: [] }, 'c', 'range', order)).toEqual({ primary: 'c', ids: ['c'] });
  });
});

describe('dragging several layers', () => {
  const layers = [{ inTicks: 1000, outTicks: 5000 }, { inTicks: 3000, outTicks: null }];

  it('moves them by the same amount', () => {
    expect(dragLayersTogether(layers, 500, 96_000)).toEqual([{ inTicks: 1500, outTicks: 5500 }, { inTicks: 3500, outTicks: null }]);
  });

  it('stops all of them when the earliest reaches zero, keeping the gap between them', () => {
    expect(dragLayersTogether(layers, -5000, 96_000)).toEqual([{ inTicks: 0, outTicks: 4000 }, { inTicks: 2000, outTicks: null }]);
  });
});
