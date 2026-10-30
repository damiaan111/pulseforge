// Selecting several layers. The inspector still edits one, the primary: `selectedLayerId`. These are
// the rules for what Ctrl and Shift do to the set around it, pure so they can be tested.

export interface LayerSelection {
  readonly primary: string | null;
  readonly ids: readonly string[];
}

/**
 * Ctrl toggles one layer. Shift takes everything between the primary and the clicked layer, in the
 * order the list shows, and the primary stays, so a second Shift-click adjusts the same range.
 */
export function extendSelection(current: LayerSelection, id: string, mode: 'toggle' | 'range', order: readonly string[]): LayerSelection {
  if (mode === 'toggle') {
    if (!current.ids.includes(id)) return { primary: id, ids: [...current.ids, id] };
    const ids = current.ids.filter((other) => other !== id);
    return { primary: current.primary === id ? ids[ids.length - 1] ?? null : current.primary, ids };
  }
  const from = current.primary === null ? -1 : order.indexOf(current.primary);
  const to = order.indexOf(id);
  if (from < 0 || to < 0) return { primary: id, ids: [id] };
  return { primary: current.primary, ids: order.slice(Math.min(from, to), Math.max(from, to) + 1) };
}
