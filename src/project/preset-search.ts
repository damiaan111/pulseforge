// Searching the preset library (S8). Pure — the browser filters with it in the renderer, and the
// store's tests use it without a filesystem.

/** What searching needs from a library entry; the store's entries and the IPC listing both fit. */
export interface SearchablePreset {
  readonly name: string;
  readonly scope: 'layer' | 'project';
  readonly tags: readonly string[];
  readonly moduleId: string | null | undefined;
}

/**
 * Search the library by free text and tags.
 *
 * Pure, so the browser's filtering is testable without a filesystem — and so the same function
 * can filter a list that came from anywhere.
 */
export function searchPresets<E extends SearchablePreset>(
  entries: readonly E[],
  query: { readonly text?: string; readonly tags?: readonly string[]; readonly scope?: 'layer' | 'project'; readonly moduleId?: string },
): readonly E[] {
  const text = query.text?.trim().toLowerCase() ?? '';
  return entries.filter((entry) => {
    if (query.scope !== undefined && entry.scope !== query.scope) return false;
    if (query.moduleId !== undefined && entry.moduleId !== query.moduleId) return false;
    // Every requested tag must be present — filters narrow, they do not widen.
    if (query.tags !== undefined && !query.tags.every((tag) => entry.tags.includes(tag))) return false;
    if (text === '') return true;
    const haystack = `${entry.name} ${entry.tags.join(' ')} ${entry.moduleId ?? ''}`.toLowerCase();
    return haystack.includes(text);
  });
}

/** Every tag in the library with how often it is used — the browser's tag list. */
export function tagCounts(entries: readonly SearchablePreset[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    for (const tag of entry.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return new Map([...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}
