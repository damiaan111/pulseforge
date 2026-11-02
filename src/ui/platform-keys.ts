// Shortcut labels as this system writes them. The keys themselves already work on both: every handler
// takes Ctrl or Cmd (event.ctrlKey || event.metaKey). Only the words on screen differ.

/** The studio runs on a Mac. Chromium still reports `Macintosh` on Apple Silicon. */
export const ON_MAC = typeof navigator !== 'undefined' && navigator.userAgent.includes('Macintosh');

/** `Ctrl+Shift+Z` on Windows, `⇧⌘Z` on a Mac, in the order Apple's menus use. */
export function shortcutLabel(keys: string, mac = ON_MAC): string {
  if (!mac) return keys;
  return keys.replace(/(Ctrl\+)?(Shift\+)?(Alt\+)?/g, (_all, ctrl?: string, shift?: string, alt?: string) =>
    `${alt === undefined ? '' : '⌥'}${shift === undefined ? '' : '⇧'}${ctrl === undefined ? '' : '⌘'}`);
}
