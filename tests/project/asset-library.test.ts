// Asset library commands and "collect files" planning (M40).

import { describe, expect, it } from 'vitest';

import { collectedProjectName, planCollect } from '../../src/project/collect.ts';
import {
  CommandError, addLayer, assetUsage, relinkAsset, removeAsset, removeUnusedAssets, setLayerParam,
} from '../../src/project/commands.ts';
import { createDocument, createEffect, createModuleLayer } from '../../src/project/create.ts';
import type { AssetRef, ProjectDocument } from '../../src/project/document.ts';

const A1 = '0000000000A000000000000001';
const A2 = '0000000000A000000000000002';
const A3 = '0000000000A000000000000003';
const K1 = '0000000000K000000000000001';
const E1 = '0000000000E000000000000001';

const asset = (id: string, path: string, hash: string): AssetRef => ({ id, kind: 'image', path, hash, size: 10, name: path.split(/[\\/]/).pop()!, extra: {} });

function project(assets: AssetRef[]): ProjectDocument {
  return { ...createDocument({ name: 'My: Song', timestamp: '2026-09-15T00:00:00.000Z' }), assets };
}

describe('asset usage', () => {
  it('finds references in params, aspect overrides and effects', () => {
    let document = project([asset(A1, 'D:/a/sky.png', 'h1'), asset(A2, 'D:/a/logo.png', 'h2'), asset(A3, 'D:/a/x.png', 'h3')]);
    const layer = { ...createModuleLayer('core.source.background', { id: K1, name: 'Sky', params: { image: A1 } }), effects: [createEffect('fx.overlay', { id: E1, params: { texture: A3 } })] };
    document = addLayer(layer).apply(document);
    document = setLayerParam(K1, 'image', A2, '9:16').apply(document);
    const uses = assetUsage(document);
    expect(uses.get(A1)?.map((u) => u.where)).toEqual(['Sky · image']);
    expect(uses.get(A2)?.map((u) => u.where)).toEqual(['Sky · 9:16 · image']);
    expect(uses.get(A3)?.[0]?.where).toContain('texture');
  });

  it('removing a used asset is refused, an unused one goes', () => {
    let document = project([asset(A1, 'D:/a/sky.png', 'h1'), asset(A2, 'D:/a/logo.png', 'h2')]);
    document = addLayer(createModuleLayer('core.source.background', { id: K1, params: { image: A1 } })).apply(document);
    expect(() => removeAsset(A1).apply(document)).toThrow(CommandError);
    expect(removeAsset(A2).apply(document).assets.map((a) => a.id)).toEqual([A1]);
    expect(removeUnusedAssets().apply(document).assets.map((a) => a.id)).toEqual([A1]);
    const clean = removeUnusedAssets().apply(document);
    expect(removeUnusedAssets().apply(clean)).toBe(clean);
  });

  it('relink keeps the id, so layers follow', () => {
    const document = project([asset(A1, 'D:/old/sky.png', 'h1')]);
    const relinked = relinkAsset(A1, { path: 'E:/new/sky2.png', hash: 'h9', size: 99, name: 'sky2.png' }).apply(document);
    expect(relinked.assets[0]).toMatchObject({ id: A1, path: 'E:/new/sky2.png', hash: 'h9', size: 99, name: 'sky2.png' });
    expect(() => relinkAsset(A2, { path: '', hash: '', size: 0, name: '' }).apply(document)).toThrow(CommandError);
  });
});

describe('collect files', () => {
  it('copies audio and assets into audio/ and assets/ with relative paths', () => {
    const document = { ...project([asset(A1, 'art/sky.png', 'h1')]), audio: { ...createDocument().audio, path: 'D:\\music\\song.wav' } };
    const plan = planCollect(document, 'D:\\songs\\one.pvproj');
    expect(plan.copies).toEqual([
      { from: 'D:\\music\\song.wav', to: 'audio/song.wav', what: 'audio' },
      { from: 'D:\\songs\\art\\sky.png', to: 'assets/sky.png', what: A1 },
    ]);
    expect(plan.document.audio.path).toBe('audio/song.wav');
    expect(plan.document.assets[0]!.path).toBe('assets/sky.png');
    expect(plan.skipped).toEqual([]);
  });

  it('shares one copy for the same file, renames a different file with the same name', () => {
    const document = project([
      asset(A1, 'D:/a/sky.png', 'h1'),
      asset(A2, 'D:/b/sky.png', 'h2'), // same name, different file
      asset(A3, 'D:/c/copy-of-sky.png', 'h1'), // same content as A1
    ]);
    const plan = planCollect(document, null, (path) => path === 'assets/sky-2.png'); // already in the folder
    expect(plan.copies.map((c) => c.to)).toEqual(['assets/sky.png', 'assets/sky-3.png']);
    expect(plan.document.assets.map((a) => a.path)).toEqual(['assets/sky.png', 'assets/sky-3.png', 'assets/sky.png']);
  });

  it('skips what it cannot resolve rather than guessing', () => {
    const document = project([asset(A1, 'relative/sky.png', 'h1')]);
    const plan = planCollect(document, null);
    expect(plan.copies).toEqual([]);
    expect(plan.skipped[0]).toMatchObject({ what: A1, reason: expect.stringContaining('unsaved') });
    expect(plan.document.assets[0]!.path).toBe('relative/sky.png');
  });

  it('names the project file safely', () => {
    expect(collectedProjectName(project([]))).toBe('My_ Song.pvproj');
  });
});
