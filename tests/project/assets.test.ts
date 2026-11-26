// Image assets in the document (M14): stored by id, round-tripped, deduplicated by content hash,
// and handed to the engine as id → hash. Plus the pure pieces of the background module and the
// image decoder that do not need a GPU or FFmpeg.

import { describe, expect, it } from 'vitest';

import { decodeSize, MAX_IMAGE_SIDE } from '../../src/assets/image-decode.ts';
import { resolveAssetPath } from '../../src/assets/load-images.ts';
import { kenBurns } from '../../src/engine/modules/background.ts';
import { CommandError, addAsset, findAssetByHash, sequence, setLayerParam, addLayer } from '../../src/project/commands.ts';
import { createDocument, createModuleLayer } from '../../src/project/create.ts';
import type { AssetRef } from '../../src/project/document.ts';
import { loadDocument } from '../../src/project/load.ts';
import { stringifyDocument } from '../../src/project/serialize.ts';
import { toRenderProject } from '../../src/project/snapshot.ts';

const A1 = '0000000000A000000000000001';
const A2 = '0000000000A000000000000002';
const K1 = '0000000000K000000000000001';

const asset = (id: string, hash: string, name = 'sky.png'): AssetRef => ({ id, kind: 'image', path: `D:/art/${name}`, hash, size: 1234, name, extra: {} });
const blank = () => createDocument({ timestamp: '2026-09-15T00:00:00.000Z', id: '0000000000P000000000000001' });

describe('asset commands', () => {
  it('adds an asset and finds it by hash', () => {
    const document = addAsset(asset(A1, 'abc')).apply(blank());
    expect(document.assets).toHaveLength(1);
    expect(findAssetByHash(document, 'abc')?.id).toBe(A1);
  });

  it('does not add the same file twice', () => {
    const once = addAsset(asset(A1, 'abc')).apply(blank());
    expect(addAsset(asset(A2, 'abc')).apply(once)).toBe(once);
  });

  it('rejects a duplicate id', () => {
    const once = addAsset(asset(A1, 'abc')).apply(blank());
    expect(() => addAsset(asset(A1, 'def')).apply(once)).toThrow(CommandError);
  });

  it('sequence applies commands in order as one step', () => {
    const withLayer = addLayer(createModuleLayer('core.source.background', { id: K1 })).apply(blank());
    const command = sequence('Use image', [addAsset(asset(A1, 'abc')), setLayerParam(K1, 'image', A1, 'base')]);
    const after = command.apply(withLayer);
    expect(after.assets.map((a) => a.id)).toEqual([A1]);
    const layer = after.layers[0];
    expect(layer?.kind === 'module' ? layer.params['image'] : undefined).toBe(A1);
    expect(command.label).toBe('Use image');
  });
});

describe('assets on disk', () => {
  it('round-trips through save and load, keeping unknown fields', () => {
    const document = { ...blank(), assets: [{ ...asset(A1, 'abc'), extra: { futureField: 7 } }] };
    const text = stringifyDocument(document);
    const loaded = loadDocument(text);
    // The unknown field is reported as preserved — the point is that it survives.
    expect(loaded.issues.map((i) => i.path)).toEqual(['assets[0].futureField']);
    expect(loaded.document.assets).toEqual(document.assets);
    expect(stringifyDocument(loaded.document)).toBe(text);
  });

  it('writes nothing for a project without assets, so older files stay byte-identical', () => {
    expect(stringifyDocument(blank())).not.toContain('"assets"');
  });

  it('keeps and reports an asset of a kind this build does not know', () => {
    const json = JSON.parse(stringifyDocument(blank())) as Record<string, unknown>;
    json['assets'] = [{ id: A1, kind: 'hologram', path: 'x.holo', hash: 'h', name: 'x' }];
    const loaded = loadDocument(JSON.stringify(json));
    expect(loaded.issues.some((i) => i.path.includes('kind'))).toBe(true);
    expect(loaded.document.assets).toHaveLength(1);
  });

  it('hands the engine id → hash, not paths', () => {
    const document = { ...blank(), assets: [asset(A1, 'abc')] };
    expect(toRenderProject(document).project.assets).toEqual({ [A1]: { kind: 'image', hash: 'abc', name: 'sky.png' } });
    expect(toRenderProject(blank()).project.assets).toBeUndefined();
  });
});

describe('asset paths', () => {
  it('resolves relative paths against the project and leaves absolute ones alone', () => {
    expect(resolveAssetPath('art/sky.png', 'D:/songs/one.pvproj')?.replace(/\\/g, '/')).toBe('D:/songs/art/sky.png');
    expect(resolveAssetPath('D:/art/sky.png', null)).toBe('D:/art/sky.png');
    expect(resolveAssetPath('art/sky.png', null)).toBeUndefined();
    expect(resolveAssetPath('', 'D:/songs/one.pvproj')).toBeUndefined();
  });
});

describe('image decode size', () => {
  it('keeps images within the limit and scales larger ones by the longer side', () => {
    expect(decodeSize(1920, 1080)).toEqual({ width: 1920, height: 1080 });
    expect(decodeSize(16_384, 4096)).toEqual({ width: MAX_IMAGE_SIDE, height: 2048 });
    expect(decodeSize(100, 20_000, 1000)).toEqual({ width: 5, height: 1000 });
  });
});

describe('Ken Burns framing', () => {
  it('is the identity with no zoom and no drift', () => {
    const { scale, offsetX, offsetY } = kenBurns(12.3, 1, 0, 30);
    expect([scale, Math.abs(offsetX), Math.abs(offsetY)]).toEqual([1, 0, 0]);
  });

  it('never reveals the image edge in cover mode, at any time or drift', () => {
    for (const drift of [0, 0.25, 0.5, 1]) {
      for (let t = 0; t < 60; t += 0.37) {
        const { scale, offsetX, offsetY } = kenBurns(t, 1, drift, 17);
        expect(0.5 / scale + Math.abs(offsetX)).toBeLessThanOrEqual(0.5 + 1e-12);
        expect(0.5 / scale + Math.abs(offsetY)).toBeLessThanOrEqual(0.5 + 1e-12);
      }
    }
  });

  it('is a function of time alone', () => {
    expect(kenBurns(42, 1.5, 0.7, 20)).toEqual(kenBurns(42, 1.5, 0.7, 20));
    expect(kenBurns(0, 1, 1, 20)).not.toEqual(kenBurns(5, 1, 1, 20));
  });
});
