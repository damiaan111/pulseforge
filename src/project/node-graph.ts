// The node view (C2): the project as a graph, for looking at. Sources on the left drive what they
// modulate; each layer runs through its effects into its group or the whole frame; the whole
// frame's effects run into the output. Read-only: every edit stays in the layer list and inspector.
//
// Pure and deterministic, so the picture is a function of the document and the layout is tested.
// Rows follow the layer list (top first); columns follow the signal.

import { GLOBAL_OWNER } from './commands.ts';
import { walkLayers, type EffectSpec, type Layer, type ProjectDocument } from './document.ts';
import { displayOrder } from './layer-order.ts';
import { allBindings, describeSource, describeTarget, parseTarget, type SchemaLookup } from './modulation-authoring.ts';

export const NODE_WIDTH = 150;
export const NODE_HEIGHT = 40;
const COLUMN_GAP = 56;
const ROW_GAP = 16;
const MARGIN = 12;

export type GraphNodeKind = 'source' | 'layer' | 'group' | 'effect' | 'output';

export interface GraphNode {
  readonly id: string;
  readonly kind: GraphNodeKind;
  readonly label: string;
  /** The module, or the kind of thing it is, in small print. */
  readonly detail: string;
  /** The layer a click selects: null for the whole frame, undefined for what selects nothing. */
  readonly layerId: string | null | undefined;
  /** Hidden, switched off or inside something that is. */
  readonly dimmed: boolean;
  readonly x: number;
  readonly y: number;
}

export interface GraphEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly kind: 'signal' | 'modulation';
  /** A modulation's parameter. */
  readonly label: string;
  readonly dimmed: boolean;
}

export interface NodeGraph {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly width: number;
  readonly height: number;
  /** Bindings whose target is not in the graph: shown as a count, not left out in silence. */
  readonly unplaced: number;
}

const OUTPUT_ID = 'output';
const layerNodeId = (id: string) => `layer:${id}`;
const effectNodeId = (id: string) => `effect:${id}`;

const columnX = (column: number) => MARGIN + column * (NODE_WIDTH + COLUMN_GAP);
const rowY = (row: number) => MARGIN + row * (NODE_HEIGHT + ROW_GAP);

function layerLabel(layer: Layer, schemas: SchemaLookup): string {
  if (layer.name !== '') return layer.name;
  return layer.kind === 'group' ? 'Group' : schemas(layer.module)?.name ?? layer.module;
}

function effectLabel(effect: EffectSpec, schemas: SchemaLookup): string {
  return effect.name !== '' ? effect.name : schemas(effect.module)?.name ?? effect.module;
}

