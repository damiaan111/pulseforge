// Document → engine snapshot (toRenderProject).
//
// The load-bearing property here is honesty: anything the document asks for that this build's
// engine cannot yet draw comes back as a note. A silent omission would look like a bug in the
// module, and would be chased there.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { layerIsLive } from '../../src/engine/core/project.ts';
import { createDocument, createGroupLayer, createModuleLayer } from '../../src/project/create.ts';
import { loadDocument } from '../../src/project/load.ts';
import { timelineDurationTicks, toRenderProject } from '../../src/project/snapshot.ts';

const fixtureDocument = () =>
  loadDocument(readFileSync(fileURLToPath(new URL('./fixtures/v1-full.pvproj', import.meta.url)), 'utf8')).document;

const layer = (id: string, options = {}) => createModuleLayer('core.visualizer.bars', { id, ...options });

describe('toRenderProject', () => {
  it('flattens groups into the engine layer list, bottom to top', () => {
    const document = {
      ...createDocument({ timestamp: '2026-09-14T00:00:00.000Z' }),
      layers: [
        layer('0000000000K000000000000001'),
        createGroupLayer([layer('0000000000K000000000000002'), layer('0000000000K000000000000003')], {
          id: '0000000000G000000000000001',
        }),
      ],
    };
    const { project } = toRenderProject(document);
    expect(project.layers.map((l) => l.id)).toEqual([
      '0000000000K000000000000001',
      '0000000000K000000000000002',
      '0000000000K000000000000003',
    ]);
  });

  it('hides the children of a disabled group', () => {
    const child = layer('0000000000K000000000000002');
    const group = { ...createGroupLayer([child], { id: '0000000000G000000000000001' }), enabled: false };
    const document = { ...createDocument({ timestamp: '2026-09-14T00:00:00.000Z' }), layers: [group] };
    expect(toRenderProject(document).project.layers[0]?.enabled).toBe(false);
  });

  it('renders only soloed layers when anything is soloed', () => {
    const document = {
      ...createDocument({ timestamp: '2026-09-14T00:00:00.000Z' }),
      layers: [
        layer('0000000000K000000000000001'),
        { ...layer('0000000000K000000000000002'), soloed: true },
      ],
    };
    const enabled = toRenderProject(document).project.layers.map((l) => l.enabled);
    expect(enabled).toEqual([false, true]);
  });

  it('carries time ranges into the snapshot', () => {
    const document = {
      ...createDocument({ timestamp: '2026-09-14T00:00:00.000Z' }),
      layers: [layer('0000000000K000000000000001', { timeRange: { inTicks: 48_000, outTicks: 96_000 } })],
    };
    expect(toRenderProject(document).project.layers[0]?.timeRange).toEqual({ inTicks: 48_000, outTicks: 96_000 });
  });

  it('notes every feature the engine cannot yet render, instead of dropping it', () => {
    const { notes } = toRenderProject(fixtureDocument());
    const text = notes.map((n) => n.detail).join('\n');
    expect(text).toContain('effect(s) are not yet applied');
  });

  it('carries modulation bindings and the timeline duration into the snapshot', () => {
    const { project } = toRenderProject(fixtureDocument());
    const bindings = project.layers[0]?.modulations;
    expect(bindings).toHaveLength(1);
    expect(bindings?.[0]).toMatchObject({
      id: '0000000000M000000000000001',
      target: 'layers.0000000000K000000000000001.params.glow',
      source: { type: 'onset', stem: 'drums' },
      mode: 'add',
    });
    // The evaluator needs the duration for `progress`, `ramp` and auto-calibration.
    expect(project.durationTicks).toBe(timelineDurationTicks(fixtureDocument()));
  });

  it('carries the layer transform through, with the aspect override applied', () => {
    // The fixture's bars layer sits at y 0.75, anchored bottom-centre, and overrides y to
    // 0.62 in vertical — the whole point of per-aspect overrides (PROJECT.md §8.11).
    const landscape = fixtureDocument();
    const inLandscape = toRenderProject(landscape);
    expect(inLandscape.aspect).toBe('16:9');
    expect(inLandscape.project.layers[0]?.transform).toMatchObject({ y: 0.75, anchor: 'bottom-center', scaleReference: 'width' });

    const vertical = { ...landscape, canvas: { ...landscape.canvas, width: 1080, height: 1920 } };
    const inVertical = toRenderProject(vertical);
    expect(inVertical.aspect).toBe('9:16');
    // Only the overridden property changes; everything else still inherits the base.
    expect(inVertical.project.layers[0]?.transform).toMatchObject({ y: 0.62, anchor: 'bottom-center', scaleReference: 'width' });
  });

  it('applies overridden params over the base params, leaving the rest alone', () => {
    const vertical = (() => {
      const d = fixtureDocument();
      return { ...d, canvas: { ...d.canvas, width: 1080, height: 1920 } };
    })();
    const params = toRenderProject(vertical).project.layers[0]?.params;
    expect(params).toMatchObject({ barCount: 24, source: 'drums', glow: 0.4 });
    expect(toRenderProject(fixtureDocument()).project.layers[0]?.params).toMatchObject({ barCount: 64 });
  });

  it('notes a group transform, which does not yet compose onto its children', () => {
    const child = layer('0000000000K000000000000002');
    const group = createGroupLayer([child], { id: '0000000000G000000000000001', transform: { x: 0.25 } });
    const document = { ...createDocument({ timestamp: '2026-09-14T00:00:00.000Z' }), layers: [group] };
    const text = toRenderProject(document).notes.map((n) => n.detail).join('\n');
    expect(text).toContain('group compositing (M38) is not implemented');
    expect(text).toContain('do not yet compose onto their children');
  });

  it('falls back on a blend mode the compositor lacks, and says which', () => {
    const document = {
      ...createDocument({ timestamp: '2026-09-14T00:00:00.000Z' }),
      layers: [{ ...layer('0000000000K000000000000001'), blend: 'overlay' as const }],
    };
    const { project, notes } = toRenderProject(document);
    expect(project.layers[0]?.blend).toBe('normal');
    expect(notes.some((n) => n.detail.includes('"overlay"'))).toBe(true);
  });

  it('produces no notes for a project made only of what the engine implements', () => {
    const document = {
      ...createDocument({ timestamp: '2026-09-14T00:00:00.000Z' }),
      layers: [layer('0000000000K000000000000001', { blend: 'add' as const, opacity: 0.5 })],
    };
    expect(toRenderProject(document).notes).toEqual([]);
  });

  it('reports the aspect bucket the canvas falls into', () => {
    const document = createDocument({ timestamp: '2026-09-14T00:00:00.000Z', canvas: { width: 1080, height: 1920 } });
    expect(toRenderProject(document).aspect).toBe('9:16');
  });

  it('passes the seed, canvas and audio placement straight through', () => {
    const document = fixtureDocument();
    const { project } = toRenderProject(document);
    expect(project.seed).toBe(1337);
    expect(project.canvas).toEqual({ width: 1920, height: 1080, fps: { num: 60, den: 1 }, background: '#050510' });
    expect(project.audio).toEqual({ leadInTicks: 96_000, clipInTicks: 48_000 });
  });
});

