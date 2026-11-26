// The node view's layout (C2): what is in the graph, what connects to what, and where it sits.

import { describe, expect, it } from 'vitest';

import { createBinding, createDocument, createEffect, createGroupLayer, createModuleLayer } from '../../src/project/create.ts';
import type { Layer, ProjectDocument } from '../../src/project/document.ts';
import { NODE_HEIGHT, NODE_WIDTH, edgePath, layoutGraph } from '../../src/project/node-graph.ts';

const schemas = (id: string) => (id === 'core.bars' ? { name: 'Bars', params: [{ key: 'glow', label: 'Glow', group: 'Look', type: 'float', default: 0, min: 0, max: 1 } as const] } : undefined);
const base = () => createDocument({ id: 'p', timestamp: 't' });

const bars = (id: string, extra: Partial<Layer> = {}) => ({ ...createModuleLayer('core.bars', { id }), ...extra }) as Layer;

const edgesBetween = (graph: ReturnType<typeof layoutGraph>) => graph.edges.map((edge) => `${edge.from} > ${edge.to}`);
const node = (graph: ReturnType<typeof layoutGraph>, id: string) => {
  const found = graph.nodes.find((n) => n.id === id);
  if (found === undefined) throw new Error(`no node ${id}`);
  return found;
};

describe('layoutGraph', () => {
  it('shows an empty project as its output alone', () => {
    const graph = layoutGraph(base(), schemas);
    expect(graph.nodes.map((n) => n.kind)).toEqual(['output']);
    expect(graph.edges).toEqual([]);
    expect(graph.width).toBeGreaterThan(NODE_WIDTH);
  });

  it('runs a layer through its effects into the output, left to right', () => {
    const document = { ...base(), layers: [bars('a', { effects: [createEffect('fx.one', { id: 'e1', name: 'Bloom' }), createEffect('fx.two', { id: 'e2' })] })] };
    const graph = layoutGraph(document, schemas);
    expect(edgesBetween(graph)).toEqual(['layer:a > effect:e1', 'effect:e1 > effect:e2', 'effect:e2 > output']);
    expect(node(graph, 'layer:a').x).toBeLessThan(node(graph, 'effect:e1').x);
    expect(node(graph, 'effect:e1').x).toBeLessThan(node(graph, 'effect:e2').x);
    expect(node(graph, 'effect:e2').x).toBeLessThan(node(graph, 'output').x);
    expect(node(graph, 'effect:e1').label).toBe('Bloom');
    expect(node(graph, 'effect:e2').label).toBe('fx.two');
    expect(node(graph, 'layer:a').label).toBe('Bars');
  });

  it('lists layers top first, as the layer list does', () => {
    const document = { ...base(), layers: [bars('under'), bars('over')] };
    const graph = layoutGraph(document, schemas);
    expect(node(graph, 'layer:over').y).toBeLessThan(node(graph, 'layer:under').y);
    expect(graph.nodes.filter((n) => n.kind === 'layer').every((n, _, all) => n.x === all[0]?.x)).toBe(true);
  });

  it('runs children into their group, left of it, and the group into the output', () => {
    const group = createGroupLayer([bars('child')], { id: 'g', name: 'Stack' });
    const graph = layoutGraph({ ...base(), layers: [group] }, schemas);
    expect(edgesBetween(graph)).toContain('layer:child > layer:g');
    expect(edgesBetween(graph)).toContain('layer:g > output');
    expect(node(graph, 'layer:child').x).toBeLessThan(node(graph, 'layer:g').x);
    expect(node(graph, 'layer:g')).toMatchObject({ kind: 'group', detail: '1 inside' });
  });

  it('runs every layer through the whole frame\'s effects before the output', () => {
    const document = { ...base(), layers: [bars('a'), bars('b')], globalEffects: [createEffect('fx.g', { id: 'g1' }), createEffect('fx.h', { id: 'g2' })] };
    const graph = layoutGraph(document, schemas);
    expect(edgesBetween(graph)).toEqual(expect.arrayContaining(['layer:a > effect:g1', 'layer:b > effect:g1', 'effect:g1 > effect:g2', 'effect:g2 > output']));
    expect(node(graph, 'effect:g1').layerId).toBeNull();
  });

  it('draws one source for many bindings, to the layer or the effect each one drives', () => {
    const fx = createEffect('fx.one', { id: 'e1' });
    const onLayer = createBinding('layers.a.params.glow', { id: 'b1', sourceType: 'rms' });
    const onEffect = createBinding('layers.a.effects.e1.params.amount', { id: 'b2', sourceType: 'rms' });
    const other = createBinding('layers.a.opacity', { id: 'b3', sourceType: 'onset' });
    const document = { ...base(), layers: [bars('a', { effects: [fx], modulations: [onLayer, onEffect, other] })] };
    const graph = layoutGraph(document, schemas);
    const sources = graph.nodes.filter((n) => n.kind === 'source');
    expect(sources.map((n) => n.label)).toEqual(['Loudness · mix', 'Onsets · mix']);
    expect(sources[0]?.x).toBeLessThan(node(graph, 'layer:a').x);
    expect(edgesBetween(graph)).toEqual(expect.arrayContaining(['source:0 > layer:a', 'source:0 > effect:e1', 'source:1 > layer:a']));
    expect(graph.edges.find((e) => e.id === 'b1')).toMatchObject({ kind: 'modulation', label: 'Glow' });
    expect(graph.unplaced).toBe(0);
  });

  it('counts a binding it cannot place, rather than leaving it out', () => {
    const lost = createBinding('layers.gone.params.glow', { id: 'b1' });
    const graph = layoutGraph({ ...base(), layers: [bars('a', { modulations: [lost] })] }, schemas);
    expect(graph.unplaced).toBe(1);
    expect(graph.nodes.some((n) => n.kind === 'source')).toBe(false);
  });

  it('places a binding on the whole frame\'s effects', () => {
    const document: ProjectDocument = {
      ...base(),
      globalEffects: [createEffect('fx.g', { id: 'g1' })],
      globalModulations: [createBinding('global.effects.g1.params.amount', { id: 'b1', sourceType: 'rms' })],
    };
    expect(edgesBetween(layoutGraph(document, schemas))).toContain('source:0 > effect:g1');
  });

  it('dims what is off, and what is inside a group that is off', () => {
    const hiddenGroup = { ...createGroupLayer([bars('child')], { id: 'g' }), enabled: false };
    const off = { ...createEffect('fx.one', { id: 'e1' }), enabled: false };
    const quiet = { ...createBinding('layers.a.params.glow', { id: 'b1', sourceType: 'rms' }), enabled: false };
    const graph = layoutGraph({ ...base(), layers: [hiddenGroup, bars('a', { effects: [off], modulations: [quiet] })] }, schemas);
    expect(node(graph, 'layer:child').dimmed).toBe(true);
    expect(node(graph, 'layer:a').dimmed).toBe(false);
    expect(node(graph, 'effect:e1').dimmed).toBe(true);
    expect(graph.edges.find((e) => e.id === 'b1')?.dimmed).toBe(true);
  });

  it('selects the layer a node belongs to, and nothing for a source', () => {
    const document = { ...base(), layers: [bars('a', { effects: [createEffect('fx.one', { id: 'e1' })], modulations: [createBinding('layers.a.opacity', { id: 'b1', sourceType: 'rms' })] })] };
    const graph = layoutGraph(document, schemas);
    expect(node(graph, 'layer:a').layerId).toBe('a');
    expect(node(graph, 'effect:e1').layerId).toBe('a');
    expect(node(graph, 'output').layerId).toBeNull();
    expect(graph.nodes.find((n) => n.kind === 'source')?.layerId).toBeUndefined();
  });

  it('never overlaps two nodes, and keeps them all inside its size', () => {
    const group = createGroupLayer([bars('c1', { effects: [createEffect('fx', { id: 'e1' }), createEffect('fx', { id: 'e2' })] }), bars('c2')], { id: 'g' });
    const bindings = Array.from({ length: 8 }, (_, i) => createBinding('layers.top.opacity', { id: `b${i}`, sourceType: `s${i}` }));
    const graph = layoutGraph({ ...base(), layers: [group, bars('top', { modulations: bindings })], globalEffects: [createEffect('fx', { id: 'g1' })] }, schemas);
    const seen = new Set(graph.nodes.map((n) => `${n.x},${n.y}`));
    expect(seen.size).toBe(graph.nodes.length);
    for (const n of graph.nodes) {
      expect(n.x + NODE_WIDTH).toBeLessThanOrEqual(graph.width);
      expect(n.y + NODE_HEIGHT).toBeLessThanOrEqual(graph.height);
    }
  });

  it('is the same every time', () => {
    const document = { ...base(), layers: [bars('a', { modulations: [createBinding('layers.a.opacity', { id: 'b1' })] })] };
    expect(layoutGraph(document, schemas)).toEqual(layoutGraph(document, schemas));
  });
});

describe('edgePath', () => {
  it('leaves the right edge and arrives at the left edge, at mid-height', () => {
    const graph = layoutGraph({ ...base(), layers: [bars('a')] }, schemas);
    const path = edgePath(node(graph, 'layer:a'), node(graph, 'output'));
    const { x, y } = node(graph, 'layer:a');
    expect(path.startsWith(`M ${x + NODE_WIDTH} ${y + NODE_HEIGHT / 2} C`)).toBe(true);
    expect(path.endsWith(`${node(graph, 'output').x} ${node(graph, 'output').y + NODE_HEIGHT / 2}`)).toBe(true);
  });
});