/** The project as nodes at positions, and the edges between them. */
export function layoutGraph(document: ProjectDocument, schemas: SchemaLookup): NodeGraph {
  const rows = displayOrder(document.layers);
  const deepest = rows.reduce((most, { depth }) => Math.max(most, depth), 0);
  const longestChain = rows.reduce((most, { layer }) => Math.max(most, layer.effects.length), 0);
  const parentOf = new Map<string, string>();
  const hiddenByParent = new Set<string>();
  for (const { layer, parents } of walkLayers(document.layers)) {
    const parent = parents[parents.length - 1];
    if (parent !== undefined) parentOf.set(layer.id, parent.id);
    if (parents.some((p) => !p.enabled)) hiddenByParent.add(layer.id);
  }

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  // Children sit left of their group, so everything flows one way.
  const firstLayerColumn = 1;
  const firstGlobalColumn = firstLayerColumn + deepest + 1 + longestChain;
  const outputColumn = firstGlobalColumn + document.globalEffects.length;

  rows.forEach(({ layer, depth }, row) => {
    const column = firstLayerColumn + (deepest - depth);
    const dimmed = !layer.enabled || hiddenByParent.has(layer.id);
    const id = layerNodeId(layer.id);
    nodes.push({
      id,
      kind: layer.kind === 'group' ? 'group' : 'layer',
      label: layerLabel(layer, schemas),
      detail: layer.kind === 'group' ? `${layer.children.length} inside` : schemas(layer.module)?.name ?? layer.module,
      layerId: layer.id,
      dimmed,
      x: columnX(column),
      y: rowY(row),
    });
    let previous = id;
    layer.effects.forEach((effect, i) => {
      const effectId = effectNodeId(effect.id);
      nodes.push({ id: effectId, kind: 'effect', label: effectLabel(effect, schemas), detail: 'effect', layerId: layer.id, dimmed: dimmed || !effect.enabled, x: columnX(column + 1 + i), y: rowY(row) });
      edges.push({ id: `${previous}>${effectId}`, from: previous, to: effectId, kind: 'signal', label: '', dimmed: dimmed || !effect.enabled });
      previous = effectId;
    });
    const parent = parentOf.get(layer.id);
    const next = parent !== undefined ? layerNodeId(parent) : document.globalEffects[0] !== undefined ? effectNodeId(document.globalEffects[0].id) : OUTPUT_ID;
    edges.push({ id: `${previous}>${next}`, from: previous, to: next, kind: 'signal', label: '', dimmed });
  });

  // The whole frame's chain and the output sit level with the middle of the list.
  const rowCount = Math.max(1, rows.length);
  const middle = Math.floor((rowCount - 1) / 2);
  document.globalEffects.forEach((effect, i) => {
    const effectId = effectNodeId(effect.id);
    nodes.push({ id: effectId, kind: 'effect', label: effectLabel(effect, schemas), detail: 'whole frame', layerId: null, dimmed: !effect.enabled, x: columnX(firstGlobalColumn + i), y: rowY(middle) });
    const after = document.globalEffects[i + 1];
    const next = after === undefined ? OUTPUT_ID : effectNodeId(after.id);
    edges.push({ id: `${effectId}>${next}`, from: effectId, to: next, kind: 'signal', label: '', dimmed: !effect.enabled });
  });
  nodes.push({ id: OUTPUT_ID, kind: 'output', label: 'Output', detail: `${document.canvas.width}×${document.canvas.height}`, layerId: null, dimmed: false, x: columnX(outputColumn), y: rowY(middle) });

  // One node per distinct source, in first-use order: "Onsets · drums" driving five things is one
  // thing driving five, which is what this view is for.
  const present = new Set(nodes.map((node) => node.id));
  const sources = new Map<string, string>();
  let unplaced = 0;
  for (const { binding } of allBindings(document)) {
    const path = parseTarget(binding.target);
    const to = path === undefined
      ? undefined
      : path.effectId !== null
        ? effectNodeId(path.effectId)
        : path.layerId === GLOBAL_OWNER ? undefined : layerNodeId(path.layerId);
    if (to === undefined || !present.has(to)) {
      unplaced += 1;
      continue;
    }
    const name = describeSource(binding);
    let from = sources.get(name);
    if (from === undefined) {
      from = `source:${sources.size}`;
      sources.set(name, from);
    }
    const label = describeTarget(document, binding.target, schemas).label.split(' › ').pop() ?? path?.key ?? '';
    edges.push({ id: `${binding.id}`, from, to, kind: 'modulation', label, dimmed: !binding.enabled });
  }
  [...sources].forEach(([name, id], row) => {
    nodes.push({ id, kind: 'source', label: name, detail: 'source', layerId: undefined, dimmed: false, x: columnX(0), y: rowY(row) });
  });

  const lastRow = Math.max(rowCount, sources.size) - 1;
  return {
    nodes,
    edges,
    width: columnX(outputColumn) + NODE_WIDTH + MARGIN,
    height: rowY(lastRow) + NODE_HEIGHT + MARGIN,
    unplaced,
  };
}

/** The curve between two nodes, right edge to left edge, for an SVG path. */
export function edgePath(from: GraphNode, to: GraphNode): string {
  const x1 = from.x + NODE_WIDTH;
  const y1 = from.y + NODE_HEIGHT / 2;
  const x2 = to.x;
  const y2 = to.y + NODE_HEIGHT / 2;
  const bend = Math.max(24, Math.abs(x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}
