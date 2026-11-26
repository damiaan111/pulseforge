// Arrangement curves → keyframes: one bulk undoable command. The keys reproduce the curves exactly
// where nothing else rides on the target; where something does, the behaviour change is real and
// is the thing the panel warns about, so this file pins it down rather than hiding it.

import { describe, expect, it } from 'vitest';

import { direct } from '../../src/director/direct.ts';
import { sampleTrack } from '../../src/engine/core/automation.ts';
import { compileModulation, modulateValue } from '../../src/engine/core/modulation.ts';
import { bakeArrangementCurves, planCurveBake, setKeyframe } from '../../src/project/automation-commands.ts';
import { History } from '../../src/project/history.ts';
import { allBindings, describeTarget, targetBase } from '../../src/project/modulation-authoring.ts';
import type { ModulationBinding, ProjectDocument } from '../../src/project/document.ts';
import { parseDocument } from '../../src/project/parse.ts';
import { stringifyDocument } from '../../src/project/serialize.ts';
import { toRenderProject } from '../../src/project/snapshot.ts';
import { MODULES, SONG_SECONDS, directorInput, song } from '../director/fixture.ts';

const schemas = (id: string) => MODULES.get(id);
let ids = 0;
const newId = () => `0000000000K0000000000${String((ids += 1)).padStart(5, '0')}`;
const NEON = 'tpl.neon.pulse';

function withDrop(seed = 5): ProjectDocument {
  const plain = directorInput();
  return direct({ ...plain, digest: { ...plain.digest, structure: { ...plain.digest.structure, drops: [26] } } }, { seed, templateId: NEON }).document;
}

/** The value of `target` under `bindings`, at t: the engine's own chain. */
function chain(bindings: readonly ModulationBinding[], target: string, base: number) {
  const { project } = toRenderProject({ ...withDrop(), layers: [], globalEffects: [], globalModulations: bindings, automation: [] });
  const program = compileModulation({ bindings: project.globalModulations ?? [], analysis: song().analysis, durationSeconds: SONG_SECONDS, seed: 1 });
  return (t: number) => modulateValue(program, target, base, t);
}

