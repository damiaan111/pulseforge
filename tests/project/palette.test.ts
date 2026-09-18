// The palette (M17, compositor-spec §9).
//
// Two things matter and both are easy to get subtly wrong:
//  - a link resolves to the palette colour **at snapshot time**, so the engine only ever sees a
//    literal and the golden frames stay a statement about the engine;
//  - a role that resolves to nothing falls back to the module default **and says so**, which is
//    what parse.ts already promises when it validates the role table.

import { describe, expect, it } from 'vitest';

import { walkRenderModules, type RenderProject } from '../../src/engine/core/project.ts';

/** Snapshot layers can now be groups (M38); these checks are about module params. */
const moduleLayers = (project: RenderProject) => [...walkRenderModules(project.layers)];

import { addPaletteColor, removePaletteColor, setPaletteRole } from '../../src/project/commands.ts';
import { createDocument, createEffect, createModuleLayer } from '../../src/project/create.ts';
import { linkedRole, resolveRole, roleLink } from '../../src/project/palette.ts';
import { toRenderProject } from '../../src/project/snapshot.ts';
import type { ProjectDocument } from '../../src/project/document.ts';

const LAYER_ID = '0000000000K000000000000001';

function documentWith(options: {
  colors?: readonly string[];
  roles?: Readonly<Record<string, number>>;
  params?: Readonly<Record<string, unknown>>;
  effectParams?: Readonly<Record<string, unknown>>;
}): ProjectDocument {
  const base = createDocument({ timestamp: '2026-09-14T00:00:00.000Z' });
  return {
    ...base,
    palette: { colors: options.colors ?? [], roles: options.roles ?? {}, extra: {} },
    layers: [{
      ...createModuleLayer('core.visualizer.bars', { id: LAYER_ID, params: options.params ?? {} }),
      effects: options.effectParams === undefined
        ? []
        : [createEffect('core.effect.grade', { id: '0000000000K000000000000002', params: options.effectParams })],
    }],
  };
}

describe('role links', () => {
  it('recognises a link only when it names a role this build knows', () => {
    expect(linkedRole('@primary')).toBe('primary');
    expect(linkedRole('@nonsense')).toBeUndefined();
    expect(linkedRole('#ff2d95')).toBeUndefined();
    expect(linkedRole(42)).toBeUndefined();
  });

  it('resolves a role through the colour list', () => {
    const palette = { colors: ['#000000', '#ff2d95'], roles: { primary: 1 }, extra: {} };
    expect(resolveRole(palette, 'primary')).toBe('#ff2d95');
    expect(resolveRole(palette, 'glow')).toBeUndefined();
  });
});

describe('toRenderProject resolves the palette', () => {
  it('substitutes the linked colour, so the engine never sees a link', () => {
    const document = documentWith({
      colors: ['#101010', '#ff2d95'],
      roles: { primary: 1 },
      params: { fill: roleLink('primary'), barCount: 32 },
    });
    const { project, notes } = toRenderProject(document);
    expect(moduleLayers(project)[0]?.params['fill']).toBe('#ff2d95');
    // Everything else is untouched, including values that are not colours at all.
    expect(moduleLayers(project)[0]?.params['barCount']).toBe(32);
    expect(notes).toEqual([]);
  });

  it('resolves links inside an effect too', () => {
    const document = documentWith({
      colors: ['#00e5ff'],
      roles: { secondary: 0 },
      params: {},
      effectParams: { tone: roleLink('secondary') },
    });
    const { project } = toRenderProject(document);
    expect(moduleLayers(project)[0]?.effects?.[0]?.params['tone']).toBe('#00e5ff');
  });

  it('drops an unassigned role so the module default applies, and notes it', () => {
    const document = documentWith({ colors: ['#101010'], roles: {}, params: { fill: roleLink('glow') } });
    const { project, notes } = toRenderProject(document);
    expect(moduleLayers(project)[0]?.params['fill']).toBeUndefined();
    expect(notes).toHaveLength(1);
    expect(notes[0]?.detail).toContain('glow');
  });

  it('leaves a project with no links alone', () => {
    const document = documentWith({ params: { fill: '#ff2d95' } });
    const { project } = toRenderProject(document);
    expect(moduleLayers(project)[0]?.params['fill']).toBe('#ff2d95');
  });
});

describe('palette commands', () => {
  it('repairs the role table when a colour is removed', () => {
    // Roles are indices, so deleting the second of three re-points everything above it unless
    // the command shifts them — the bug this test exists for.
    const document = documentWith({
      colors: ['#000000', '#ff2d95', '#00e5ff'],
      roles: { background: 0, primary: 1, secondary: 2 },
    });
    const after = removePaletteColor(1).apply(document);
    expect(after.palette.colors).toEqual(['#000000', '#00e5ff']);
    expect(after.palette.roles).toEqual({ background: 0, secondary: 1 });
  });

  it('refuses to point a role past the end of the list', () => {
    const document = documentWith({ colors: ['#000000'] });
    expect(() => setPaletteRole('primary', 3).apply(document)).toThrow();
  });

  it('unassigns with null', () => {
    const document = documentWith({ colors: ['#000000'], roles: { primary: 0 } });
    expect(setPaletteRole('primary', null).apply(document).palette.roles).toEqual({});
  });

  it('appends a colour without disturbing the roles', () => {
    const document = documentWith({ colors: ['#000000'], roles: { primary: 0 } });
    const after = addPaletteColor('#ff2d95').apply(document);
    expect(after.palette.colors).toEqual(['#000000', '#ff2d95']);
    expect(after.palette.roles).toEqual({ primary: 0 });
  });
});
