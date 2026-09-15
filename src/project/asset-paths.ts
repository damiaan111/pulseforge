// Where a project's files are, relative to the project (data-formats §1.2, M40).
//
// The rule: a file **inside the project's folder** is stored relative to the project file; any
// other file is stored absolute. That is what "moving a project folder doesn't break it" needs in
// both directions — a folder moved as a whole carries its relative files with it, and a file
// elsewhere on disk is still found by its absolute path. (Relative paths climbing out with `..`
// would break exactly when the folder moves, so they are never written.)
//
// In memory the studio holds **absolute** paths: they are resolved once when a project opens and
// made relative again when it is written, against whichever file it is written to. That makes
// "Save as" into another folder correct by construction, where rewriting stored relative paths in
// place would silently point them at the wrong files.
//
// String-only, no `node:path`: this runs in the sandboxed renderer as well as in Node, and has to
// handle Windows paths on either.

import type { AssetRef, ProjectDocument } from './document.ts';

/** `C:\…`, `C:/…`, `\\server\share`, or `/…`. */
export function isAbsolutePath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || /^[\\/]/.test(path);
}

/** The folder a project file sits in, without a trailing separator. */
export function projectFolder(projectPath: string): string {
  const cut = Math.max(projectPath.lastIndexOf('/'), projectPath.lastIndexOf('\\'));
  return cut < 0 ? '' : projectPath.slice(0, cut);
}

/** The last path segment. */
export function fileName(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return path.slice(cut + 1);
}

function segments(path: string): string[] {
  const out: string[] = [];
  for (const part of path.split(/[\\/]+/)) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out;
}

/** Prefix of an absolute path that `segments` drops: the drive, the UNC marker or the root slash. */
function root(path: string): string {
  const drive = /^([a-zA-Z]:)[\\/]/.exec(path);
  if (drive !== null) return `${drive[1]!.toUpperCase()}\\`;
  if (/^[\\/]{2}/.test(path)) return '\\\\';
  return '/';
}

/** Windows paths compare case-insensitively; POSIX ones do not. */
function sameSegment(a: string, b: string, windows: boolean): boolean {
  return windows ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** A stored path resolved against the project file. Absolute stays absolute (normalised). */
export function resolveProjectPath(stored: string, projectPath: string | null): string {
  if (stored === '') return '';
  if (isAbsolutePath(stored)) return normalise(stored);
  if (projectPath === null) return stored;
  return normalise(`${projectFolder(projectPath)}/${stored}`);
}

/** Absolute path, with the platform's separators and no `.` or `..` segments. */
function normalise(path: string): string {
  const prefix = root(path);
  const windows = prefix !== '/';
  return `${prefix}${segments(path.slice(prefix === '\\\\' ? 2 : prefix === '/' ? 1 : 3)).join(windows ? '\\' : '/')}`;
}

/**
 * The path to write for a file: relative (with `/`, which every platform reads) when it is inside
 * the project's folder, absolute otherwise.
 */
export function storedProjectPath(absolute: string, projectPath: string): string {
  if (absolute === '' || !isAbsolutePath(absolute)) return absolute;
  const file = normalise(absolute);
  const folder = normalise(projectFolder(projectPath) || projectPath);
  const fileRoot = root(file);
  if (fileRoot !== root(folder)) return file;
  const windows = fileRoot !== '/';
  const skip = fileRoot === '/' ? 1 : fileRoot === '\\\\' ? 2 : 3;
  const fileParts = segments(file.slice(skip));
  const folderParts = segments(folder.slice(skip));
  if (fileParts.length <= folderParts.length) return file;
  for (const [i, part] of folderParts.entries()) {
    if (!sameSegment(part, fileParts[i]!, windows)) return file;
  }
  return fileParts.slice(folderParts.length).join('/');
}

function mapPaths(document: ProjectDocument, map: (path: string) => string): ProjectDocument {
  const audioPath = map(document.audio.path);
  let assetsChanged = false;
  const assets: AssetRef[] = document.assets.map((asset) => {
    const path = map(asset.path);
    if (path === asset.path) return asset;
    assetsChanged = true;
    return { ...asset, path };
  });
  if (audioPath === document.audio.path && !assetsChanged) return document;
  return {
    ...document,
    audio: audioPath === document.audio.path ? document.audio : { ...document.audio, path: audioPath },
    assets: assetsChanged ? assets : document.assets,
  };
}

/** Opened from `projectPath`: every stored path made absolute, for the studio to hold. */
export function withAbsolutePaths(document: ProjectDocument, projectPath: string | null): ProjectDocument {
  return mapPaths(document, (path) => resolveProjectPath(path, projectPath));
}

/** About to be written to `projectPath`: files inside its folder made relative. */
export function withStoredPaths(document: ProjectDocument, projectPath: string): ProjectDocument {
  return mapPaths(document, (path) => storedProjectPath(path, projectPath));
}
