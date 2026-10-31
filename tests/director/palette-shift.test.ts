// Palette shifts (auto-director-spec §6): colour keyframes that interpolate between role
// assignments, and the reroll rules that keep them from orphaning keys or losing the user's.

import { describe, expect, it } from 'vitest';

import { direct } from '../../src/director/direct.ts';
import { contrastRatio } from '../../src/director/palette.ts';
import { roleKeys, shiftedRole, worstContrast, type ShiftSection } from '../../src/director/palette-shift.ts';
import { parseTemplate, type Template } from '../../src/director/template.ts';
import { sampleTrack } from '../../src/engine/core/automation.ts';
import { applyDirection } from '../../src/project/commands.ts';
import { History } from '../../src/project/history.ts';
import { setKeyframe } from '../../src/project/automation-commands.ts';
import type { ModuleLayer, Palette, ProjectDocument } from '../../src/project/document.ts';
import { describeTarget } from '../../src/project/modulation-authoring.ts';
import { parseDocument } from '../../src/project/parse.ts';
import { stringifyDocument } from '../../src/project/serialize.ts';
import { toRenderProject } from '../../src/project/snapshot.ts';
import { MODULES, builtinTemplateTexts, builtinTemplates, directorInput, songDocument } from './fixture.ts';

const NEON = 'tpl.neon.pulse';
let ids = 0;
const newId = () => `0000000000K0000000000${String((ids += 1)).padStart(5, '0')}`;
const heroOf = (document: ProjectDocument) => document.layers.find((l): l is ModuleLayer => l.kind === 'module' && document.director!.generated.some((m) => m.id === l.id && m.slot === 'HERO'))!;

describe('role keys', () => {
  const sections: ShiftSection[] = [
    { startSeconds: 0, paletteShift: null },
    { startSeconds: 30, paletteShift: 'accent' },
    { startSeconds: 60, paletteShift: 'accent' },
    { startSeconds: 90, paletteShift: null },
  ];

  it('trades the two roles and leaves the others alone', () => {
    expect(shiftedRole('primary', 'accent')).toBe('accent');
    expect(shiftedRole('accent', 'accent')).toBe('primary');
    expect(shiftedRole('text', 'accent')).toBe('text');
    expect(shiftedRole('primary', null)).toBe('primary');
  });

  it('holds across a boundary that does not change, and crosses over a ramp at one that does', () => {
    const keys = roleKeys('primary', sections);
    expect(keys.map((k) => k.role)).toEqual(['primary', 'primary', 'accent', 'accent', 'primary']);
    expect(keys[2]!.ticks - keys[1]!.ticks).toBe(0.75 * 48_000);
    expect(keys[1]!.ticks + 0.375 * 48_000).toBe(30 * 48_000);
  });

  it('writes nothing for a role that never moves', () => {
    expect(roleKeys('textShadow', sections)).toEqual([]);
    expect(roleKeys('primary', [{ startSeconds: 0, paletteShift: null }])).toEqual([]);
  });
});

describe('worstContrast', () => {
  const palette: Palette = { colors: ['#ff0000', '#00ff00', '#000000'], roles: { primary: 0, accent: 1, background: 2 }, extra: {} };

  it('measures the crossing, not only its ends', () => {
    // Two colours on a mid-grey ground, equally far above and below it: the middle sits on the ground.
    const crossing: Palette = { colors: ['#ffffff', '#000000'], roles: { primary: 0, accent: 1 }, extra: {} };
    const keys = [{ ticks: 0, role: 'primary' as const }, { ticks: 1000, role: 'accent' as const }];
    const ends = Math.min(contrastRatio('#ffffff', '#767676'), contrastRatio('#000000', '#767676'));
    expect(ends).toBeGreaterThan(4);
    expect(worstContrast(crossing, keys, '#767676')!).toBeLessThan(1.5);
  });

  it('is null when a role has no colour', () => {
    expect(worstContrast(palette, [{ ticks: 0, role: 'glow' }], '#000000')).toBeNull();
  });
});

