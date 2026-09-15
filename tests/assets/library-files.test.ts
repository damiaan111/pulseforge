// Folder search for moved files, and collecting a project into one folder (M40) — on a real disk.

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { collectProject } from '../../src/assets/collect-files.ts';
import { findFilesInFolder, sha256File } from '../../src/assets/find-in-folder.ts';
import { createDocument } from '../../src/project/create.ts';
import { loadDocument } from '../../src/project/load.ts';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pulseforge-library-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function file(path: string, text: string): Promise<string> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, text);
  return path;
}

describe('findFilesInFolder', () => {
  it('finds a renamed file by content and refuses a same-name file with different bytes', async () => {
    const original = await file(join(root, 'orig', 'sky.png'), 'the sky bytes');
    const hash = await sha256File(original);
    await file(join(root, 'search', 'sky.png'), 'a different sky');
    const renamed = await file(join(root, 'search', 'deep', 'er', 'renamed.png'), 'the sky bytes');

    const result = await findFilesInFolder(join(root, 'search'), [{ id: 'a1', name: 'sky.png', size: 13, hash }]);
    expect(result.found).toEqual([{ id: 'a1', path: renamed, size: 13, name: 'renamed.png', hash }]);
    expect(result.truncated).toBe(false);
  });

  it('without a recorded size, matches by name then verifies the hash', async () => {
    const hash = await sha256File(await file(join(root, 'x', 'logo.png'), 'logo'));
    const moved = await file(join(root, 'search', 'LOGO.png'), 'logo');
    const result = await findFilesInFolder(join(root, 'search'), [{ id: 'a2', name: 'logo.png', size: 0, hash }]);
    expect(result.found.map((f) => f.path)).toEqual([moved]);
  });

  it('reports when a limit cut the search short', async () => {
    for (let i = 0; i < 5; i += 1) await file(join(root, 'many', `f${i}.txt`), String(i));
    const result = await findFilesInFolder(join(root, 'many'), [{ id: 'a', name: 'nope', size: 999, hash: 'x' }], { maxFiles: 3 });
    expect(result.truncated).toBe(true);
  });
});

describe('collectProject', () => {
  it('copies audio and assets, writes a project with relative paths that loads, and reports missing files', async () => {
    const audio = await file(join(root, 'music', 'song.wav'), 'RIFF....');
    const sky = await file(join(root, 'art', 'sky.png'), 'png!');
    const document = {
      ...createDocument({ name: 'Night Drive', timestamp: '2026-09-15T00:00:00.000Z', audio: { path: audio } }),
      assets: [
        { id: '0000000000A000000000000001', kind: 'image' as const, path: sky, hash: 'h1', size: 4, name: 'sky.png', extra: {} },
        { id: '0000000000A000000000000002', kind: 'image' as const, path: join(root, 'art', 'gone.png'), hash: 'h2', size: 4, name: 'gone.png', extra: {} },
      ],
    };
    const destination = join(root, 'collected');
    const result = await collectProject(document, null, destination);

    expect(result.copied).toBe(2);
    expect(result.problems).toEqual([expect.stringContaining('"gone.png": missing')]);
    expect(result.projectPath).toBe(join(destination, 'Night Drive.pvproj'));
    expect(await readFile(join(destination, 'audio', 'song.wav'), 'utf8')).toBe('RIFF....');
    expect(existsSync(join(destination, 'assets', 'sky.png'))).toBe(true);

    const reopened = loadDocument(await readFile(result.projectPath, 'utf8')).document;
    expect(reopened.audio.path).toBe('audio/song.wav');
    expect(reopened.assets.map((a) => a.path)).toEqual(['assets/sky.png', join(root, 'art', 'gone.png')]);

    // Collecting again into the same folder never overwrites: new names, new project file.
    const again = await collectProject(document, null, destination);
    expect(again.projectPath).toBe(join(destination, 'Night Drive-2.pvproj'));
    const second = loadDocument(await readFile(again.projectPath, 'utf8')).document;
    expect(second.audio.path).toBe('audio/song-2.wav');
  });
});
