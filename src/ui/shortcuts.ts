// The studio's remappable keys (ui-spec §9). One letter or named key each, with no modifier: Ctrl
// combinations follow Windows and are left alone, and the lyrics editor's keys mean something only
// inside it. The keyboard table in Settings is drawn from this list, so it cannot go stale.

export interface ShortcutAction {
  readonly id: string;
  readonly label: string;
  /** Lower-case `event.key`, or 'space'. Several keys may start an action; a remap replaces them all. */
  readonly keys: readonly string[];
}

export const SHORTCUT_ACTIONS: readonly ShortcutAction[] = [
  { id: 'play', label: 'Play or pause', keys: ['space', 'k'] },
  { id: 'start', label: 'Back to the start', keys: ['home'] },
  { id: 'fit', label: 'Fit the whole timeline', keys: ['f'] },
  { id: 'marker', label: 'Add a marker', keys: ['m'] },
  { id: 'loopIn', label: 'Loop from the playhead', keys: ['i'] },
  { id: 'loopOut', label: 'Loop to the playhead', keys: ['o'] },
  { id: 'loopToggle', label: 'Loop on or off', keys: ['l'] },
  { id: 'previousStop', label: 'Previous marker or section', keys: ['['] },
  { id: 'nextStop', label: 'Next marker or section', keys: [']'] },
];

export type ShortcutMap = Readonly<Record<string, string>>;

/** A key event's name in this table, or null for a modifier or a dead key on its own. */
export function keyName(event: Pick<KeyboardEvent, 'key'>): string | null {
  if (event.key === ' ') return 'space';
  if (event.key === 'Dead' || ['Shift', 'Control', 'Alt', 'Meta', 'Escape', 'Tab', 'Enter'].includes(event.key)) return null;
  return event.key.toLowerCase();
}

export function keysFor(action: ShortcutAction, map: ShortcutMap): readonly string[] {
  const chosen = map[action.id];
  return chosen === undefined ? action.keys : [chosen];
}

/** The action a key starts, under the user's remaps. */
export function actionForKey(key: string | null, map: ShortcutMap): string | null {
  if (key === null) return null;
  return SHORTCUT_ACTIONS.find((action) => keysFor(action, map).includes(key))?.id ?? null;
}

/** The map after giving `id` this key. A key does one thing, so an action that held it goes back to its default if it can, and otherwise loses it. */
export function remap(map: ShortcutMap, id: string, key: string): ShortcutMap {
  const next: Record<string, string> = { ...map, [id]: key };
  for (const action of SHORTCUT_ACTIONS) {
    if (action.id === id || !keysFor(action, next).includes(key)) continue;
    delete next[action.id];
    if (action.keys.includes(key)) next[action.id] = action.keys.find((other) => other !== key) ?? 'none';
  }
  return next;
}

/** Shown in a key cap: 'space' as Space, a letter as its capital. */
export function keyLabel(key: string): string {
  return key === 'none' ? 'None' : key.length === 1 ? key.toUpperCase() : key[0]?.toUpperCase() + key.slice(1);
}