describe('timelineDurationTicks', () => {
  it('is lead-in + clip + lead-out, not the layer extents', () => {
    const document = createDocument({
      timestamp: '2026-09-14T00:00:00.000Z',
      audio: { durationTicks: 480_000, leadInTicks: 48_000, leadOutTicks: 96_000, clipInTicks: 24_000, clipOutTicks: 240_000 },
    });
    expect(timelineDurationTicks(document)).toBe(48_000 + (240_000 - 24_000) + 96_000);
  });

  it('runs to the end of the file when there is no clip-out', () => {
    const document = createDocument({
      timestamp: '2026-09-14T00:00:00.000Z',
      audio: { durationTicks: 480_000, clipInTicks: 48_000 },
    });
    expect(timelineDurationTicks(document)).toBe(432_000);
  });
});

describe('layerIsLive', () => {
  it('is half-open: a layer ending at tick N is gone on the frame starting at N', () => {
    const range = { inTicks: 100, outTicks: 200 };
    expect(layerIsLive(range, 99)).toBe(false);
    expect(layerIsLive(range, 100)).toBe(true);
    expect(layerIsLive(range, 199)).toBe(true);
    expect(layerIsLive(range, 200)).toBe(false);
  });

  it('treats a null out point as running to the end, and no range as always', () => {
    expect(layerIsLive({ inTicks: 100, outTicks: null }, 10_000_000)).toBe(true);
    expect(layerIsLive(undefined, 0)).toBe(true);
  });
});
