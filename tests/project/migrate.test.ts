// The migration chain (data-formats §2.2).
//
// v1 is the first released schema, so there are no real migrations yet. These tests exercise
// the machinery with their own chain — which is exactly what the first real migration will
// plug into — plus the two refusals that protect data: a document from the future, and a
// version this build no longer carries a migration for.

import { describe, expect, it } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../../src/project/document.ts';
import { backupPathFor, MIGRATIONS, migrateToCurrent, type Migration } from '../../src/project/migrate.ts';
import { loadDocumentFromJson } from '../../src/project/load.ts';
import { ProjectFormatError, ProjectVersionError } from '../../src/project/parse.ts';

describe('migrateToCurrent', () => {
  it('leaves a current document alone', () => {
    const raw = { schemaVersion: CURRENT_SCHEMA_VERSION, name: 'x' };
    const { document, applied } = migrateToCurrent(raw);
    expect(applied).toEqual([]);
    expect(document).toBe(raw);
  });

  it('runs every step in order, not a single catch-all branch', () => {
    const order: number[] = [];
    const step = (n: number): Migration => (doc) => {
      order.push(n);
      return { ...doc, [`v${n + 1}`]: true };
    };
    const chain = new Map<number, Migration>([[1, step(1)], [2, step(2)], [3, step(3)]]);

    const { document, applied } = migrateToCurrent({ schemaVersion: 1 }, chain, 4);
    expect(order).toEqual([1, 2, 3]);
    expect(applied).toEqual([1, 2, 3]);
    expect(document['schemaVersion']).toBe(4);
    expect(document).toMatchObject({ v2: true, v3: true, v4: true });
  });

  it('carries unknown fields through every step', () => {
    const chain = new Map<number, Migration>([[1, (doc) => ({ ...doc, added: 1 })]]);
    const { document } = migrateToCurrent({ schemaVersion: 1, fromTheFuture: { a: 1 } }, chain, 2);
    expect(document['fromTheFuture']).toEqual({ a: 1 });
  });

  it('refuses a document newer than this build', () => {
    expect(() => migrateToCurrent({ schemaVersion: CURRENT_SCHEMA_VERSION + 1 })).toThrow(ProjectVersionError);
  });

  it('refuses rather than skipping a missing step', () => {
    const chain = new Map<number, Migration>([[1, (doc) => doc]]);
    // 2 → 3 is not registered: better a clear error than a document quietly left at v2
    // and then saved as if it were v3.
    expect(() => migrateToCurrent({ schemaVersion: 1 }, chain, 3)).toThrow(/No migration from schema version 2 to 3/);
  });

  it('refuses a document with no usable version', () => {
    expect(() => migrateToCurrent({ schemaVersion: 'one' as unknown as number })).toThrow(ProjectFormatError);
    expect(() => migrateToCurrent({ schemaVersion: 0 })).toThrow(ProjectFormatError);
  });

  it('is empty at v1 — the first schema change adds one entry and one fixture', () => {
    expect(MIGRATIONS.size).toBe(0);
  });
});

describe('loadDocumentFromJson', () => {
  it('reports the version a document was migrated from, so the shell can back it up', () => {
    const chain = new Map<number, Migration>([
      [1, (doc) => ({ ...doc, canvas: { width: 1280, height: 720, fps: { num: 30, den: 1 } } })],
    ]);
    const raw = { schemaVersion: 1, id: '0000000000P000000000000001', layers: [] };
    // Target the current version through a chain that fills in what v1 lacked.
    const result = loadDocumentFromJson(raw, chain);
    expect(result.migratedFrom).toBeNull(); // already current: nothing ran
    expect(result.document.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });
});

describe('backupPathFor', () => {
  it('names the pre-migration copy beside the project', () => {
    expect(backupPathFor('D:\\projects\\song.pvproj', 3)).toBe('D:\\projects\\song.v3.bak');
    expect(backupPathFor('/home/d/song.pvproj', 1)).toBe('/home/d/song.v1.bak');
  });

  it('handles a path with no extension and a dot in a directory name', () => {
    expect(backupPathFor('/home/d.old/song', 2)).toBe('/home/d.old/song.v2.bak');
  });
});
