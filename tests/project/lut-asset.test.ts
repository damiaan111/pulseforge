// A LUT as a project asset (S11): kept through a save and a load, handed to the render project under
// its hash, so the engine's `ctx.lut` finds the table the host registered.

import { describe, expect, it } from 'vitest';

import { createDocument, createModuleLayer } from '../../src/project/create.ts';
import type { AssetRef, ProjectDocument } from '../../src/project/document.ts';
import { parseDocument } from '../../src/project/parse.ts';
import { stringifyDocument } from '../../src/project/serialize.ts';
import { toRenderProject } from '../../src/project/snapshot.ts';

const LUT: AssetRef = { id: '0000000000T000000000000001', kind: 'lut', path: 'luts/Film.cube', hash: 'abc123', size: 1000, name: 'Film.cube', extra: {} };

function doc(): ProjectDocument {
  const layer = createModuleLayer('core.source.background', { id: '0000000000A000000000000001' });
  return {
    ...createDocument({ id: '0000000000P000000000000001', timestamp: '2026-09-27T00:00:00.000Z' }),
    assets: [LUT],
    layers: [{ ...layer, effects: [{ id: '0000000000E000000000000001', module: 'core.effect.lut', enabled: true, params: { lut: LUT.id, amount: 0.8, space: 'display' }, paramsSchemaVersion: 1, modulations: [], extra: {} }] } as never],
  };
}

describe('LUT assets', () => {
  it('round-trip through the file', () => {
    const back = parseDocument(JSON.parse(stringifyDocument(doc())));
    expect(back.issues).toEqual([]);
    expect(back.document.assets[0]).toMatchObject({ kind: 'lut', name: 'Film.cube', hash: 'abc123' });
  });

  it('reach the render project by id, under their hash', () => {
    const { project } = toRenderProject(doc());
    expect(project.assets?.[LUT.id]).toEqual({ kind: 'lut', hash: 'abc123', name: 'Film.cube' });
  });
});
