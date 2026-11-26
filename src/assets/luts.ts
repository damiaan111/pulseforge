// LUT files for rendering (S11): the .cube assets a document references, read for an export. Node-side,
// like fonts.ts: it reads and checks the files; the renderer parses and registers the text.
//
// A missing, changed or unreadable LUT is a problem, not an error: the render goes ahead, the LUT
// effect passes the picture through and says so, exactly as the preview does.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { CubeParseError, parseCube } from '../engine/core/lut.ts';
import type { ProjectDocument } from '../project/document.ts';
import { resolveAssetPath, type AssetProblem } from './load-images.ts';

export function loadLutAssets(document: ProjectDocument, projectPath: string | null): { luts: { hash: string; text: string }[]; problems: AssetProblem[] } {
  const luts: { hash: string; text: string }[] = [];
  const problems: AssetProblem[] = [];
  for (const asset of document.assets) {
    if (asset.kind !== 'lut') continue;
    const path = resolveAssetPath(asset.path, projectPath);
    if (path === undefined || !existsSync(path)) {
      problems.push({ assetId: asset.id, detail: `LUT "${asset.name}" is missing${path === undefined ? '' : `: ${path}`}` });
      continue;
    }
    const bytes = readFileSync(path);
    const text = bytes.toString('utf8');
    try {
      parseCube(text);
    } catch (error) {
      problems.push({ assetId: asset.id, detail: `LUT "${asset.name}" cannot be read: ${error instanceof CubeParseError ? error.message : String(error)}` });
      continue;
    }
    if (createHash('sha256').update(bytes).digest('hex') !== asset.hash) {
      problems.push({ assetId: asset.id, detail: `LUT "${asset.name}" has changed on disk since it was chosen (${path})` });
    }
    // Under the recorded hash, which is what the render project looks up; a changed file still grades.
    luts.push({ hash: asset.hash, text });
  }
  return { luts, problems };
}
