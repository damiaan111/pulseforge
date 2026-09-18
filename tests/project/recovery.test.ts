// Autosave and crash recovery (M1): the store on disk and the summary a person decides from.

import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDocument, createModuleLayer } from '../../src/project/create.ts';
import { History } from '../../src/project/history.ts';
import { summarizeRecovery } from '../../src/project/recovery-diff.ts';
import { RecoveryStore, SNAPSHOTS_KEPT } from '../../src/project/recovery-store.ts';

let root: string;
let clock = 0;
const now = () => new Date(Date.UTC(2026, 8, 18, 12, 0, clock++)).toISOString();

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pulseforge-recovery-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const snapshot = (text: string, reason = 'interval') => ({ text, projectPath: 'D:/songs/a.pvproj', projectName: 'A', reason });

describe('RecoveryStore', () => {
  it('offers a session that ended without clearing, with its newest snapshot', async () => {
    const store = new RecoveryStore({ root, now });
    await store.write('crashed', snapshot('one'));
    await store.write('crashed', snapshot('two', 'before applying a preset'));
    const list = await store.listRecoverable('current');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ sessionId: 'crashed', projectName: 'A', projectPath: 'D:/songs/a.pvproj', reason: 'before applying a preset', snapshots: 2 });
    expect(await store.readLatest('crashed')).toBe('two');
  });

  it('never offers the running session, and a cleared session is gone', async () => {
    const store = new RecoveryStore({ root, now });
    await store.write('current', snapshot('mine'));
    await store.write('old', snapshot('theirs'));
    expect((await store.listRecoverable('current')).map((s) => s.sessionId)).toEqual(['old']);
    await store.clear('old');
    expect(await store.listRecoverable('current')).toEqual([]);
  });

  it('keeps only the newest few snapshots', async () => {
    const store = new RecoveryStore({ root, now });
    for (let i = 1; i <= SNAPSHOTS_KEPT + 3; i += 1) await store.write('s', snapshot(`v${i}`));
    const files = (await readdir(join(root, 's'))).filter((f) => f.endsWith('.pvproj'));
    expect(files).toHaveLength(SNAPSHOTS_KEPT);
    expect(await store.readLatest('s')).toBe(`v${SNAPSHOTS_KEPT + 3}`);
  });

  it('lists newest first, and skips a damaged session instead of failing', async () => {
    const store = new RecoveryStore({ root, now });
    await store.write('older', snapshot('a'));
    await store.write('newer', snapshot('b'));
    await writeFile(join(root, 'older', 'session.json'), '{broken');
    expect((await store.listRecoverable('x')).map((s) => s.sessionId)).toEqual(['newer']);
  });

  it('refuses a session id that could name a path', async () => {
    const store = new RecoveryStore({ root, now });
    await expect(store.write('../escape', snapshot('x'))).rejects.toThrow();
    await expect(store.readLatest('..')).rejects.toThrow();
  });

  it('ignores stray files in the recovery folder', async () => {
    const store = new RecoveryStore({ root, now });
    await store.write('real', snapshot('x'));
    await writeFile(join(root, 'notes.txt.tmp~'), 'junk');
    expect((await store.listRecoverable('x')).map((s) => s.sessionId)).toEqual(['real']);
  });

  it('a missing recovery folder is simply nothing to recover', async () => {
    expect(await new RecoveryStore({ root: join(root, 'nope') }).listRecoverable('x')).toEqual([]);
  });
});

describe('the recovery summary', () => {
  const base = () => ({
    ...createDocument({ name: 'Song', timestamp: '2026-01-01T00:00:00.000Z' }),
    layers: [createModuleLayer('core.visualizer.bars', { id: 'L1', name: 'Bars' }), createModuleLayer('core.visualizer.orb', { id: 'L2', name: 'Orb' })],
  });

  it('names what was added, removed and edited', () => {
    const saved = base();
    const recovered = {
      ...saved,
      layers: [
        { ...saved.layers[0]!, opacity: 0.5 },
        createModuleLayer('core.visualizer.waves', { id: 'L3', name: 'Waves' }),
      ],
    };
    expect(summarizeRecovery(saved, recovered)).toEqual([
      '1 layer added: “Waves”.',
      '1 layer removed: “Orb”.',
      '1 layer edited: “Bars”.',
    ]);
  });

  it('notices palette, audio and name changes', () => {
    const saved = base();
    const recovered = { ...saved, name: 'Song v2', palette: { ...saved.palette, colors: ['#ff0000'] }, audio: { ...saved.audio, fadeInTicks: 48_000 } };
    const lines = summarizeRecovery(saved, recovered);
    expect(lines).toContain('The palette changed.');
    expect(lines).toContain('The audio clip changed (file, trim, fades or gain).');
    expect(lines).toContain('Renamed “Song” → “Song v2”.');
  });

  it('says so when there is no saved file, or nothing differs but the timestamp', () => {
    expect(summarizeRecovery(null, base())).toEqual(['A project that was never saved, with 2 layers.']);
    const saved = base();
    expect(summarizeRecovery(saved, { ...saved, modifiedAt: '2027-01-01T00:00:00.000Z' })).toEqual(['The same as the saved file.']);
  });
});

describe('a recovered document reads as unsaved', () => {
  it('until it is saved', () => {
    const history = new History(createDocument({ timestamp: '2026-01-01T00:00:00.000Z' }));
    history.resetUnsaved(createDocument({ name: 'Recovered', timestamp: '2026-01-01T00:00:00.000Z' }));
    expect(history.dirty).toBe(true);
    history.markSaved();
    expect(history.dirty).toBe(false);
  });
});
