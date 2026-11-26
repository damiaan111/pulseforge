// The lyrics layer's layout as pure data (lyrics-spec §6.3): which lines are on screen, where and
// how visible, and how karaoke progress maps onto rasterised words.

import { describe, expect, it } from 'vitest';

import type { RenderLyricLine, RenderLyrics } from '../../src/engine/core/lyrics.ts';
import { TICKS_PER_SECOND } from '../../src/engine/core/time.ts';
import {
  layoutLyrics, lyricsManifest, rasterWordProgress, rowFronts, slotAlpha, stackOffsets, type LayoutOptions,
} from '../../src/engine/modules/lyrics.ts';

const T = (s: number) => Math.round(s * TICKS_PER_SECOND);
const line = (id: string, start: number, end: number, role = 'lead', text = id): RenderLyricLine => ({
  id, text, startTicks: T(start), endTicks: T(end), role, words: [], style: null,
});

const OPTIONS: LayoutOptions = {
  roles: 'all', lines: 2, nextOpacity: 0.5, advance: 'scroll', advanceSeconds: 0.4, leadIn: 0.5, holdOut: 0.3,
  backingScale: 0.7, backingOpacity: 0.75, adlibScale: 0.7, adlibOpacity: 0.85,
};

// a and b hand over (contiguous); c comes after a gap.
const lyrics: RenderLyrics = {
  lines: [line('a', 10, 12), line('b', 12, 14), line('c', 20, 22), line('ooh', 12.5, 13.5, 'backing')],
  untimedLines: 0,
};

const summary = (t: number, options: Partial<LayoutOptions> = {}) => layoutLyrics(lyrics, t, { ...OPTIONS, ...options }).map((d) => ({
  id: d.line.id,
  place: d.place.kind === 'slot' ? `slot ${d.place.slot.toFixed(2)}${d.place.state > 0 ? ` s${d.place.state}` : ''}` : `${d.place.role} ${d.place.stack}`,
  alpha: Number(d.alpha.toFixed(3)),
}));

describe('the lyric window', () => {
  it('shows nothing before the first lead-in', () => {
    expect(summary(9)).toEqual([]);
  });

  it('shows the current line and the next one dimmed', () => {
    expect(summary(10.5)).toEqual([
      { id: 'a', place: 'slot 0.00', alpha: 1 },
      { id: 'b', place: 'slot 1.00', alpha: 0.5 },
    ]);
  });

  it('scrolls on a hand-over: the old line rises and fades, the next comes up', () => {
    // b appears at 12 (a's end: a lead-in cannot overlap a). The 0.4 s scroll is centred on that
    // boundary — 11.8 to 12.2 — so b reaches the anchor as it starts being sung. Its midpoint:
    const mid = summary(12);
    expect(mid.filter((d) => d.place.startsWith('slot'))).toEqual([
      { id: 'a', place: 'slot -0.50', alpha: 0.5 },
      { id: 'b', place: 'slot 0.50', alpha: 0.75 },
      // The next preview (c) scrolls in at the bottom, fading in with the scroll.
      { id: 'c', place: 'slot 1.50', alpha: 0.25 },
    ]);
    expect(summary(13).filter((d) => d.place.startsWith('slot')).map((d) => d.id)).toEqual(['b', 'c']);
  });

  it('crossfades two whole windows instead, and cuts instantly', () => {
    const cross = summary(12, { advance: 'crossfade' });
    expect(cross.filter((d) => d.place.startsWith('slot'))).toEqual([
      { id: 'a', place: 'slot 0.00', alpha: 0.5 },
      { id: 'b', place: 'slot 1.00', alpha: 0.25 },
      { id: 'b', place: 'slot 0.00 s1', alpha: 0.5 },
      { id: 'c', place: 'slot 1.00 s1', alpha: 0.25 },
    ]);
    expect(summary(12.01, { advance: 'cut' }).filter((d) => d.place.startsWith('slot')).map((d) => [d.id, d.place])).toEqual([['b', 'slot 0.00'], ['c', 'slot 1.00']]);
  });

  it('places backing lines beside the lead, never in the sequence', () => {
    const at = summary(13);
    expect(at).toContainEqual({ id: 'ooh', place: 'backing 0', alpha: 0.75 });
    expect(summary(13, { roles: 'lead' }).map((d) => d.id)).not.toContain('ooh');
    // A layer showing only backing vocals makes them its own sequence.
    expect(summary(13, { roles: 'backing' })).toEqual([{ id: 'ooh', place: 'slot 0.00', alpha: 1 }]);
  });

  it('gives an entry animation after a gap and none on a hand-over', () => {
    const draws = layoutLyrics(lyrics, 19.8, OPTIONS);
    expect(draws[0]).toMatchObject({ enterAt: 19.5, exitAt: 22.3 });
    const handover = layoutLyrics(lyrics, 13, OPTIONS).find((d) => d.line.id === 'b');
    expect(handover).toMatchObject({ enterAt: null });
  });

  it('finishes the hand-over as the new line starts, and has not begun well before it', () => {
    expect(summary(12.2).filter((d) => d.place.startsWith('slot')).map((d) => d.place)).toEqual(['slot 0.00', 'slot 1.00']);
    expect(summary(11.7).filter((d) => d.place.startsWith('slot')).map((d) => [d.id, d.place])).toEqual([['a', 'slot 0.00'], ['b', 'slot 1.00']]);
  });

  it('is a pure function of t', () => {
    expect(summary(12.2)).toEqual(summary(12.2));
    const forward = [10.5, 12.2, 13, 19.8].map((t) => summary(t));
    const backward = [19.8, 13, 12.2, 10.5].map((t) => summary(t)).reverse();
    expect(forward).toEqual(backward);
  });
});