describe('in a directed project', () => {
  it('writes role-linked colour keys that resolve, interpolate and survive a save', () => {
    const { document, log } = direct(directorInput(), { seed: 5, templateId: NEON });
    expect(document.automation.length).toBeGreaterThan(0);
    for (const track of document.automation) {
      expect(describeTarget(document, track.target, (id) => MODULES.get(id)).problem, track.target).toBeNull();
      expect(track.keyframes.every((k) => typeof k.value === 'string' && k.value.startsWith('@'))).toBe(true);
    }
    expect(document.director!.generated.filter((m) => m.kind === 'track').map((m) => m.id).sort()).toEqual(document.automation.map((t) => t.id).sort());
    expect(log.some((e) => e.step === 'arrange' && e.text.includes('trade places'))).toBe(true);

    const reparsed = parseDocument(JSON.parse(stringifyDocument(document)));
    expect(reparsed.issues).toEqual([]);
    expect(stringifyDocument(reparsed.document)).toBe(stringifyDocument(document));

    const { project } = toRenderProject(document);
    const hero = heroOf(document);
    const track = project.automation!.find((t) => t.target === `layers.${hero.id}.params.fill`)!;
    expect(track.keyframes.every((k) => /^#[0-9a-f]{6}$/.test(String(k.value)))).toBe(true);
    const [, rampStart, rampEnd] = track.keyframes;
    const primary = document.palette.colors[document.palette.roles['primary']!];
    const accent = document.palette.colors[document.palette.roles['accent']!];
    expect(rampStart!.value).toBe(primary);
    expect(rampEnd!.value).toBe(accent);
    const middle = sampleTrack(track.keyframes, (rampStart!.ticks + rampEnd!.ticks) / 2 / 48_000, 'color');
    expect(middle).not.toBe(primary);
    expect(middle).not.toBe(accent);
  });

  it('is deterministic and needs no change for a template without shifts', () => {
    const a = direct(directorInput(), { seed: 5, templateId: NEON });
    const b = direct(directorInput(), { seed: 5, templateId: NEON });
    expect(stringifyDocument(a.document)).toBe(stringifyDocument(b.document));
    const plain = direct(directorInput(), { seed: 5, templateId: 'tpl.minimal.mono' });
    expect(plain.document.automation).toEqual([]);
    expect(plain.document.director!.generated.some((m) => m.kind === 'track')).toBe(false);
  });

  it('keeps text readable through a crossing, or leaves it out and says so', () => {
    const raw = structuredClone(builtinTemplateTexts().find((t) => t.file === 'neon-pulse.json')!.raw) as { palette: Record<string, unknown>; slots: { id: string; params?: Record<string, unknown>; candidates?: { params: Record<string, unknown> }[] }[] };
    // Title text on the accent, which on a near-black ground trades with a primary pushed dim.
    raw.palette = { ...raw.palette, strategy: 'fixed', colors: { background: '#101010', text: '#ffffff', accent: '#ffffff', primary: '#555555' } };
    raw.slots.find((s) => s.id === 'TEXT')!.candidates![0]!.params['color'] = '@accent';
    const template: Template = parseTemplate(raw).template;
    const { document, log } = direct(directorInput(songDocument(), [template]), { seed: 5, templateId: NEON });
    const title = document.layers.find((l): l is ModuleLayer => l.kind === 'module' && l.module === 'core.text.title')!;
    expect(document.automation.some((t) => t.target === `layers.${title.id}.params.color`)).toBe(false);
    expect(log.some((e) => e.step === 'guardrail' && e.text.includes('out of the palette shift'))).toBe(true);
  });

  it('every text parameter that does shift stays above the minimum at every sample', () => {
    const template = builtinTemplates().find((t) => t.id === NEON)!;
    const withLyrics = songDocument({
      lyrics: { ...songDocument().lyrics, lines: [{ id: '0000000000Y000000000000001', text: 'drive', startTicks: 48_000 * 30, endTicks: 48_000 * 32, words: [], role: 'lead', locked: false, style: null, confidence: null, extra: {} }] },
    });
    let checked = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const { document } = direct(directorInput(withLyrics), { seed, templateId: NEON });
      const background = document.palette.colors[document.palette.roles['background']!]!;
      const { project } = toRenderProject(document);
      const textIds = document.layers.filter((l) => l.kind === 'module' && l.module.startsWith('core.text.')).map((l) => l.id);
      for (const track of project.automation ?? []) {
        if (!textIds.some((id) => track.target.startsWith(`layers.${id}.`))) continue;
        checked += 1;
        for (let t = 0; t < 96; t += 0.05) {
          expect(contrastRatio(sampleTrack(track.keyframes, t, 'color') as string, background), `${track.target} at ${t}`).toBeGreaterThanOrEqual(Math.min(template.palette.minTextContrast, contrastRatio(String(track.keyframes[0]!.value), background)) - 0.02);
        }
      }
    }
    // The lyric layer's active and sung colours link to the two roles that trade.
    expect(checked).toBeGreaterThan(0);
  });
});

describe('rerolls and keyframes', () => {
  it('applyDirection carries the keys, and undo takes them back', () => {
    const start = songDocument();
    const result = direct(directorInput(start), { seed: 5, templateId: NEON }).document;
    const history = new History(start);
    history.run(applyDirection(result));
    expect(history.current.automation).toEqual(result.automation);
    history.undo();
    expect(history.current.automation).toEqual([]);
  });

  it('a reroll replaces its own tracks and leaves none pointing at a layer that is gone', () => {
    const first = direct(directorInput(), { seed: 5, templateId: NEON }).document;
    const second = direct(directorInput(first), { seed: 6, templateId: NEON }).document;
    expect(second.automation.length).toBeGreaterThan(0);
    for (const track of second.automation) {
      expect(describeTarget(second, track.target, (id) => MODULES.get(id)).problem, track.target).toBeNull();
    }
    expect(second.automation.map((t) => t.id)).not.toContain(first.automation[0]!.id);
    expect(second.director!.generated.filter((m) => m.kind === 'track')).toHaveLength(second.automation.length);
  });

  it('keys you set on a generated layer keep that layer, and its own tracks, through a reroll', () => {
    const first = direct(directorInput(), { seed: 5, templateId: NEON }).document;
    const hero = heroOf(first);
    const mine = setKeyframe(`layers.${hero.id}.opacity`, 48_000, 0.5, { newId }).apply(first);
    const myTrack = mine.automation.at(-1)!;

    const second = direct(directorInput(mine), { seed: 6, templateId: NEON });
    expect(second.document.layers.map((l) => l.id)).toContain(hero.id);
    expect(second.document.automation).toContainEqual(myTrack);
    expect(second.document.automation.some((t) => t.target === `layers.${hero.id}.params.fill`)).toBe(true);
    expect(second.log.some((e) => e.step === 'keep' && e.text.includes(hero.name))).toBe(true);
    for (const track of second.document.automation) expect(describeTarget(second.document, track.target, (id) => MODULES.get(id)).problem, track.target).toBeNull();
  });

  it('an edited generated track is yours: it stays, and so does its layer', () => {
    const first = direct(directorInput(), { seed: 5, templateId: NEON }).document;
    const track = first.automation[0]!;
    const edited = setKeyframe(track.target, 4_800, '#112233', { newId }).apply(first);
    const second = direct(directorInput(edited), { seed: 6, templateId: NEON }).document;
    const after = second.automation.find((t) => t.id === track.id);
    expect(after?.keyframes.some((k) => k.value === '#112233')).toBe(true);
    expect(describeTarget(second, track.target, (id) => MODULES.get(id)).problem).toBeNull();
  });

  it('reports your keys on something already gone, and keeps them', () => {
    const first = direct(directorInput(), { seed: 5, templateId: NEON }).document;
    const stray = setKeyframe('layers.0000000000X000000000000001.opacity', 0, 1, { newId }).apply(first);
    const second = direct(directorInput(stray), { seed: 6, templateId: NEON });
    expect(second.document.automation.some((t) => t.target.startsWith('layers.0000000000X'))).toBe(true);
    expect(second.log.some((e) => e.step === 'keep' && e.text.includes('no longer in the project'))).toBe(true);
  });

  it('a kept Fade layer is not doubled by a new one', () => {
    const first = direct(directorInput(), { seed: 5, templateId: NEON }).document;
    const fade = first.director!.generated.find((m) => m.slot === 'FADE')!;
    const keyed = setKeyframe(`layers.${fade.id}.opacity`, 0, 1, { newId }).apply(first);
    const second = direct(directorInput(keyed), { seed: 6, templateId: NEON }).document;
    expect(second.layers.filter((l) => l.name === 'Fade').map((l) => l.id)).toEqual([fade.id]);
    expect(second.layers.at(-1)!.id).toBe(fade.id);
  });

  it('a kept layer survives a template with no slot for it, keys and all', () => {
    const first = direct(directorInput(), { seed: 5, templateId: 'tpl.neon.pulse' }).document;
    const accentMark = first.director!.generated.find((m) => m.kind === 'layer' && m.slot === 'ACCENT');
    const hero = heroOf(first);
    const template = builtinTemplates().find((t) => t.id === 'tpl.minimal.mono')!;
    const mark = accentMark ?? first.director!.generated.find((m) => m.id === hero.id)!;
    const edited = setKeyframe(`layers.${mark.id}.opacity`, 0, 0.5, { newId }).apply(first);
    // A slot id no other template has.
    const renamed: ProjectDocument = { ...edited, director: { ...edited.director!, generated: edited.director!.generated.map((m) => (m.id === mark.id ? { ...m, slot: 'ELSEWHERE' } : m)) } };
    const second = direct(directorInput(renamed, [template]), { seed: 6, templateId: template.id });
    expect(second.document.layers.map((l) => l.id)).toContain(mark.id);
    expect(second.log.some((e) => e.step === 'keep' && e.text.includes('stays as your own layer'))).toBe(true);
  });
});