describe('baking the arrangement curves', () => {
  it('merges intensity and drop into one track per target', () => {
    const document = withDrop();
    const before = allBindings(document).filter(({ binding }) => binding.target.includes('.effects.') && (binding.label === 'Section intensity' || binding.label === 'Drop'));
    const target = before.find(({ binding }) => binding.label === 'Drop')!.binding.target;
    expect(before.filter(({ binding }) => binding.target === target).length).toBe(2);
    const plan = planCurveBake(document, schemas);
    expect(plan.bakes.filter((b) => b.target === target)).toHaveLength(1);
    expect(plan.bakes.find((b) => b.target === target)!.bindingIds).toHaveLength(2);
  });

  it('reproduces the curves exactly: same values at every moment, through the engine', () => {
    const document = withDrop();
    const plan = planCurveBake(document, schemas);
    expect(plan.bakes.length).toBeGreaterThan(2);
    for (const bake of plan.bakes) {
      const spec = describeTarget(document, bake.target, schemas).spec!;
      const bindings = allBindings(document).filter(({ binding }) => bake.bindingIds.includes(binding.id)).map(({ binding }) => binding);
      const curved = chain(bindings, bake.target, targetBase(document, bake.target, spec));
      const keys = bake.keys.map((k) => ({ ...k, easing: 'linear' as const }));
      for (let t = 0; t < SONG_SECONDS; t += 0.37) {
        expect(sampleTrack(keys, t, 'number') as number, `${bake.label} at ${t}`).toBeCloseTo(curved(t), 2);
      }
    }
  });

  it('replaces the bindings with tracks, as one undo step, and the result saves clean', () => {
    const document = withDrop();
    const history = new History(document);
    history.run(bakeArrangementCurves(schemas, { newId }));
    const baked = history.current;
    expect(allBindings(baked).filter(({ binding }) => binding.source.type === 'curve')).toEqual([]);
    expect(baked.automation.length).toBe(document.automation.length + planCurveBake(document, schemas).bakes.length);
    const reparsed = parseDocument(JSON.parse(stringifyDocument(baked)));
    expect(reparsed.issues).toEqual([]);
    expect(planCurveBake(baked, schemas).bakes).toEqual([]);
    history.undo();
    expect(stringifyDocument(history.current)).toBe(stringifyDocument(document));
  });

  it('is the warned-of difference: audio bindings on the target stop following the section', () => {
    const document = withDrop();
    const bake = planCurveBake(document, schemas).bakes.find((b) => allBindings(document).some(({ binding }) => binding.target === b.target && binding.source.type !== 'curve'))!;
    const spec = describeTarget(document, bake.target, schemas).spec!;
    const all = allBindings(document).filter(({ binding }) => binding.target === bake.target).map(({ binding }) => binding);
    const others = all.filter((b) => !bake.bindingIds.includes(b.id));
    const base = targetBase(document, bake.target, spec);
    const before = chain(all, bake.target, base);
    const after = (t: number) => chain(others, bake.target, sampleTrack(bake.keys.map((k) => ({ ...k, easing: 'linear' as const })), t, 'number') as number)(t);
    let differs = 0;
    for (let t = 1; t < SONG_SECONDS; t += 1) if (Math.abs(before(t) - after(t)) > 1e-3) differs += 1;
    expect(differs).toBeGreaterThan(0);
  });

  it('leaves alone a target that already has keys, and says why', () => {
    const document = withDrop();
    const bake = planCurveBake(document, schemas).bakes[0]!;
    const keyed = setKeyframe(bake.target, 0, 0.5, { newId }).apply(document);
    const plan = planCurveBake(keyed, schemas);
    expect(plan.bakes.map((b) => b.target)).not.toContain(bake.target);
    expect(plan.skipped.map((s) => s.reason).join(' ')).toContain('already has keyframes');
    const baked = bakeArrangementCurves(schemas, { newId }).apply(keyed);
    expect(allBindings(baked).some(({ binding }) => bake.bindingIds.includes(binding.id))).toBe(true);
  });

  it('leaves a curve with its own shaping, and hand-drawn curves it was not asked about', () => {
    const document = withDrop();
    const shaped = bakeArrangementCurves(schemas, { newId });
    const rows = allBindings(document).filter(({ binding }) => binding.label === 'Drop');
    const target = rows[0]!.binding.target;
    const edited: ProjectDocument = { ...document, globalModulations: document.globalModulations.map((b) => (b.target === target ? { ...b, curve: { ...b.curve, type: 'exp', amount: 0.5 } } : b)) };
    expect(planCurveBake(edited, schemas).skipped.map((s) => s.reason).join(' ')).toContain('own shaping');
    const relabelled: ProjectDocument = { ...document, globalModulations: document.globalModulations.map((b) => ({ ...b, label: b.source.type === 'curve' ? 'Mine' : b.label })) };
    const after = shaped.apply(relabelled);
    expect(allBindings(after).filter(({ binding }) => binding.label === 'Mine').length).toBeGreaterThan(0);
  });

  it('changes nothing on a project with no arrangement curves, and never runs on load', () => {
    const empty = directorInput().document;
    expect(bakeArrangementCurves(schemas, { newId }).apply(empty)).toBe(empty);
    const document = withDrop();
    const loaded = parseDocument(JSON.parse(stringifyDocument(document))).document;
    expect(allBindings(loaded).some(({ binding }) => binding.label === 'Section intensity')).toBe(true);
  });

  it('after a bake, a reroll keeps the baked layers rather than orphaning their keys', () => {
    const document = bakeArrangementCurves(schemas, { newId }).apply(withDrop());
    const second = direct(directorInput(document), { seed: 9, templateId: NEON }).document;
    for (const track of second.automation) expect(describeTarget(second, track.target, schemas).problem, track.target).toBeNull();
    expect(second.layers.filter((l) => l.name === 'Fade')).toHaveLength(1);
  });
});
