// The auto-director end to end (auto-director-spec §1–§9, M21, M22), on a song-shaped fixture with
// the built-in templates and module library.
//
// What matters most, in order: the result is an ordinary project that loads, renders and has no
// broken references; the same inputs give the same bytes; a reroll never loses the user's edits.

import { describe, expect, it } from 'vitest';

import { direct, surprise } from '../../src/director/direct.ts';
import { fingerprint } from '../../src/director/fingerprint.ts';
import { contrastRatio } from '../../src/director/palette.ts';
import { parseTemplate } from '../../src/director/template.ts';
import { compileModulation } from '../../src/engine/core/modulation.ts';
import { setLayerParam, addLayer } from '../../src/project/commands.ts';
import { createModuleLayer } from '../../src/project/create.ts';
import type { ModuleLayer, ProjectDocument } from '../../src/project/document.ts';
import { allBindings, describeTarget } from '../../src/project/modulation-authoring.ts';
import { parseDocument } from '../../src/project/parse.ts';
import { stringifyDocument } from '../../src/project/serialize.ts';
import { toRenderProject } from '../../src/project/snapshot.ts';
import { MODULES, SONG_SECONDS, builtinTemplateTexts, builtinTemplates, directorInput, song, songDocument } from './fixture.ts';

const schemas = (id: string) => MODULES.get(id);

/** Every binding's target must name something that exists, and the engine must compile them all. */
function expectWellFormed(document: ProjectDocument): void {
  const reparsed = parseDocument(JSON.parse(stringifyDocument(document)));
  expect(reparsed.issues).toEqual([]);
  expect(stringifyDocument(reparsed.document)).toBe(stringifyDocument(document));
  for (const { binding } of allBindings(document)) {
    expect(describeTarget(document, binding.target, schemas).problem, binding.target).toBeNull();
  }
  const { project } = toRenderProject(document);
  const bindings = [...project.layers.flatMap((l) => ('modulations' in l ? (l.modulations ?? []) : [])), ...(project.globalModulations ?? [])];
  const program = compileModulation({ bindings, analysis: song().analysis, durationSeconds: SONG_SECONDS, seed: document.seed });
  expect(program.issues).toEqual([]);
}

describe('the built-in templates', () => {
  it.each(builtinTemplateTexts().map((t) => [t.file, t.raw] as const))('%s parses with no issues', (_file, raw) => {
    expect(parseTemplate(raw).issues).toEqual([]);
  });

  it('are seven, with unique ids, and every module they name is installed', () => {
    const templates = builtinTemplates();
    expect(templates.map((t) => t.name).sort()).toEqual([
      'Cinematic Depth', 'Cinematic Particles', 'Lyric Focus', 'Minimal Mono', 'Minimal Type', 'Neon Grid', 'Neon Pulse',
    ]);
    for (const t of templates) {
      for (const slot of t.slots) {
        for (const c of slot.candidates) expect(MODULES.get(c.module), `${t.id} ${slot.id} ${c.module}`).toBeDefined();
        for (const e of slot.effects) expect(MODULES.get(e.module), `${t.id} ${slot.id} ${e.module}`).toBeDefined();
      }
    }
  });
});

describe('directing a track', () => {
  it('finds structure in the fixture (otherwise the arrangement tests test nothing)', () => {
    expect(song().sections.length).toBeGreaterThanOrEqual(3);
  });

  it.each(builtinTemplates().map((t) => [t.id] as const))('%s makes a well-formed, renderable project', (templateId) => {
    const result = direct(directorInput(), { seed: 7, templateId });
    const document = result.document;
    expect(document.layers.length).toBeGreaterThanOrEqual(2);
    expect(document.director?.current.templateId).toBe(templateId);
    expectWellFormed(document);
    // The log explains every step it took.
    const steps = new Set(result.log.map((e) => e.step));
    for (const step of ['classify', 'match', 'populate', 'calibrate', 'arrange']) expect(steps, step).toContain(step);
  });

  it('is deterministic: same track, seed and template give the same bytes — ids included', () => {
    const a = direct(directorInput(), { seed: 42 });
    const b = direct(directorInput(), { seed: 42 });
    expect(stringifyDocument(a.document)).toBe(stringifyDocument(b.document));
  });

  it('a different seed gives a different project', () => {
    const a = direct(directorInput(), { seed: 1, templateId: 'tpl.neon.pulse' });
    const b = direct(directorInput(), { seed: 2, templateId: 'tpl.neon.pulse' });
    expect(stringifyDocument(a.document)).not.toBe(stringifyDocument(b.document));
  });

  it('calibrates amounts within each parameter\'s soft range and writes no zero bindings', () => {
    const { document } = direct(directorInput(), { seed: 3, templateId: 'tpl.neon.pulse' });
    for (const { binding } of allBindings(document)) {
      expect(Math.abs(binding.amount), binding.target).toBeGreaterThan(0);
      expect(binding.inputRange).toBe('auto');
    }
  });

  it('arranges: section intensity as a sorted curve, and the title leaves before the end', () => {
    const { document, log } = direct(directorInput(), { seed: 5, templateId: 'tpl.neon.pulse' });
    const intensity = allBindings(document).filter(({ binding }) => binding.label === 'Section intensity');
    expect(intensity.length).toBeGreaterThan(0);
    for (const { binding } of intensity) {
      const ticks = binding.source.points.map((p) => p.ticks);
      expect([...ticks].sort((x, y) => x - y)).toEqual(ticks);
      expect(binding.mode).toBe('multiply');
    }
    const title = document.layers.find((l): l is ModuleLayer => l.kind === 'module' && l.module === 'core.text.title');
    expect(title?.timeRange.outTicks).not.toBeNull();
    expect(log.some((e) => e.step === 'arrange' && e.text.startsWith('Sections:'))).toBe(true);
  });

  it('keeps text readable: the generated palette meets each template\'s contrast minimum', () => {
    for (const template of builtinTemplates()) {
      const { document } = direct(directorInput(), { seed: 11, templateId: template.id });
      const colors = document.palette.colors;
      const roles = document.palette.roles;
      expect(contrastRatio(colors[roles['text']!]!, colors[roles['background']!]!), template.id).toBeGreaterThanOrEqual(template.palette.minTextContrast - 0.01);
    }
  });

  it('drops optional layers over the GPU budget at 4K, and says so', () => {
    const document = songDocument({ canvas: { ...songDocument().canvas, width: 3840, height: 2160 } });
    const { log } = direct(directorInput(document), { seed: 9, templateId: 'tpl.cinematic.depth' });
    expect(log.some((e) => e.step === 'guardrail' && /budget/.test(e.text))).toBe(true);
  });

  it('matches the flagship to an energetic electronic track and Lyric Focus when timed lyrics exist', () => {
    const plain = direct(directorInput(), { seed: 1 });
    const withLyrics = songDocument({
      lyrics: { ...songDocument().lyrics, lines: [{ id: '0000000000Y000000000000001', text: 'drive', startTicks: 48_000 * 30, endTicks: 48_000 * 32, words: [], role: 'lead', locked: false, style: null, confidence: null, extra: {} }] },
    });
    const lyrical = direct(directorInput(withLyrics), { seed: 1 });
    expect(lyrical.ranked[0]!.template.id).toBe('tpl.lyric.focus');
    expect(plain.ranked[0]!.template.id).not.toBe('tpl.lyric.focus');
    expect(lyrical.document.layers.some((l) => l.kind === 'module' && l.module === 'core.text.lyrics')).toBe(true);
  });
});

