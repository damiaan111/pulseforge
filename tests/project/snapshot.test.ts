// Document → engine snapshot (toRenderProject).
//
// The load-bearing property here is honesty: anything the document asks for that this build's
// engine cannot yet draw comes back as a note. A silent omission would look like a bug in the
// module, and would be chased there.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  isGroupSpec, layerIsLive, walkRenderLayers, walkRenderModules, type RenderProject,
} from '../../src/engine/core/project.ts';
import { createDocument, createEffect, createGroupLayer, createModuleLayer } from '../../src/project/create.ts';
import { loadDocument } from '../../src/project/load.ts';
import { timelineDurationTicks, toRenderProject } from '../../src/project/snapshot.ts';

const fixtureDocument = () =>
  loadDocument(readFileSync(fileURLToPath(new URL('./fixtures/v1-full.pvproj', import.meta.url)), 'utf8')).document;

const layer = (id: string, options = {}) => createModuleLayer('core.visualizer.bars', { id, ...options });
/** Module layers anywhere in the tree — most checks here are about a module's own resolution. */
const modules = (project: RenderProject) => [...walkRenderModules(project.layers)];

describe('toRenderProject', () => {
  it('keeps groups as groups, so the engine can composite them (M38)', () => {
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
    expect(project.layers.map((l) => l.id)).toEqual(['0000000000K000000000000001', '0000000000G000000000000001']);
    const group = project.layers[1]!;
    expect(isGroupSpec(group)).toBe(true);
    expect(isGroupSpec(group) ? group.children.map((c) => c.id) : []).toEqual([
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

  it('keeps a group alive when one of its children is soloed', () => {
    const document = {
      ...createDocument({ timestamp: '2026-09-14T00:00:00.000Z' }),
      layers: [
        layer('0000000000K000000000000001'),
        createGroupLayer(
          [layer('0000000000K000000000000002'), { ...layer('0000000000K000000000000003'), soloed: true }],
          { id: '0000000000G000000000000001' },
        ),
      ],
    };
    const { project } = toRenderProject(document);
    const group = project.layers[1]!;
    expect(project.layers[0]?.enabled).toBe(false);
    expect(group.enabled).toBe(true); // it has to draw, or the soloed child cannot be seen
    expect(isGroupSpec(group) ? group.children.map((c) => c.enabled) : []).toEqual([false, true]);
  });

  it('carries time ranges into the snapshot', () => {
    const document = {
      ...createDocument({ timestamp: '2026-09-14T00:00:00.000Z' }),
      layers: [layer('0000000000K000000000000001', { timeRange: { inTicks: 48_000, outTicks: 96_000 } })],
    };
    expect(toRenderProject(document).project.layers[0]?.timeRange).toEqual({ inTicks: 48_000, outTicks: 96_000 });
  });

  it('carries the layer effect chain into the snapshot', () => {
    const effects = modules(toRenderProject(fixtureDocument()).project)[0]?.effects;
    expect(effects).toEqual([{
      id: '0000000000E000000000000001',
      module: 'core.effect.bloom',
      enabled: true,
      params: { threshold: 0.8, intensity: 1.2 },
    }]);
  });

  it('notes what the engine still cannot render, instead of dropping it', () => {
    const document = fixtureDocument();
    const masked = {
      ...document,
      layers: [{ ...document.layers[0]!, maskLayerId: '0000000000K000000000000002' }, ...document.layers.slice(1)],
    };
    const text = toRenderProject(masked).notes.map((n) => n.detail).join('\n');
    expect(text).toContain('masking (S7) is not implemented');
  });

  it('carries modulation bindings and the timeline duration into the snapshot', () => {
    const { project } = toRenderProject(fixtureDocument());
    const bindings = modules(project)[0]?.modulations;
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
    expect(modules(inLandscape.project)[0]?.transform).toMatchObject({ y: 0.75, anchor: 'bottom-center', scaleReference: 'width' });

    const vertical = { ...landscape, canvas: { ...landscape.canvas, width: 1080, height: 1920 } };
    const inVertical = toRenderProject(vertical);
    expect(inVertical.aspect).toBe('9:16');
    // Only the overridden property changes; everything else still inherits the base.
    expect(modules(inVertical.project)[0]?.transform).toMatchObject({ y: 0.62, anchor: 'bottom-center', scaleReference: 'width' });
  });

  it('applies overridden params over the base params, leaving the rest alone', () => {
    const vertical = (() => {
      const d = fixtureDocument();
      return { ...d, canvas: { ...d.canvas, width: 1080, height: 1920 } };
    })();
    const params = modules(toRenderProject(vertical).project)[0]?.params;
    expect(params).toMatchObject({ barCount: 24, source: 'drums', glow: 0.4 });
    expect(modules(toRenderProject(fixtureDocument()).project)[0]?.params).toMatchObject({ barCount: 64 });
  });

  it('carries a group transform, opacity, blend and effects to the engine (M38)', () => {
    const child = layer('0000000000K000000000000002');
    const group = {
      ...createGroupLayer([child], { id: '0000000000G000000000000001', transform: { x: 0.25 }, opacity: 0.5, blend: 'add' as const }),
      effects: [createEffect('core.effect.bloom', { id: '0000000000E000000000000009' })],
    };
    const document = { ...createDocument({ timestamp: '2026-09-14T00:00:00.000Z' }), layers: [group] };
    const { project, notes } = toRenderProject(document);
    const spec = project.layers[0]!;
    expect(spec.transform).toMatchObject({ x: 0.25 });
    expect(spec.opacity).toBe(0.5);
    expect(spec.blend).toBe('add');
    expect(spec.effects?.[0]?.module).toBe('core.effect.bloom');
    expect(notes.map((n) => n.detail).join(' ')).not.toContain('M38');
  });

  it('falls back on a blend mode the compositor lacks, and says which', () => {
    // `hue` is a spec'd mode (compositor-spec §3) this build does not draw yet — as a file from a
    // later build might name it.
    const document = {
      ...createDocument({ timestamp: '2026-09-14T00:00:00.000Z' }),
      layers: [{ ...layer('0000000000K000000000000001'), blend: 'hue' as unknown as 'normal' }],
    };
    const { project, notes } = toRenderProject(document);
    expect(project.layers[0]?.blend).toBe('normal');
    expect(notes.some((n) => n.detail.includes('"hue"'))).toBe(true);
  });

  it('passes the separable blend modes through to the compositor', () => {
    const document = {
      ...createDocument({ timestamp: '2026-09-14T00:00:00.000Z' }),
      layers: [{ ...layer('0000000000K000000000000001'), blend: 'overlay' as const }],
    };
    const { project, notes } = toRenderProject(document);
    expect(project.layers[0]?.blend).toBe('overlay');
    expect(notes).toEqual([]);
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

describe('groups clip and solo their children', () => {
  const doc = (layers: ReturnType<typeof createGroupLayer>[]) => ({
    ...createDocument({ timestamp: '2026-09-14T00:00:00.000Z' }),
    layers,
  });

  it('keeps the group’s range and the child’s as written; the engine applies both (M38)', () => {
    // A group scoped to a section still scopes everything inside it — but the engine does that
    // by skipping the whole subtree when the group is not live, so the snapshot no longer has to
    // fold the parent's bounds into each child (and could not, now that groups render as one).
    const child = layer('0000000000K000000000000001', { timeRange: { inTicks: 60_000, outTicks: 200_000 } });
    const group = createGroupLayer([child], {
      id: '0000000000G000000000000001',
      timeRange: { inTicks: 48_000, outTicks: 96_000 },
    });
    const { project } = toRenderProject(doc([group]));
    const spec = project.layers[0]!;
    expect(spec.timeRange).toEqual({ inTicks: 48_000, outTicks: 96_000 });
    expect(isGroupSpec(spec) ? spec.children[0]?.timeRange : undefined).toEqual({ inTicks: 60_000, outTicks: 200_000 });
  });

  it('nests, each level keeping its own range', () => {
    const child = layer('0000000000K000000000000001');
    const inner = createGroupLayer([child], {
      id: '0000000000G000000000000002',
      timeRange: { inTicks: 0, outTicks: 150_000 },
    });
    const outer = createGroupLayer([inner], {
      id: '0000000000G000000000000001',
      timeRange: { inTicks: 48_000, outTicks: null },
    });
    const { project } = toRenderProject(doc([outer]));
    const outerSpec = project.layers[0]!;
    expect(outerSpec.timeRange).toEqual({ inTicks: 48_000, outTicks: null });
    const innerSpec = isGroupSpec(outerSpec) ? outerSpec.children[0]! : undefined;
    expect(innerSpec?.timeRange).toEqual({ inTicks: 0, outTicks: 150_000 });
  });

  it('soloing a group shows its children, not nothing', () => {
    // Without this, solo on a group hides everything it contains — the opposite of what solo means.
    const child = layer('0000000000K000000000000001');
    const group = { ...createGroupLayer([child], { id: '0000000000G000000000000001' }), soloed: true };
    const other = layer('0000000000K000000000000002');
    const { project } = toRenderProject(doc([group, other as never]));
    const all = [...walkRenderLayers(project.layers)];
    expect(all.find((l) => l.id === '0000000000K000000000000001')!.enabled).toBe(true);
    expect(all.find((l) => l.id === '0000000000K000000000000002')!.enabled).toBe(false);
  });
});
