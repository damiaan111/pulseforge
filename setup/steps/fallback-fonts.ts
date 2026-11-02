import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { FALLBACK_FONTS, type FileArtefact } from '../manifest.ts';
import { ensureDownloaded, sha256File } from '../lib/download.ts';
import { SetupError } from '../lib/errors.ts';
import { findArtefact, upsertArtefact } from '../lib/lockfile.ts';
import { formatBytes } from '../lib/log.ts';
import { VENDOR } from '../lib/paths.ts';
import type { Step } from './types.ts';

// The bundled fallback chain for text (S17): Noto for the scripts Inter does not have, and for
// emoji. Each file is pinned by URL and full SHA-256 in the manifest, and read from here on every
// render, never from the system, so a frame of Japanese lyrics is the same on any machine.

const TITLE = 'Fallback fonts (Noto: Arabic, Hebrew, Indic, Thai, CJK, emoji)';

const pathOf = (artefact: FileArtefact) => join(VENDOR, artefact.installDir, artefact.fileName);

export const fallbackFontsStep: Step = {
  id: 'fallback-fonts',
  title: TITLE,
  tier: 'core',

  async describe(lock) {
    const total = FALLBACK_FONTS.reduce((sum, a) => sum + a.sizeBytes, 0);
    const missing = FALLBACK_FONTS.filter((a) => !existsSync(pathOf(a)) || findArtefact(lock, a.id) === undefined);
    return {
      name: 'Noto fallback fonts',
      version: `${FALLBACK_FONTS.length} files`,
      download: missing.length === 0 ? 'already downloaded' : formatBytes(missing.reduce((sum, a) => sum + a.sizeBytes, 0)),
      source: 'raw.githubusercontent.com (notofonts, google/fonts), pinned commits',
      destination: `vendor/fonts/noto/ (${formatBytes(total)})`,
      status: missing.length === 0 ? 'installed' : `not installed (${missing.length} of ${FALLBACK_FONTS.length} files to fetch)`,
    };
  },

  async run(ctx) {
    ctx.log.heading(TITLE);
    for (const artefact of FALLBACK_FONTS) {
      await mkdir(join(VENDOR, artefact.installDir), { recursive: true });
      const result = await ensureDownloaded(
        {
          step: TITLE,
          label: artefact.name,
          url: artefact.url,
          dest: pathOf(artefact),
          expectedSize: artefact.sizeBytes,
          sha256: artefact.sha256 as string,
          ...(ctx.fromDir !== undefined ? { fromDir: ctx.fromDir } : {}),
        },
        ctx.log,
      );
      upsertArtefact(ctx.lock, {
        id: artefact.id,
        name: artefact.name,
        version: artefact.version,
        url: artefact.url,
        fileName: artefact.fileName,
        sha256: result.sha256,
        sizeBytes: result.bytes,
        license: artefact.license,
        installPath: `${artefact.installDir}/${artefact.fileName}`,
      });
    }
    ctx.log.ok(`All ${FALLBACK_FONTS.length} fallback fonts verified`);
  },

  async verify(ctx) {
    ctx.log.heading(`Verify: ${TITLE}`);
    for (const artefact of FALLBACK_FONTS) {
      const path = pathOf(artefact);
      if (!existsSync(path)) {
        throw new SetupError({ step: TITLE, what: `${artefact.fileName} is not installed.`, fix: ['Run `npm run setup -- --tier core`.'] });
      }
      const actual = await sha256File(path);
      if (actual !== artefact.sha256) {
        throw new SetupError({
          step: TITLE,
          what: `${artefact.fileName} no longer matches its pinned SHA-256.`,
          likelyCause: `The file was modified or corrupted. Expected ${artefact.sha256}, got ${actual}.`,
          fix: [`Delete ${path} and re-run \`npm run setup -- --tier core\`.`],
        });
      }
    }
    ctx.log.ok(`All ${FALLBACK_FONTS.length} fallback fonts match their pinned hashes`);
  },
};
