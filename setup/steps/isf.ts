import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ISF_FILES } from '../manifest.ts';
import { installArchive, isInstalled } from '../lib/archive.ts';
import { ensureDownloaded, sha256File } from '../lib/download.ts';
import { SetupError } from '../lib/errors.ts';
import { upsertArtefact } from '../lib/lockfile.ts';
import { formatBytes } from '../lib/log.ts';
import { DOWNLOADS, ISF_DIR } from '../lib/paths.ts';
import type { Step } from './types.ts';

// The ISF shader library, as an optional component. Plain text shaders: the module scan reads them
// where they land, so unlike the MilkDrop presets there is nothing to generate.

const TITLE = 'ISF shaders (Vidvox ISF-Files)';

export const isfStep: Step = {
  id: 'isf',
  title: TITLE,
  tier: 'isf',

  async describe() {
    const installed = existsSync(ISF_DIR);
    return {
      name: 'ISF shaders',
      version: ISF_FILES.version,
      download: installed ? 'already downloaded' : formatBytes(ISF_FILES.sizeBytes),
      source: ISF_FILES.url,
      destination: 'vendor/isf/',
      status: installed ? 'installed' : 'not installed',
    };
  },

  async run(ctx) {
    ctx.log.heading(TITLE);
    const archive = join(DOWNLOADS, ISF_FILES.fileName);
    const result = await ensureDownloaded(
      {
        step: TITLE,
        label: ISF_FILES.name,
        url: ISF_FILES.url,
        dest: archive,
        sha256: ISF_FILES.sha256,
        expectedSize: ISF_FILES.sizeBytes,
        ...(ctx.fromDir !== undefined ? { fromDir: ctx.fromDir } : {}),
      },
      ctx.log,
    );
    if (!(await isInstalled(ISF_FILES))) await installArchive(archive, ISF_FILES, TITLE, ctx.log);
    upsertArtefact(ctx.lock, {
      id: ISF_FILES.id,
      name: ISF_FILES.name,
      version: ISF_FILES.version,
      url: ISF_FILES.url,
      fileName: ISF_FILES.fileName,
      sha256: result.sha256,
      sizeBytes: result.bytes,
      license: ISF_FILES.license,
      installPath: `${ISF_FILES.installDir}/`,
    });
    ctx.log.ok('ISF shaders ready');
  },

  async verify(ctx) {
    ctx.log.heading(`Verify: ${TITLE}`);
    const archive = join(DOWNLOADS, ISF_FILES.fileName);
    if (!existsSync(ISF_DIR) || !existsSync(archive)) {
      throw new SetupError({ step: TITLE, what: 'The ISF shaders are not installed.', fix: ['Add them in Settings → Components, or run `npm run setup -- --components isf`.'] });
    }
    if ((await sha256File(archive)) !== ISF_FILES.sha256) {
      throw new SetupError({ step: TITLE, what: `${ISF_FILES.fileName} no longer matches its pinned SHA-256.`, fix: [`Delete ${archive} and run setup again.`] });
    }
    ctx.log.ok('The shader library matches its pinned hash');
  },
};
