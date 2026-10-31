// Extract as template (auto-director-spec §10 step 2): a project in, a template draft out that the
// parser accepts and the director can run.

import { describe, expect, it } from 'vitest';

import { MILKDROP_MEASURES } from '../../src/director/milkdrop-catalogue.ts';
import { direct } from '../../src/director/direct.ts';
import { ExtractError, extractTemplate, templateIdFor, type ExtractInput } from '../../src/director/extract.ts';
import { hexToHsl } from '../../src/director/palette.ts';
import { parseTemplate } from '../../src/director/template.ts';
import { bakeArrangementCurves, setKeyframe } from '../../src/project/automation-commands.ts';
import { createModuleLayer } from '../../src/project/create.ts';
import type { ModuleLayer, ProjectDocument } from '../../src/project/document.ts';
import { stringifyDocument } from '../../src/project/serialize.ts';
import { MODULES, builtinTemplates, directorInput, songDocument } from './fixture.ts';

const extractInput = (document: ProjectDocument): ExtractInput => {
  const { digest, style, analysis, vocalSegments, title } = directorInput(document);
  return { document, modules: MODULES, digest, style, analysis, vocalSegments, title };
};
const NAMING = { id: 'tpl.user.draft', name: 'Draft' };
let ids = 0;
const newId = () => `0000000000K0000000000${String((ids += 1)).padStart(5, '0')}`;

describe('extracting a directed project', () => {
  it.each(builtinTemplates().map((t) => [t.id] as const))('%s comes back as a template that parses clean and directs', (templateId) => {
    const milkdropPresets = MILKDROP_MEASURES.map((row) => row[0]);
    const { document } = direct({ ...directorInput(), milkdropPresets }, { seed: 7, templateId });
    const { raw, issues, template } = extractTemplate(extractInput(document), NAMING);
    expect(issues).toEqual([]);
    // The file a person will edit is plain JSON, and it reads back the same.
    expect(parseTemplate(JSON.parse(JSON.stringify(raw))).template).toEqual(template);
    const again = direct({ ...directorInput(songDocument(), [template]), milkdropPresets }, { seed: 3, templateId: template.id });
    expect(again.document.layers.length).toBeGreaterThanOrEqual(1);
    expect(again.log.filter((e) => e.step === 'populate' && e.text.includes('does not have'))).toEqual([]);
  });

  it('turns layers into slots: same modules, same roles, tokens instead of project values', () => {
    const { document } = direct(directorInput(), { seed: 7, templateId: 'tpl.neon.pulse' });
    const { template } = extractTemplate(extractInput(document), NAMING);
    const modulesOf = (d: ProjectDocument) => d.layers.filter((l): l is ModuleLayer => l.kind === 'module').map((l) => l.module);
    expect(template.slots.filter((s) => s.role !== 'POST').map((s) => s.candidates[0]!.module)).toEqual(modulesOf(document).filter((_, i, all) => i !== all.length - 1));
    const title = template.slots.find((s) => s.role === 'TEXT')!;
    expect(title.candidates[0]!.params['text']).toBe('$title');
    expect(title.condition).toBe('hasTitle');
    expect(title.candidates[0]!.params['color']).toBe('@text');
    expect(template.slots.find((s) => s.role === 'POST')!.effects.length).toBe(document.globalEffects.length);
  });

  it('infers each binding\'s intent from what calibrate would write on this track', () => {
    const { document } = direct(directorInput(), { seed: 7, templateId: 'tpl.neon.pulse' });
    const { template } = extractTemplate(extractInput(document), NAMING);
    const authored = builtinTemplates().find((t) => t.id === 'tpl.neon.pulse')!;
    const byLabel = new Map(authored.modulations.map((m) => [m.label, m]));
    const compared = template.modulations.filter((m) => byLabel.has(m.label));
    expect(compared.length).toBeGreaterThanOrEqual(3);
    for (const m of compared) {
      expect(m.intensity, m.label ?? '').toBe(byLabel.get(m.label)!.intensity);
      expect(m.response, m.label ?? '').toBe(byLabel.get(m.label)!.response);
      expect(m.mode).toBe(byLabel.get(m.label)!.mode);
    }
  });

  it('reads the arrangement back out of the curves and colour keys', () => {
    const plain = directorInput();
    const withDrop = { ...plain, digest: { ...plain.digest, structure: { ...plain.digest.structure, drops: [26] } } };
    const { document } = direct(withDrop, { seed: 7, templateId: 'tpl.neon.pulse' });
    const { template } = extractTemplate(extractInput(document), NAMING);
    const arrangement = template.arrangement;
    expect(arrangement.intensityTargets.length).toBeGreaterThan(0);
    expect(arrangement.floor).toBeCloseTo(0.35, 2);
    expect(arrangement.fadeIn).toBeCloseTo(1, 2);
    expect(arrangement.fadeOut).toBeCloseTo(3, 2);
    expect(arrangement.drop?.targets).toEqual(['POST.bloom.intensity']);
    expect(arrangement.drop?.decaySeconds).toBeCloseTo(0.6, 2);
    expect(arrangement.optionalLayers).toContain('ACCENT');
    expect(arrangement.sections.main?.intensity).toBeGreaterThan(arrangement.sections.intro?.intensity ?? 1);
    expect(arrangement.sections.main?.paletteShift).toBe('accent');
    expect(arrangement.sections.intro?.paletteShift ?? null).toBeNull();
  });

  it('reads a title back as the token when it came from the track, and a baked project\'s fades from its keys', () => {
    const { document } = direct({ ...directorInput(), title: 'from-the-file' }, { seed: 7, templateId: 'tpl.neon.pulse' });
    const input = { ...extractInput(document), title: 'from-the-file' };
    expect(extractTemplate(input, NAMING).template.slots.find((s) => s.role === 'TEXT')!.candidates[0]!.params['text']).toBe('$title');
    const baked = bakeArrangementCurves((id) => MODULES.get(id), { newId }).apply(document);
    const { template, issues, notes } = extractTemplate({ ...input, document: baked }, NAMING);
    expect(issues).toEqual([]);
    expect(template.arrangement.fadeIn).toBeCloseTo(1, 2);
    expect(template.arrangement.fadeOut).toBeCloseTo(3, 2);
    expect(notes.filter((n) => n.includes('nowhere to go'))).toEqual([]);
  });

  it('puts the palette back as a rule that lands on the same colours', () => {
    const { document } = direct(directorInput(), { seed: 7, templateId: 'tpl.neon.pulse' });
    const input = directorInput(songDocument());
    const { template } = extractTemplate(extractInput(document), NAMING);
    expect(template.palette.strategy).toBe('generate-from-style');
    expect(template.palette.harmony).toBe('complementary');
    const again = direct({ ...input, templates: [{ ...template, variation: { ...template.variation, hueJitter: 0 } }] }, { seed: 3, templateId: template.id }).document;
    const hue = (d: ProjectDocument) => hexToHsl(d.palette.colors[0]!).h;
    expect(Math.abs(hue(again) - hue(document))).toBeLessThan(3);
  });
});