describe('stack geometry', () => {
  it('fades lines by slot, and in at the bottom while scrolling', () => {
    expect(slotAlpha(0, 2, 0.5)).toBe(1);
    expect(slotAlpha(1, 2, 0.5)).toBe(0.5);
    expect(slotAlpha(-0.25, 2, 0.5)).toBe(0.75);
    expect(slotAlpha(1.5, 2, 0.5)).toBe(0.25);
  });

  it('spaces lines by their heights and puts slot 0 on the anchor', () => {
    expect(stackOffsets([40, 60], [0, 1], 10)).toEqual([0, 20 + 10 + 30]);
    // Halfway through a scroll the anchor is halfway between the two lines.
    expect(stackOffsets([40, 40], [-0.5, 0.5], 10)).toEqual([-25, 25]);
  });
});

describe('karaoke progress on rasterised words', () => {
  // "go — now": the "—" is its own rasterised word but belongs to the token "go —".
  const text = 'go — now';
  const raster = {
    words: [
      { text: 'go', start: 0, line: 0, x: 0, y: 0, width: 20, height: 10 },
      { text: '—', start: 3, line: 0, x: 25, y: 0, width: 20, height: 10 },
      { text: 'now', start: 5, line: 0, x: 50, y: 0, width: 30, height: 10 },
    ],
  };
  const spans = [{ start: 0, end: 1 }, { start: 1, end: 2 }];

  it('fills a token across the rasterised words it covers', () => {
    expect([...rasterWordProgress(raster, text, spans, 0.25)]).toEqual([0.5, 0, 0]);
    expect([...rasterWordProgress(raster, text, spans, 0.75)]).toEqual([1, 0.5, 0]);
    expect([...rasterWordProgress(raster, text, spans, 1.5)]).toEqual([1, 1, 0.5]);
  });

  it('finds the sweep front per row', () => {
    const fronts = rowFronts(raster, Float32Array.from([1, 0.5, 0]));
    expect(fronts.get(0)).toBe(35);
    expect(rowFronts(raster, Float32Array.from([1, 1, 1])).get(0)).toBe(Infinity);
    expect(rowFronts(raster, Float32Array.from([0, 0, 0])).get(0)).toBe(-Infinity);
  });
});

describe('the manifest', () => {
  it('offers every karaoke fill mode of lyrics-spec §6.1', () => {
    const fill = lyricsManifest.params.find((p) => p.key === 'fill');
    expect(fill?.type === 'enum' ? fill.options.map((o) => o.value) : []).toEqual(['wipe', 'wordSwap', 'wordPop', 'fillStroke', 'gradientSweep', 'bouncingBall', 'none']);
  });
});
