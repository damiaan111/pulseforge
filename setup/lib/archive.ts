import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ArchiveArtefact } from '../manifest.ts';
import { SetupError } from './errors.ts';
import type { Logger } from './log.ts';
import { STAGING, TAR_EXE, VENDOR, insideVendor } from './paths.ts';
import { MAC } from './platform.ts';
import { runChecked } from './proc.ts';

const MARKER = '.pulseforge-installed.json';

interface InstallMarker {
  id: string;
  version: string;
  sha256: string;
}

export async function isInstalled(artefact: ArchiveArtefact): Promise<boolean> {
  const dir = join(VENDOR, artefact.installDir);
  try {
    const marker = JSON.parse(await readFile(join(dir, MARKER), 'utf8')) as InstallMarker;
    return marker.sha256 === artefact.sha256 && existsSync(join(dir, artefact.expectFile));
  } catch {
    return false;
  }
}

/** Removes a vendor/ directory, retrying the transient locks Windows antivirus likes to hold. */
export async function removeVendorDir(path: string): Promise<void> {
  await rm(insideVendor(path), { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}

/**
 * Extracts into a staging folder and only then swaps it into place, so an interrupted
 * extraction never leaves a half-populated install that looks complete.
 */
export async function installArchive(archivePath: string, artefact: ArchiveArtefact, step: string, log: Logger): Promise<void> {
  const staging = join(STAGING, artefact.id);
  const target = join(VENDOR, artefact.installDir);

  await removeVendorDir(staging);
  await mkdir(staging, { recursive: true });

  // Windows' bundled bsdtar handles both .zip and .tar.gz, and is invoked by absolute path.
  await runChecked(TAR_EXE, ['-xf', archivePath, '-C', staging], { step, log }, () => ({
    what: `Extracting ${artefact.fileName} failed.`,
    likelyCause: 'The disk is full, antivirus blocked files while they were written, or the path is too long.',
    fix: [
      'Check free space on the drive holding the repo.',
      `If antivirus is active, exclude ${VENDOR} and re-run setup.`,
    ],
  }));

  let source = staging;
  if (artefact.stripTopLevelDir) {
    const entries = await readdir(staging);
    const first = entries[0];
    if (entries.length !== 1 || first === undefined || !(await stat(join(staging, first))).isDirectory()) {
      throw new SetupError({
        step,
        what: `${artefact.fileName} does not have the expected layout (one top-level folder); found: ${entries.join(', ') || 'nothing'}.`,
        likelyCause: 'The pinned build changed its packaging. The checksum matched, so the manifest entry itself needs updating.',
        fix: ['Update stripTopLevelDir / expectFile for this artefact in setup/manifest.ts.'],
      });
    }
    source = join(staging, first);
  }

  if (!existsSync(join(source, artefact.expectFile))) {
    throw new SetupError({
      step,
      what: `${artefact.fileName} extracted, but ${artefact.expectFile} is missing from it.`,
      likelyCause: 'The pinned build is not the kind of package the manifest expects.',
      fix: ['Check the expectFile entry for this artefact in setup/manifest.ts.'],
    });
  }

  // A zip keeps its permission bits only when it was made on a Unix system. The program has to run.
  if (MAC) await chmod(join(source, artefact.expectFile), 0o755);

  await removeVendorDir(target);
  // A nested install dir (`fonts/inter`) needs its parent before the rename can land in it.
  await mkdir(dirname(target), { recursive: true });
  await rename(source, target);
  const marker: InstallMarker = { id: artefact.id, version: artefact.version, sha256: artefact.sha256 };
  await writeFile(join(target, MARKER), JSON.stringify(marker, null, 2) + '\n');
  await removeVendorDir(staging);
}
