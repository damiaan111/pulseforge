// Text on disk → a typed, current-version document.
//
// Deliberately free of filesystem access: the shell reads the bytes and owns the backup that
// data-formats §2.2 requires before the first save of a migrated project. Keeping this pure
// makes the whole load path testable without touching a disk, which is how the migration
// fixtures work.

import type { ProjectDocument } from './document.ts';
import { migrateToCurrent, type MigrationChain } from './migrate.ts';
import { parseDocument, ProjectFormatError, type DocumentIssue } from './parse.ts';

export interface LoadResult {
  readonly document: ProjectDocument;
  readonly issues: readonly DocumentIssue[];
  /**
   * The version the file was stored at, when it needed migrating. The shell writes
   * `backupPathFor(path, migratedFrom)` before saving over the original.
   */
  readonly migratedFrom: number | null;
}

export function loadDocumentFromJson(raw: unknown, chain?: MigrationChain): LoadResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ProjectFormatError(`A project must be a JSON object, but this file contains ${Array.isArray(raw) ? 'an array' : typeof raw}.`);
  }
  const source = raw as Record<string, unknown>;
  const storedVersion = source['schemaVersion'];
  const { document: migrated, applied } = chain === undefined
    ? migrateToCurrent(source)
    : migrateToCurrent(source, chain);
  const { document, issues } = parseDocument(migrated);
  return {
    document,
    issues,
    migratedFrom: applied.length > 0 && typeof storedVersion === 'number' ? storedVersion : null,
  };
}

export function loadDocument(text: string, chain?: MigrationChain): LoadResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new ProjectFormatError(
      `This project file is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
  return loadDocumentFromJson(raw, chain);
}
