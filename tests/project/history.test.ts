// Undo/redo (src/project/history.ts, M8, ui-spec §10).

import { describe, expect, it } from 'vitest';

import { createDocument } from '../../src/project/create.ts';
import type { ProjectDocument } from '../../src/project/document.ts';
import { History, type Command } from '../../src/project/history.ts';

let clock = 0;
const now = () => `2026-09-14T00:00:${String(clock++).padStart(2, '0')}.000Z`;

const start = () => createDocument({ name: 'Start', timestamp: '2026-09-14T00:00:00.000Z' });
const history = (options = {}) => new History(start(), { now, ...options });

const rename = (name: string): Command => ({
  label: `Rename to ${name}`,
  apply: (document: ProjectDocument) => ({ ...document, name }),
});

const setSeed = (seed: number): Command => ({
  label: 'Set seed',
  mergeKey: 'seed',
  apply: (document: ProjectDocument) => ({ ...document, seed }),
});

describe('History', () => {
  it('starts at the opened state with nothing to undo', () => {
    const h = history();
    expect(h.current.name).toBe('Start');
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(false);
    expect(h.dirty).toBe(false);
    expect(h.entries).toEqual([{ label: 'Opened', index: 0, current: true }]);
  });

  it('applies, undoes and redoes', () => {
    const h = history();
    h.run(rename('One'));
    h.run(rename('Two'));
    expect(h.current.name).toBe('Two');

    expect(h.undo()?.name).toBe('One');
    expect(h.undo()?.name).toBe('Start');
    expect(h.undo()).toBeUndefined();

    expect(h.redo()?.name).toBe('One');
    expect(h.redo()?.name).toBe('Two');
    expect(h.redo()).toBeUndefined();
  });

  it('never mutates the documents it holds', () => {
    const h = history();
    const before = h.current;
    h.run(rename('Changed'));
    // Undo can only be correct if the earlier document was untouched.
    expect(before.name).toBe('Start');
    expect(h.undo()).toBe(before);
  });

  it('labels what undo and redo would do', () => {
    const h = history();
    h.run(rename('One'));
    expect(h.undoLabel).toBe('Rename to One');
    expect(h.redoLabel).toBeUndefined();
    h.undo();
    expect(h.undoLabel).toBeUndefined();
    expect(h.redoLabel).toBe('Rename to One');
  });

  it('stamps modifiedAt from the injected clock, leaving commands pure', () => {
    const h = history();
    const first = h.run(rename('One'));
    const second = h.run(rename('Two'));
    expect(first.modifiedAt).not.toBe(second.modifiedAt);
    expect(second.modifiedAt).toMatch(/^2026-09-14T/);
  });

  it('discards the redo tail when a new command branches', () => {
    const h = history();
    h.run(rename('One'));
    h.run(rename('Two'));
    h.undo();
    h.run(rename('Other'));
    expect(h.canRedo).toBe(false);
    expect(h.entries.map((e) => e.label)).toEqual(['Opened', 'Rename to One', 'Rename to Other']);
  });

  it('offers the whole list so the UI can jump, not just step', () => {
    const h = history();
    h.run(rename('One'));
    h.run(rename('Two'));
    h.run(rename('Three'));
    expect(h.jumpTo(1).name).toBe('One');
    expect(h.entries.find((e) => e.current)?.index).toBe(1);
    // Out of range is clamped rather than throwing at the UI.
    expect(h.jumpTo(99).name).toBe('Three');
    expect(h.jumpTo(-5).name).toBe('Start');
  });
});

describe('merging (a slider drag is one undo step)', () => {
  it('collapses consecutive commands with the same merge key', () => {
    const h = history();
    for (let i = 1; i <= 200; i += 1) h.run(setSeed(i));
    expect(h.current.seed).toBe(200);
    // One entry for the whole drag, not two hundred.
    expect(h.entries).toHaveLength(2);
    expect(h.undo()?.seed).toBe(0);
  });

  it('does not merge across different keys', () => {
    const h = history();
    h.run(setSeed(1));
    h.run({ ...setSeed(2), mergeKey: 'other' });
    expect(h.entries).toHaveLength(3);
  });

  it('does not merge across an unmergeable command', () => {
    const h = history();
    h.run(setSeed(1));
    h.run(rename('Interrupt'));
    h.run(setSeed(2));
    expect(h.entries.map((e) => e.label)).toEqual(['Opened', 'Set seed', 'Rename to Interrupt', 'Set seed']);
  });

  it('stops merging after seal(), which is what pointer-up calls', () => {
    const h = history();
    h.run(setSeed(1));
    h.run(setSeed(2));
    expect(h.entries).toHaveLength(2);
    h.seal();
    h.run(setSeed(3));
    // A second drag of the same slider is a second undo step, or undo would swallow both.
    expect(h.entries).toHaveLength(3);
    expect(h.undo()?.seed).toBe(2);
  });

  it('does not merge into a state that was reached by undo', () => {
    const h = history();
    h.run(setSeed(1));
    h.run(rename('X'));
    h.undo();
    h.run(setSeed(5));
    expect(h.entries.map((e) => e.label)).toEqual(['Opened', 'Set seed', 'Set seed']);
    expect(h.undo()?.seed).toBe(1);
  });
});

describe('saved state', () => {
  it('tracks dirtiness against the last save, in both directions', () => {
    const h = history();
    h.run(rename('One'));
    expect(h.dirty).toBe(true);
    h.markSaved();
    expect(h.dirty).toBe(false);

    h.run(rename('Two'));
    expect(h.dirty).toBe(true);
    // Undoing back to the saved state means the file matches again.
    h.undo();
    expect(h.dirty).toBe(false);
  });

  it('reads as dirty when the saved state falls out of a trimmed history', () => {
    const h = history({ limit: 3 });
    h.run(rename('One'));
    h.markSaved();
    for (const name of ['Two', 'Three', 'Four', 'Five']) h.run(rename(name));
    // The saved point is gone, so nothing in history matches the file — saying "not dirty"
    // here would invite closing without saving.
    expect(h.dirty).toBe(true);
  });
});

describe('bounds', () => {
  it('keeps at most `limit` undo steps and drops the oldest', () => {
    const h = history({ limit: 3 });
    for (const name of ['One', 'Two', 'Three', 'Four', 'Five']) h.run(rename(name));
    expect(h.entries).toHaveLength(4); // three steps plus the oldest surviving state
    expect(h.current.name).toBe('Five');
    h.undo();
    h.undo();
    h.undo();
    expect(h.canUndo).toBe(false);
    expect(h.current.name).toBe('Two');
  });

  it('reset() replaces everything, for opening another project', () => {
    const h = history();
    h.run(rename('One'));
    const other = createDocument({ name: 'Other', timestamp: '2026-09-14T00:00:00.000Z' });
    h.reset(other);
    expect(h.current).toBe(other);
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(false);
    expect(h.dirty).toBe(false);
  });
});
