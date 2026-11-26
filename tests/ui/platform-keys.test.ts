import { describe, expect, it } from 'vitest';

import { shortcutLabel } from '../../src/ui/platform-keys.ts';

describe('shortcut labels', () => {
  it('writes them the Mac way on a Mac, in the order Apple\'s menus use', () => {
    expect(shortcutLabel('Ctrl+S', true)).toBe('⌘S');
    expect(shortcutLabel('Ctrl+Shift+Z', true)).toBe('⇧⌘Z');
    expect(shortcutLabel('Ctrl+Z / Ctrl+Shift+Z', true)).toBe('⌘Z / ⇧⌘Z');
    expect(shortcutLabel('Ctrl+,', true)).toBe('⌘,');
    expect(shortcutLabel('Esc', true)).toBe('Esc');
  });

  it('leaves them alone elsewhere', () => {
    expect(shortcutLabel('Ctrl+Shift+Z', false)).toBe('Ctrl+Shift+Z');
  });
});
