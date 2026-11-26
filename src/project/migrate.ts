// The migration chain (data-formats §2.2).
//
// Migrations are an ordered chain of pure functions, v(n) → v(n+1). Opening a v3 document in
// a v7 build runs 3→4→5→6→7. There is deliberately no "handle every old version" branch:
// that shape becomes unmaintainable by about version four, and it is impossible to test
// exhaustively.
//
// Rules each migration must hold to:
//  - Pure: no clock, no filesystem, no ids generated from anything but its input.
//  - Total: it must accept any document its source version could legally contain, including
//    unknown fields, and carry those through.
//  - Covered by a fixture: a real document at the old version, committed under
//    tests/project/fixtures/, with the expected result. The fixtures are the actual guarantee;
//    the chain machinery below is only the thing that runs them.
//
// v1 is the first released schema, so MIGRATIONS is empty. It is not dead code: the tests
// exercise the chain with their own migrations, and the first schema change adds one entry
// here plus one fixture, with nothing else to design at that point.

import { CURRENT_SCHEMA_VERSION, OLDEST_SUPPORTED_SCHEMA_VERSION } from './document.ts';
import { ProjectFormatError, ProjectVersionError } from './parse.ts';

/** Transforms a raw document object from version `n` to version `n + 1`. */
export type Migration = (document: Record<string, unknown>) => Record<string, unknown>;

/** Keyed by the version the migration reads. */
export type MigrationChain = ReadonlyMap<number, Migration>;

export const MIGRATIONS: MigrationChain = new Map<number, Migration>();

export interface MigrationResult {
  readonly document: Record<string, unknown>;
  /** Versions migrated *from*, in order. Empty when the file was already current. */
  readonly applied: readonly number[];
}

function readVersion(document: Record<string, unknown>): number {
  const version = document['schemaVersion'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new ProjectFormatError(
      `This file has no valid "schemaVersion" (found ${JSON.stringify(version)}), so it is not a Pulseforge project.`,
    );
  }
  return version;
}

/**
 * Runs the chain up to the current version. Throws rather than guessing when the document is
 * from the future (`ProjectVersionError`) or from a version this build no longer carries a
 * migration for — both cases where a partial parse would quietly destroy data on the next save.
 */
export function migrateToCurrent(
  raw: Record<string, unknown>,
  chain: MigrationChain = MIGRATIONS,
  targetVersion: number = CURRENT_SCHEMA_VERSION,
): MigrationResult {
  const from = readVersion(raw);
  if (from > targetVersion) throw new ProjectVersionError(from, targetVersion);
  if (from < OLDEST_SUPPORTED_SCHEMA_VERSION && chain.get(from) === undefined) {
    throw new ProjectFormatError(
      `This project uses schema version ${from}, which this build can no longer migrate ` +
        `(the oldest supported is ${OLDEST_SUPPORTED_SCHEMA_VERSION}). Open it with an older Pulseforge first.`,
    );
  }

  let document = raw;
  const applied: number[] = [];
  for (let version = from; version < targetVersion; version += 1) {
    const migration = chain.get(version);
    if (migration === undefined) {
      throw new ProjectFormatError(
        `No migration from schema version ${version} to ${version + 1} is registered. This is a bug in Pulseforge, not in the project file — the file has not been modified.`,
      );
    }
    document = { ...migration(document), schemaVersion: version + 1 };
    applied.push(version);
  }
  return { document, applied };
}

/**
 * Where the pre-migration copy is kept (data-formats §2.2): `song.pvproj` at v3 backs up to
 * `song.v3.bak` before the first save in the new format, so a bad migration is recoverable.
 */
export function backupPathFor(projectPath: string, fromVersion: number): string {
  const dot = projectPath.lastIndexOf('.');
  const slash = Math.max(projectPath.lastIndexOf('/'), projectPath.lastIndexOf('\\'));
  const stem = dot > slash ? projectPath.slice(0, dot) : projectPath;
  return `${stem}.v${fromVersion}.bak`;
}
