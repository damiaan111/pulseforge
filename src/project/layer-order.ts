// Where a layer moves to when it is nudged or dragged in the layer list (M9, ui-spec §5).
//
// The list shows layers top-first; the document stores them bottom-first (the order they
// composite). Getting that flip and the "index after removing the moved layer" right in each click
// handler is how a reorder ends up one slot off, so it is worked out here once, as positions for
// `moveLayer`, and tested.

import type { InsertPosition } from './commands.ts';
import { walkLayers, type Layer, type ProjectDocument } from './document.ts';

interface Placement {
  readonly parentId: string | null;
  readonly siblings: readonly Layer[];
  readonly index: number;
}

function placementOf(document: ProjectDocument, layerId: string): Placement | undefined {
  for (const { layer, parents } of walkLayers(document.layers)) {
    if (layer.id !== layerId) continue;
    const parent = parents[parents.length - 1];
    const siblings = parent === undefined ? document.layers : parent.kind === 'group' ? parent.children : [];
    return { parentId: parent?.id ?? null, siblings, index: siblings.findIndex((s) => s.id === layerId) };
  }
  return undefined;
}

/**
 * One step up (towards the top of the list — drawn later, on top) or down, within the layer's own
 * group. Undefined when it is already at that end.
 */
export function stepPosition(document: ProjectDocument, layerId: string, direction: 'up' | 'down'): InsertPosition | undefined {
  const at = placementOf(document, layerId);
  if (at === undefined) return undefined;
  const index = direction === 'up' ? at.index + 1 : at.index - 1;
  if (index < 0 || index >= at.siblings.length) return undefined;
  // `moveLayer` inserts into the list with the layer already removed, so the neighbour's index is
  // exactly where it lands, in both directions.
  return { parentId: at.parentId, index };
}

/**
 * Dropping `draggedId` onto the row of `targetId`: it goes directly above that row in the list, in
 * the target's group. Undefined for a drop that would change nothing, or onto itself or one of its
 * own children (a group cannot contain itself — `moveLayer` would refuse it anyway).
 */
export function dropPosition(document: ProjectDocument, draggedId: string, targetId: string): InsertPosition | undefined {
  if (draggedId === targetId) return undefined;
  const target = placementOf(document, targetId);
  const dragged = placementOf(document, draggedId);
  if (target === undefined || dragged === undefined) return undefined;
  const draggedLayer = dragged.siblings[dragged.index];
  if (draggedLayer !== undefined && [...walkLayers([draggedLayer])].some(({ layer }) => layer.id === targetId)) return undefined;
  // Above the target in the list = one index higher in storage. With the dragged layer removed
  // first, a layer coming from below the target in the same group shifts the target down by one.
  const sameGroup = dragged.parentId === target.parentId;
  const index = target.index + 1 - (sameGroup && dragged.index < target.index ? 1 : 0);
  if (sameGroup && index === dragged.index) return undefined;
  return { parentId: target.parentId, index };
}

/**
 * The layer list's order: top first, each group's own row directly above its children (also top
 * first), with how deep each row is nested. Reversing a document walk does not give this — it puts
 * a group's children above the group.
 */
export function displayOrder(layers: readonly Layer[], depth = 0): { readonly layer: Layer; readonly depth: number }[] {
  const rows: { layer: Layer; depth: number }[] = [];
  for (let i = layers.length - 1; i >= 0; i -= 1) {
    const layer = layers[i]!;
    rows.push({ layer, depth });
    if (layer.kind === 'group') rows.push(...displayOrder(layer.children, depth + 1));
  }
  return rows;
}
