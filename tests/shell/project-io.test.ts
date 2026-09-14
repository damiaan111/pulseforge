// Project file I/O (src/shell/project-io.ts).
//
// The two properties worth testing are the ones you only notice when they are missing: a save
// that is interrupted must not destroy the previous version, and a migration must leave the
// original recoverable.

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ProjectIoError, readProjectText, writeProjectText } from '../../src/shell/project-io.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pulseforge-io-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('readProjectText', () => {
  it('reads a file back exactly, including its trailing newline', async () => {
    const path = join(dir, 'song.pvproj');
    await writeFile(path, '{"schemaVersion":1}\n', 'utf8');
    expect(await readProjectText(path)).toBe('{"schemaVersion":1}\n');
  });

  it('says what to do when the file is gone, rather than throwing ENOENT at the UI', async () => {
    const path = join(dir, 'missing.pvproj');
    await expect(readProjectText(path)).rejects.toThrow(ProjectIoError);
    try {
      await readProjectText(path);
    } catch (error) {
      expect((error as ProjectIoError).message).toContain('no longer exists');
      expect((error as ProjectIoError).fixes.join(' ')).toContain('moved or renamed');
      expect((error as ProjectIoError).path).toBe(path);
    }
  });

  it('round-trips non-ASCII content as UTF-8', async () => {
    const path = join(dir, 'naïve.pvproj');
    const text = '{"name":"Ré—mix ✨"}\n';
    await writeProjectText(path, text);
    expect(await readProjectText(path)).toBe(text);
  });
});

describe('writeProjectText', () => {
  it('writes the file and leaves no temporary behind', async () => {
    const path = join(dir, 'song.pvproj');
    const result = await writeProjectText(path, 'one\n');
    expect(result.path).toBe(path);
    expect(result.backupPath).toBeUndefined();
    expect(await readFile(path, 'utf8')).toBe('one\n');
    // The write goes via a temp file in the same directory; none of them may survive, or the
    // project folder silently fills with debris.
    expect((await readdir(dir)).filter((name) => name.includes('tmp'))).toEqual([]);
  });

  it('replaces an existing file', async () => {
    const path = join(dir, 'song.pvproj');
    await writeProjectText(path, 'first\n');
    await writeProjectText(path, 'second\n');
    expect(await readFile(path, 'utf8')).toBe('second\n');
  });

  it('creates the folder when saving somewhere new', async () => {
    const path = join(dir, 'nested', 'deeper', 'song.pvproj');
    await writeProjectText(path, 'x\n');
    expect(existsSync(path)).toBe(true);
  });
});

describe('migration backups (data-formats §2.2)', () => {
  it('copies the original before the first save of a migrated project', async () => {
    const path = join(dir, 'song.pvproj');
    await writeFile(path, 'the original v3 document\n', 'utf8');

    const result = await writeProjectText(path, 'the migrated v4 document\n', { backupFromVersion: 3 });
    expect(result.backupPath).toBe(join(dir, 'song.v3.bak'));
    expect(await readFile(result.backupPath as string, 'utf8')).toBe('the original v3 document\n');
    expect(await readFile(path, 'utf8')).toBe('the migrated v4 document\n');
  });

  it('never overwrites an existing backup with already-migrated content', async () => {
    const path = join(dir, 'song.pvproj');
    await writeFile(path, 'original\n', 'utf8');
    await writeProjectText(path, 'migrated once\n', { backupFromVersion: 3 });

    // A second save in the same session must not replace the backup — that is the only copy
    // of the pre-migration file, and losing it is the whole thing the backup exists to prevent.
    const second = await writeProjectText(path, 'migrated twice\n', { backupFromVersion: 3 });
    expect(second.backupPath).toBeUndefined();
    expect(await readFile(join(dir, 'song.v3.bak'), 'utf8')).toBe('original\n');
    expect(await readFile(path, 'utf8')).toBe('migrated twice\n');
  });

  it('does not write a backup when there was no file to back up', async () => {
    const path = join(dir, 'fresh.pvproj');
    const result = await writeProjectText(path, 'new\n', { backupFromVersion: 2 });
    expect(result.backupPath).toBeUndefined();
    expect(existsSync(join(dir, 'fresh.v2.bak'))).toBe(false);
  });
});
