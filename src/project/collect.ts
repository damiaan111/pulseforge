// "Collect files" (M40, PROJECT.md S19, data-formats §1.2): a project and every file it uses,
// copied into one folder that can be zipped, archived or moved to another machine.
//
// This file only *plans*: which file goes where, and the document rewritten to point at the
// copies. The copying is the main process's job. Keeping the plan pure means the naming rules —
// the part that goes wrong quietly — are tested without touching a disk.
//
// Layout: `<folder>/<project>.pvproj`, `<folder>/audio/<file>`, `<folder>/assets/<file>`. Paths in
// the collected document are relative (they are inside its folder by construction), so the folder
// can be moved anywhere and still opens.

import { fileName, resolveProjectPath } from './asset-paths.ts';
import type { ProjectDocument } from './document.ts';

export interface CollectCopy {
  /** Absolute source. */
  readonly from: string;
  /** Relative to the collect folder, `/`-separated. */
  readonly to: string;
  /** `audio`, or the asset id. */
  readonly what: string;
}

export interface CollectPlan {
  /** The document as it must be written into the collect folder. */
  readonly document: ProjectDocument;
  readonly copies: readonly CollectCopy[];
  /** References with no file to collect (empty or unresolvable paths) — kept as they were, and reported. */
  readonly skipped: readonly { readonly what: string; readonly path: string; readonly reason: string }[];
}

/** Characters Windows will not put in a file name, plus control characters. */
function safeName(name: string): string {
  let out = '';
  for (const ch of name) out += ch < ' ' || '<>:"/\\|?*'.includes(ch) ? '_' : ch;
  out = out.trim().replace(/[. ]+$/, '');
  return out === '' ? 'file' : out;
}

/**
 * Plans a collect. `sourceProjectPath` resolves any relative stored path; `taken` says whether a
 * relative target already exists in the destination, so an existing file is never overwritten.
 *
 * Naming: each file keeps its own name; a second, *different* file with the same name gets
 * `name-2.ext`, `name-3.ext`, …; two assets that are the same file (same hash, or same source
 * path) share one copy.
 */
export function planCollect(
  document: ProjectDocument,
  sourceProjectPath: string | null,
  taken: (relativePath: string) => boolean = () => false,
): CollectPlan {
  const copies: CollectCopy[] = [];
  const skipped: { what: string; path: string; reason: string }[] = [];
  const used = new Set<string>();
  const bySource = new Map<string, string>();
  const byHash = new Map<string, string>();

  const place = (folder: string, source: string): string => {
    const base = safeName(fileName(source));
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : '';
    for (let n = 1; ; n += 1) {
      const candidate = `${folder}/${n === 1 ? base : `${stem}-${n}${ext}`}`;
      const key = candidate.toLowerCase(); // Windows file names are case-insensitive
      if (!used.has(key) && !taken(candidate)) {
        used.add(key);
        return candidate;
      }
    }
  };

  let audioPath = document.audio.path;
  if (document.audio.path !== '') {
    const source = resolveProjectPath(document.audio.path, sourceProjectPath);
    if (sourceProjectPath === null && !/^([a-zA-Z]:)?[\\/]/.test(source)) {
      skipped.push({ what: 'audio', path: source, reason: 'relative path in an unsaved project' });
    } else {
      audioPath = place('audio', source);
      bySource.set(source.toLowerCase(), audioPath);
      copies.push({ from: source, to: audioPath, what: 'audio' });
    }
  }

  const assets = document.assets.map((asset) => {
    if (asset.path === '') {
      skipped.push({ what: asset.id, path: '', reason: 'no path' });
      return asset;
    }
    const source = resolveProjectPath(asset.path, sourceProjectPath);
    if (sourceProjectPath === null && !/^([a-zA-Z]:)?[\\/]/.test(source)) {
      skipped.push({ what: asset.id, path: source, reason: 'relative path in an unsaved project' });
      return asset;
    }
    const shared = (asset.hash !== '' ? byHash.get(asset.hash) : undefined) ?? bySource.get(source.toLowerCase());
    if (shared !== undefined) return { ...asset, path: shared };
    const target = place('assets', source);
    if (asset.hash !== '') byHash.set(asset.hash, target);
    bySource.set(source.toLowerCase(), target);
    copies.push({ from: source, to: target, what: asset.id });
    return { ...asset, path: target };
  });

  return {
    document: { ...document, audio: { ...document.audio, path: audioPath }, assets },
    copies,
    skipped,
  };
}

/** The project file's name inside the collect folder. */
export function collectedProjectName(document: ProjectDocument): string {
  return `${safeName(document.name === '' ? 'project' : document.name)}.pvproj`;
}
