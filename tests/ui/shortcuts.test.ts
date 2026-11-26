import { describe, expect, it } from 'vitest';

import { actionForKey, keyLabel, keyName, keysFor, remap, SHORTCUT_ACTIONS } from '../../src/ui/shortcuts.ts';
import { linesInRange } from '../../src/ui/timeline-drag.ts';

const action = (id: string) => SHORTCUT_ACTIONS.find((a) => a.id === id)!;

describe('shortcuts', () => {
  it('has one action per key by default', () => {
    const keys = SHORTCUT_ACTIONS.flatMap((a) => a.keys);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('finds the action for a key, and a remap replaces the defaults', () => {
    expect(actionForKey('k', {})).toBe('play');
    const map = remap({}, 'play', 'p');
    expect(actionForKey('p', map)).toBe('play');
    expect(actionForKey('k', map)).toBeNull();
    expect(actionForKey('space', map)).toBeNull();
  });

  it('takes a key away from the action that held it, so a key never does two things', () => {
    const map = remap({}, 'fit', 'm');
    expect(actionForKey('m', map)).toBe('fit');
    expect(keysFor(action('marker'), map)).toEqual(['none']);
  });

  it('gives an action back its other default when it loses one', () => {
    expect(keysFor(action('play'), remap({}, 'fit', 'k'))).toEqual(['space']);
  });

  it('frees a key when the action that took it moves on', () => {
    const map = remap(remap({}, 'fit', 'x'), 'fit', 'y');
    expect(actionForKey('x', map)).toBeNull();
  });

  it('ignores modifiers on their own, and names space', () => {
    expect(keyName({ key: 'Shift' })).toBeNull();
    expect(keyName({ key: ' ' })).toBe('space');
    expect(keyName({ key: 'K' })).toBe('k');
  });

  it('labels keys for a person', () => {
    expect(keyLabel('k')).toBe('K');
    expect(keyLabel('space')).toBe('Space');
    expect(keyLabel('none')).toBe('None');
  });
});

describe('a marquee over the lyrics lane', () => {
  const line = (id: string, startTicks: number | null, endTicks: number | null) => ({ id, startTicks, endTicks });
  const lines = [line('a', 0, 1000), line('b', 2000, 3000), line('c', 4000, 5000), line('d', null, null)];

  it('takes every line it touches, dragged either way', () => {
    expect(linesInRange(lines, 500, 2500)).toEqual(['a', 'b']);
    expect(linesInRange(lines, 2500, 500)).toEqual(['a', 'b']);
  });

  it('leaves out lines with no time', () => {
    expect(linesInRange(lines, 0, 100_000)).toEqual(['a', 'b', 'c']);
  });
});
