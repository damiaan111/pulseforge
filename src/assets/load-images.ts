// A document's image assets → decoded pixels, for whoever is about to render it.
//
// Shared by the export pipeline and the studio so both resolve a stored path the same way and
// report the same problems. A missing or changed file is **reported, not fatal** (CLAUDE.md
// constraint 4): the render goes ahead and the engine draws its missing-image placeholder, which
// is what the preview showed too.

import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

import type { AssetRef, ProjectDocument } from '../project/document.ts';
import { decodeImageFile, type ImportedImage } from './image-decode.ts';

export interface AssetProblem {
  readonly assetId: string;
  readonly detail: string;
}

export interface LoadedImages {
  /** By the hash the document records — which is what the render snapshot looks up. */
  readonly images: ReadonlyMap<string, ImportedImage>;
  readonly problems: readonly AssetProblem[];
}

/** Stored asset paths are relative to the project file when they can be (data-formats §1.2). */
export function resolveAssetPath(stored: string, projectPath: string | null): string | undefined {
  if (stored === '') return undefined;
  if (isAbsolute(stored)) return stored;
  return projectPath === null ? undefined : join(dirname(projectPath), stored);
}

export async function loadImageAssets(
  document: ProjectDocument,
  projectPath: string | null,
  tools: { readonly ffmpegExe: string; readonly ffprobeExe: string },
): Promise<LoadedImages> {
  const images = new Map<string, ImportedImage>();
  const problems: AssetProblem[] = [];
  for (const asset of document.assets) {
    if (asset.kind !== 'image') continue;
    const loaded = await loadOne(asset, projectPath, tools, problems);
    // Registered under the recorded hash even when the file has changed: the layer asked for this
    // asset, and a changed file drawing (with a warning) beats a placeholder the user cannot explain.
    if (loaded !== undefined) images.set(asset.hash, loaded);
  }
  return { images, problems };
}

async function loadOne(
  asset: AssetRef,
  projectPath: string | null,
  tools: { readonly ffmpegExe: string; readonly ffprobeExe: string },
  problems: AssetProblem[],
): Promise<ImportedImage | undefined> {
  const path = resolveAssetPath(asset.path, projectPath);
  if (path === undefined || !existsSync(path)) {
    problems.push({
      assetId: asset.id,
      detail: path === undefined
        ? `image "${asset.name}" has a relative path and the project is not saved, so it cannot be found`
        : `image "${asset.name}" is missing: ${path}`,
    });
    return undefined;
  }
  try {
    const image = await decodeImageFile(tools.ffmpegExe, tools.ffprobeExe, path);
    if (image.sha256 !== asset.hash) {
      problems.push({ assetId: asset.id, detail: `image "${asset.name}" has changed on disk since it was imported (${path})` });
    }
    return image;
  } catch (error) {
    problems.push({ assetId: asset.id, detail: (error as Error).message });
    return undefined;
  }
}
