// Project-relative paths (data-formats §1.2, M40).

import { describe, expect, it } from 'vitest';

import {
  fileName, isAbsolutePath, projectFolder, resolveProjectPath, storedProjectPath, withAbsolutePaths, withStoredPaths,
} from '../../src/project/asset-paths.ts';
import { createDocument } from '../../src/project/create.ts';

const P = 'D:\\songs\\one\\one.pvproj';

describe('path helpers', () => {
  it('recognises absolute paths on both platforms', () => {
    expect(isAbsolutePath('C:\\a')).toBe(true);
    expect(isAbsolutePath('c:/a')).toBe(true);
    expect(isAbsolutePath('\\\\server\\share\\a')).toBe(true);
    expect(isAbsolutePath('/home/a')).toBe(true);
    expect(isAbsolutePath('art/a.png')).toBe(false);
    expect(isAbsolutePath('C:a')).toBe(false);
  });

  it('splits folders and names', () => {
    expect(projectFolder(P)).toBe('D:\\songs\\one');
    expect(fileName('D:/x/y/sky.png')).toBe('sky.png');
  });

  it('resolves relative paths against the project folder, normalising dots', () => {
    expect(resolveProjectPath('art/sky.png', P)).toBe('D:\\songs\\one\\art\\sky.png');
    expect(resolveProjectPath('./art/../sky.png', P)).toBe('D:\\songs\\one\\sky.png');
    expect(resolveProjectPath('d:/Music/a.wav', P)).toBe('D:\\Music\\a.wav');
    expect(resolveProjectPath('/home/me/a.wav', '/home/me/p/x.pvproj')).toBe('/home/me/a.wav');
    expect(resolveProjectPath('a.wav', '/home/me/p/x.pvproj')).toBe('/home/me/p/a.wav');
    expect(resolveProjectPath('art/sky.png', null)).toBe('art/sky.png');
    expect(resolveProjectPath('', P)).toBe('');
  });

  it('stores files inside the project folder relative, everything else absolute', () => {
    expect(storedProjectPath('D:\\songs\\one\\art\\sky.png', P)).toBe('art/sky.png');
    expect(storedProjectPath('d:/SONGS/one/sky.png', P)).toBe('sky.png'); // Windows: case-insensitive
    expect(storedProjectPath('D:\\songs\\other\\sky.png', P)).toBe('D:\\songs\\other\\sky.png'); // no ../
    expect(storedProjectPath('E:\\songs\\one\\sky.png', P)).toBe('E:\\songs\\one\\sky.png');
    expect(storedProjectPath('D:\\songs\\one', P)).toBe('D:\\songs\\one');
    expect(storedProjectPath('/home/me/p/a.wav', '/home/me/p/x.pvproj')).toBe('a.wav');
    expect(storedProjectPath('/home/Me/p/a.wav', '/home/me/p/x.pvproj')).toBe('/home/Me/p/a.wav'); // POSIX: case matters
  });
});

describe('document paths', () => {
  const document = {
    ...createDocument({ timestamp: '2026-09-15T00:00:00.000Z', audio: { path: 'audio/song.wav' } }),
    assets: [{ id: '0000000000A000000000000001', kind: 'image' as const, path: 'D:\\art\\sky.png', hash: 'h', size: 1, name: 'sky.png', extra: {} }],
  };

  it('round-trips: open resolves, save relativises against the file it is written to', () => {
    const open = withAbsolutePaths(document, P);
    expect(open.audio.path).toBe('D:\\songs\\one\\audio\\song.wav');
    expect(open.assets[0]!.path).toBe('D:\\art\\sky.png');
    expect(withStoredPaths(open, P).audio.path).toBe('audio/song.wav');
  });

  it('save as into another folder keeps pointing at the same files', () => {
    const open = withAbsolutePaths(document, P);
    const moved = withStoredPaths(open, 'E:\\archive\\one.pvproj');
    expect(moved.audio.path).toBe('D:\\songs\\one\\audio\\song.wav');
  });

  it('returns the same document when nothing changes', () => {
    const absolute = withAbsolutePaths(document, P);
    expect(withAbsolutePaths(absolute, P)).toBe(absolute);
  });
});
