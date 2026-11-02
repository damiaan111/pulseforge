import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { COLOR_EMOJI_FONT } from '../manifest.ts';
import { ensureDownloaded, sha256File } from '../lib/download.ts';
import { SetupError } from '../lib/errors.ts';
import { upsertArtefact } from '../lib/lockfile.ts';
import { formatBytes } from '../lib/log.ts';
import { COLOR_EMOJI_FILE } from '../lib/paths.ts';
import type { Step } from './types.ts';

// The colour emoji font, as an optional component: only titles that ask for colour read it.

const TITLE = 'Colour emoji (Noto Color Emoji)';

export const colorEmojiStep: Step = {
  id: 'color-emoji',
  title: TITLE,
  tier: 'emoji',

  async describe() {
    const installed = existsSync(COLOR_EMOJI_FILE);
    return {
      name: 'Colour emoji',
      version: COLOR_EMOJI_FONT.version,
      download: installed ? 'already downloaded' : formatBytes(COLOR_EMOJI_FONT.sizeBytes),
      source: COLOR_EMOJI_FONT.url,
      destination: 'vendor/fonts/emoji/',
      status: installed ? 'installed' : 'not installed',
    };
  },

  async run(ctx) {
    ctx.log.heading(TITLE);
    await mkdir(dirname(COLOR_EMOJI_FILE), { recursive: true });
    const result = await ensureDownloaded(
      {
        step: TITLE,
        label: COLOR_EMOJI_FONT.name,
        url: COLOR_EMOJI_FONT.url,
        dest: COLOR_EMOJI_FILE,
        sha256: COLOR_EMOJI_FONT.sha256 as string,
        expectedSize: COLOR_EMOJI_FONT.sizeBytes,
        ...(ctx.fromDir !== undefined ? { fromDir: ctx.fromDir } : {}),
      },
      ctx.log,
    );
    upsertArtefact(ctx.lock, {
      id: COLOR_EMOJI_FONT.id,
      name: COLOR_EMOJI_FONT.name,
      version: COLOR_EMOJI_FONT.version,
      url: COLOR_EMOJI_FONT.url,
      fileName: COLOR_EMOJI_FONT.fileName,
      sha256: result.sha256,
      sizeBytes: result.bytes,
      license: COLOR_EMOJI_FONT.license,
      installPath: `${COLOR_EMOJI_FONT.installDir}/${COLOR_EMOJI_FONT.fileName}`,
    });
    ctx.log.ok('Colour emoji ready');
  },

  async verify(ctx) {
    ctx.log.heading(`Verify: ${TITLE}`);
    if (!existsSync(COLOR_EMOJI_FILE)) {
      throw new SetupError({ step: TITLE, what: 'The colour emoji font is not installed.', fix: ['Add it in Settings → Components, or run `npm run setup -- --components emoji`.'] });
    }
    if ((await sha256File(COLOR_EMOJI_FILE)) !== COLOR_EMOJI_FONT.sha256) {
      throw new SetupError({ step: TITLE, what: `${COLOR_EMOJI_FONT.fileName} no longer matches its pinned SHA-256.`, fix: [`Delete ${COLOR_EMOJI_FILE} and run setup again.`] });
    }
    ctx.log.ok('The font matches its pinned hash');
  },
};
