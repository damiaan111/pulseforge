import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import type { Logger } from './log.ts';
import { VENDOR_LOCK } from './paths.ts';

// vendor/vendor.lock.json: exactly what is installed, with hashes (PROJECT.md §3).
// Deliberately free of timestamps and machine paths, so two installs of the same pins
// produce identical files and a diff shows only real changes.

export interface LockedArtefact {
  id: string;
  name: string;
  version: string;
  url: string;
  fileName: string;
  sha256: string;
  sizeBytes: number;
  license: string;
  /** Relative to vendor/, forward slashes. */
  installPath: string;
}

export interface LockedPackage {
  name: string;
  version: string;
  license: string;
}

export interface LockedPythonEnv {
  requirementsLockSha256: string;
  python: string;
  torch: string;
  torchCuda: string;
  packages: LockedPackage[];
}

export interface VendorLock {
  schemaVersion: 1;
  artefacts: LockedArtefact[];
  pythonEnv: LockedPythonEnv | null;
  /** The lyrics tier's lock, when installed (its packages are in `pythonEnv.packages`). */
  pythonLyricsEnv?: { requirementsLockSha256: string } | null;
  pythonBeatsEnv?: { requirementsLockSha256: string } | null;
}

export function emptyLock(): VendorLock {
  return { schemaVersion: 1, artefacts: [], pythonEnv: null };
}

export async function readVendorLock(log: Logger): Promise<VendorLock> {
  if (!existsSync(VENDOR_LOCK)) return emptyLock();
  try {
    const parsed = JSON.parse(await readFile(VENDOR_LOCK, 'utf8')) as Partial<VendorLock>;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.artefacts)) throw new Error('unrecognised schema');
    return { schemaVersion: 1, artefacts: parsed.artefacts, pythonEnv: parsed.pythonEnv ?? null, pythonLyricsEnv: parsed.pythonLyricsEnv ?? null, pythonBeatsEnv: parsed.pythonBeatsEnv ?? null };
  } catch (error) {
    // The lock is a record, not a source of truth: every artefact is re-verified on
    // disk, so a damaged lock is rebuilt rather than trusted or fatal.
    log.warn(`vendor.lock.json is unreadable (${(error as Error).message}); it will be rebuilt from what is verified on disk.`);
    return emptyLock();
  }
}

export function findArtefact(lock: VendorLock, id: string): LockedArtefact | undefined {
  return lock.artefacts.find((a) => a.id === id);
}

export function upsertArtefact(lock: VendorLock, entry: LockedArtefact): void {
  lock.artefacts = [...lock.artefacts.filter((a) => a.id !== entry.id), entry].sort((a, b) => a.id.localeCompare(b.id));
}

export async function writeVendorLock(lock: VendorLock): Promise<void> {
  const ordered: VendorLock = {
    schemaVersion: 1,
    artefacts: lock.artefacts.map((a) => ({
      id: a.id,
      name: a.name,
      version: a.version,
      url: a.url,
      fileName: a.fileName,
      sha256: a.sha256,
      sizeBytes: a.sizeBytes,
      license: a.license,
      installPath: a.installPath,
    })),
    pythonEnv:
      lock.pythonEnv === null
        ? null
        : {
            requirementsLockSha256: lock.pythonEnv.requirementsLockSha256,
            python: lock.pythonEnv.python,
            torch: lock.pythonEnv.torch,
            torchCuda: lock.pythonEnv.torchCuda,
            packages: [...lock.pythonEnv.packages]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((p) => ({ name: p.name, version: p.version, license: p.license })),
          },
    ...(lock.pythonLyricsEnv == null ? {} : { pythonLyricsEnv: { requirementsLockSha256: lock.pythonLyricsEnv.requirementsLockSha256 } }),
    ...(lock.pythonBeatsEnv == null ? {} : { pythonBeatsEnv: { requirementsLockSha256: lock.pythonBeatsEnv.requirementsLockSha256 } }),
  };
  await writeFile(VENDOR_LOCK, JSON.stringify(ordered, null, 2) + '\n');
}
