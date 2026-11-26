// Masks in the project (S7, compositor-spec §5): setting one, refusing a cycle, the options, and
// the file format — which leaves every pre-S7 file's bytes alone.

import { describe, expect, it } from 'vitest';

import { CommandError, setLayerMask, setMaskSettings, setMaskSourceVisible } from '../../src/project/commands.ts';
import { createDocument, createModuleLayer } from '../../src/project/create.ts';
import type { ProjectDocument } from '../../src/project/document.ts';
import { parseDocument } from '../../src/project/parse.ts';
import { stringifyDocument } from '../../src/project/serialize.ts';

const A = '0000000000A000000000000001';
const B = '0000000000A000000000000002';
const C = '0000000000A000000000000003';

function doc(): ProjectDocument {
  return {
    ...createDocument({ id: '0000000000P000000000000001', timestamp: '2026-09-26T00:00:00.000Z' }),
    layers: [A, B, C].map((id) => createModuleLayer('core.source.background', { id })),
  };
}

describe('mask commands', () => {
  it('sets and removes a mask, and refuses a layer masking itself or a cycle', () => {
    let d = setLayerMask(A, B).apply(doc());
    d = setLayerMask(B, C).apply(d);
    expect(d.layers.map((l) => l.maskLayerId)).toEqual([B, C, null]);
    expect(() => setLayerMask(C, A).apply(d)).toThrow(CommandError);
    expect(() => setLayerMask(A, A).apply(d)).toThrow(/itself/);
    expect(setLayerMask(A, null).apply(d).layers[0]!.maskLayerId).toBeNull();
  });

  it('sets the options, clamping the feather, and the source visibility', () => {
    let d = setMaskSettings(A, { channel: 'luma', invert: true }).apply(doc());
    d = setMaskSettings(A, { feather: 3 }).apply(d);
    expect(d.layers[0]!.mask).toEqual({ channel: 'luma', invert: true, feather: 0.25 });
    expect(setMaskSourceVisible(B, true).apply(d).layers[1]!.maskSourceVisible).toBe(true);
  });
});

describe('masks in the file', () => {
  it('a project without mask options saves exactly as before S7', () => {
    const json = JSON.parse(stringifyDocument(doc()));
    expect(json.layers[0].mask).toBeUndefined();
    expect(json.layers[0].maskSourceVisible).toBeUndefined();
  });

  it('round-trips options and visibility; a feather out of range is clamped with an issue', () => {
    let d = setLayerMask(A, B).apply(doc());
    d = setMaskSettings(A, { channel: 'luma', invert: true, feather: 0.1 }).apply(d);
    d = setMaskSourceVisible(B, true).apply(d);
    const back = parseDocument(JSON.parse(stringifyDocument(d)));
    expect(back.issues).toEqual([]);
    expect(stringifyDocument(back.document)).toBe(stringifyDocument(d));
    const raw = JSON.parse(stringifyDocument(d));
    raw.layers[0].mask.feather = 9;
    const clamped = parseDocument(raw);
    expect(clamped.document.layers[0]!.mask.feather).toBe(0.25);
    expect(clamped.issues).toHaveLength(1);
  });
});
