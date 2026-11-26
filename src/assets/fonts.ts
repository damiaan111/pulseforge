// Font files for rendering (M16, PROJECT.md §8.13): the bundled default, and the fonts a document
// references. Node-side: it reads files and hashes them; the renderer registers the bytes.
//
// Fonts are passed to renderers as *files* (path + hash), not bytes, because every renderer that
// draws text — the export and frames harness in Electron — has file access, and the studio gets
// them through IPC.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { COLOR_EMOJI_FILE, DEFAULT_FONT_FILE, FALLBACK_FONTS_DIR } from '../../setup/lib/paths.ts';
import { COLOR_EMOJI_FONT, FALLBACK_FONTS } from '../../setup/manifest.ts';
import type { ProjectDocument } from '../project/document.ts';
import { resolveAssetPath } from './load-images.ts';
import type { AssetProblem } from './load-images.ts';

export const FONT_EXTENSIONS = ['ttf', 'otf', 'woff', 'woff2'] as const;

export interface FontFile {
  readonly hash: string;
  readonly file: string;
}

let defaultFont: FontFile | undefined;

/** The bundled Inter Regular, hashed once per process. Throws with the fix when setup has not run. */
export function defaultFontFile(): FontFile {
  if (defaultFont !== undefined) return defaultFont;
  if (!existsSync(DEFAULT_FONT_FILE)) {
    throw new Error(`The bundled default font is missing (${DEFAULT_FONT_FILE}). Run \`npm run setup\` to provision vendor/fonts.`);
  }
  defaultFont = { hash: createHash('sha256').update(readFileSync(DEFAULT_FONT_FILE)).digest('hex'), file: DEFAULT_FONT_FILE };
  return defaultFont;
}

let fallbackFonts: readonly FontFile[] | undefined;

/**
 * The bundled fallback chain (S17), in order, as far as it is installed. The hashes are the pinned
 * ones: these fonts are read on every render, and hashing 19 MB each time would buy nothing that
 * `npm run setup -- --verify` does not. One that is missing is left out, and a text layer that
 * needed it reports the characters it could not draw.
 */
export function fallbackFontFiles(): readonly FontFile[] {
  fallbackFonts ??= FALLBACK_FONTS
    .map((font) => ({ hash: font.sha256 as string, file: join(FALLBACK_FONTS_DIR, font.fileName) }))
    .filter((font) => existsSync(font.file));
  return fallbackFonts;
}

/** The colour emoji font, if its component is installed. Not cached: it can be added while the app runs. */
export function colorEmojiFontFile(): FontFile | null {
  return existsSync(COLOR_EMOJI_FILE) ? { hash: COLOR_EMOJI_FONT.sha256 as string, file: COLOR_EMOJI_FILE } : null;
}

/**
 * Every font asset in the document that can be found. A missing or changed file is a problem, not
 * an error: the text layer draws with the default font and reports it, exactly as the preview did.
 * A changed file is still passed on — under the *recorded* hash, which is what the snapshot asks for.
 */
export function loadFontAssets(document: ProjectDocument, projectPath: string | null): { fonts: FontFile[]; problems: AssetProblem[] } {
  const fonts: FontFile[] = [];
  const problems: AssetProblem[] = [];
  for (const asset of document.assets) {
    if (asset.kind !== 'font') continue;
    const path = resolveAssetPath(asset.path, projectPath);
    if (path === undefined || !existsSync(path)) {
      problems.push({ assetId: asset.id, detail: `font "${asset.name}" is missing${path === undefined ? '' : `: ${path}`}` });
      continue;
    }
    const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (hash !== asset.hash) problems.push({ assetId: asset.id, detail: `font "${asset.name}" has changed on disk since it was chosen (${path})` });
    fonts.push({ hash: asset.hash, file: path });
  }
  return { fonts, problems };
}
