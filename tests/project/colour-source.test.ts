// The picture Auto took its colours from stays with the roll, through a save and a load, and a
// project without one reads as it always did.

import { describe, expect, it } from 'vitest';

import { createDocument } from '../../src/project/create.ts';
import type { DirectorRoll, ProjectDocument } from '../../src/project/document.ts';
import { loadDocument } from '../../src/project/load.ts';
import { stringifyDocument } from '../../src/project/serialize.ts';

const roll = (extra: Partial<DirectorRoll> = {}): DirectorRoll => ({
  seed: 1, templateId: 'tpl.neon.pulse', seeds: { palette: 1, layout: 2, motion: 3 }, locks: [], palette: ['#000000'], summary: 'x', extra: {}, ...extra,
});
const withRoll = (current: DirectorRoll): ProjectDocument => ({
  ...createDocument(), director: { current, history: [], log: [], generated: [], extra: {} },
});

describe('a roll’s colour source', () => {
  it('survives a save and a load', () => {
    const source = { origin: 'cover', path: 'D:/music/song.mp3', name: 'cover of song.mp3' } as const;
    const { document } = loadDocument(stringifyDocument(withRoll(roll({ colourSource: source }))));
    expect(document.director?.current.colourSource).toEqual(source);
    expect(document.director?.current.extra).toEqual({});
  });

  it('writes nothing when there is none', () => {
    const text = stringifyDocument(withRoll(roll()));
    expect(text).not.toContain('colourSource');
    expect(loadDocument(text).document.director?.current.colourSource).toBeUndefined();
  });
});