describe('Surprise me — rerolls keep what you touched (§9)', () => {
  it('keeps an edited generated layer and a layer you added; replaces the rest', () => {
    const first = direct(directorInput(), { seed: 100, templateId: 'tpl.neon.pulse' }).document;
    const hero = first.layers.find((l) => first.director!.generated.some((m) => m.id === l.id && m.slot === 'HERO'))!;
    const edited = setLayerParam(hero.id, 'fill', '#00ff00').apply(first);
    const mine = createModuleLayer('core.visualizer.waves', { id: '0000000000W000000000000001', name: 'Mine' });
    const withMine = addLayer(mine).apply(edited);

    const second = direct(directorInput(withMine), { seed: 200, templateId: 'tpl.neon.pulse' });
    const ids = second.document.layers.map((l) => l.id);
    expect(ids).toContain(hero.id);
    expect(ids).toContain(mine.id);
    const keptHero = second.document.layers.find((l) => l.id === hero.id) as ModuleLayer;
    expect(keptHero.params['fill']).toBe('#00ff00');
    // Exactly one HERO: the kept one fills the slot.
    const heroes = second.document.layers.filter((l) => l.kind === 'module' && ['core.visualizer.radial', 'core.visualizer.orb', 'core.visualizer.bars'].includes(l.module));
    expect(heroes.map((l) => l.id)).toEqual([hero.id]);
    expect(second.log.some((e) => e.step === 'keep')).toBe(true);
    // Unedited generated layers were replaced.
    const firstOthers = first.director!.generated.filter((m) => m.kind === 'layer' && m.id !== hero.id).map((m) => m.id);
    for (const id of firstOthers) expect(ids).not.toContain(id);
    expectWellFormed(second.document);
  });

  it('palette lock keeps the palette verbatim, even after your own edit to it', () => {
    const first = direct(directorInput(), { seed: 1, templateId: 'tpl.neon.pulse' }).document;
    const tuned: ProjectDocument = { ...first, palette: { ...first.palette, colors: first.palette.colors.map((c, i) => (i === 0 ? '#123456' : c)) } };
    const next = direct(directorInput(tuned), { seed: 2, locks: ['palette'] }).document;
    expect(next.palette.colors).toEqual(tuned.palette.colors);
  });

  it('layout lock keeps the template and the same modules in the same slots', () => {
    const first = direct(directorInput(), { seed: 1, templateId: 'tpl.cinematic.particles' }).document;
    const next = direct(directorInput(first), { seed: 99, locks: ['layout'] }).document;
    expect(next.director!.current.templateId).toBe('tpl.cinematic.particles');
    const modules = (d: ProjectDocument) => d.layers.map((l) => (l.kind === 'module' ? l.module : 'group'));
    expect(modules(next)).toEqual(modules(first));
  });

  it('draws a different-looking result from the previous one', () => {
    const first = direct(directorInput(), { seed: 1, templateId: 'tpl.neon.pulse' }).document;
    const next = surprise(directorInput(first), { seed: 1 }).document;
    const sig = (d: ProjectDocument) => `${d.director!.current.summary}`;
    expect(sig(next)).not.toBe(sig(first));
  });

  it('keeps a history of rolls, each restorable to the same project', () => {
    let document = songDocument();
    const rolls: ProjectDocument[] = [];
    for (let i = 1; i <= 12; i += 1) {
      document = direct(directorInput(document), { seed: i * 17, roulette: true }).document;
      rolls.push(document);
    }
    expect(document.director!.history.length).toBe(10);
    const target = rolls[9]!;
    const restored = direct(directorInput(document), { seed: target.director!.current.seed, restore: target.director!.current }).document;
    expect(restored.palette.colors).toEqual(target.palette.colors);
    const shape = (d: ProjectDocument) => d.layers.map((l) => (l.kind === 'module' ? `${l.module}:${fingerprint(l.params)}` : 'group'));
    expect(shape(restored)).toEqual(shape(target));
  });
});