describe('extracting a hand-built project', () => {
  const handBuilt = (layers: ProjectDocument['layers']): ProjectDocument => songDocument({ layers });

  it('assigns roles from the modules, and keeps colours no rule describes as fixed', () => {
    const document: ProjectDocument = {
      ...handBuilt([
        createModuleLayer('core.source.background', { id: '0000000000L000000000000001', name: 'Ground' }),
        createModuleLayer('core.visualizer.bars', { id: '0000000000L000000000000002', name: 'Bars' }),
        createModuleLayer('core.visualizer.waves', { id: '0000000000L000000000000003', name: 'Waves' }),
      ]),
    };
    const fixedColours = { ...document, palette: { colors: ['#ff0000', '#ff2200', '#0000ff', '#101010', '#ffffff'], roles: { primary: 0, secondary: 1, accent: 2, background: 3, text: 4 }, extra: {} } };
    const { template, issues, notes } = extractTemplate(extractInput(fixedColours), NAMING);
    expect(issues).toEqual([]);
    expect(template.slots.map((s) => s.role)).toEqual(['BACKDROP', 'HERO', 'ACCENT']);
    expect(notes).toEqual([]);
    expect(template.palette.strategy).toBe('fixed');
    expect(template.palette.colors['accent']).toBe('#0000ff');
  });

  it('makes a hero of what there is, and refuses an empty project', () => {
    const lone = handBuilt([createModuleLayer('core.source.background', { id: '0000000000L000000000000001', name: 'Only' })]);
    const { template, notes, issues } = extractTemplate(extractInput(lone), NAMING);
    expect(issues).toEqual([]);
    expect(template.slots[0]!.role).toBe('HERO');
    expect(notes.join(' ')).toContain('became the HERO');
    expect(() => extractTemplate(extractInput(handBuilt([])), NAMING)).toThrow(ExtractError);
  });

  it('says what stayed behind instead of dropping it', () => {
    const layer = { ...createModuleLayer('core.visualizer.bars', { id: '0000000000L000000000000002', name: 'Bars' }), enabled: true };
    const off = { ...createModuleLayer('core.visualizer.waves', { id: '0000000000L000000000000003', name: 'Off' }), enabled: false };
    const stretched = { ...layer, transform: { ...layer.transform, scaleX: 1, scaleY: 2 } };
    const { notes } = extractTemplate(extractInput(handBuilt([stretched, off])), NAMING);
    expect(notes.some((n) => n.includes('"Off" is switched off'))).toBe(true);
    expect(notes.some((n) => n.includes('one scale'))).toBe(true);
  });

  it('turns numeric keyframes into section intensities over a raised base', () => {
    const layer = createModuleLayer('core.visualizer.bars', { id: '0000000000L000000000000002', name: 'Bars' });
    let document = handBuilt([layer]);
    const target = `layers.${layer.id}.opacity`;
    document = setKeyframe(target, 0, 0.2, { newId }).apply(document);
    document = setKeyframe(target, 48_000 * 90, 1, { newId }).apply(document);
    const { template, issues } = extractTemplate(extractInput(document), NAMING);
    expect(issues).toEqual([]);
    expect(template.arrangement.intensityTargets).toContain('HERO.opacity');
    expect(template.arrangement.floor).toBe(0);
    const levels = Object.values(template.arrangement.sections).map((s) => s?.intensity ?? 0);
    expect(Math.max(...levels)).toBeGreaterThan(Math.min(...levels));
  });

  it('is pure: the same project gives the same draft, and the document is not touched', () => {
    const { document } = direct(directorInput(), { seed: 7, templateId: 'tpl.cinematic.particles' });
    const before = stringifyDocument(document);
    expect(JSON.stringify(extractTemplate(extractInput(document), NAMING).raw)).toBe(JSON.stringify(extractTemplate(extractInput(document), NAMING).raw));
    expect(stringifyDocument(document)).toBe(before);
  });
});

describe('templateIdFor', () => {
  it('makes a safe id', () => {
    expect(templateIdFor('Night Drive / Mix 2!')).toBe('tpl.user.night-drive-mix-2');
    expect(templateIdFor('***')).toBe('tpl.user.untitled');
  });
});
