// Copying modulation from one layer to another: what fits comes across under new ids, retargeted;
// what does not is named and left behind.

import { describe, expect, it } from 'vitest';

import { BUILTIN_MODULES } from '../../src/engine/engine.ts';
import { GLOBAL_OWNER, addLayer, addModulation } from '../../src/project/commands.ts';
import { createBinding, createDocument, createEffect, createModuleLayer } from '../../src/project/create.ts';
import { effectParamTarget, layerParamTarget, planBindingPaste, type SchemaLookup } from '../../src/project/modulation-authoring.ts';
import type { ProjectDocument } from '../../src/project/document.ts';

const schemas: SchemaLookup = (id) => BUILTIN_MODULES.find((m) => m.manifest.id === id)?.manifest;
let ids = 0;
const newId = () => `0000000000PASTE00000000${String(ids++).padStart(3, '0')}`;


function project(): ProjectDocument {
  const bars = createModuleLayer('core.visualizer.bars', { id: 'BARS', name: 'Bars' });
  const other = createModuleLayer('core.visualizer.bars', { id: 'OTHER', name: 'Other' });
  const text = createModuleLayer('core.text.title', { id: 'TEXT', name: 'Title' });
  let document = createDocument({ name: 'Song' });
  for (const layer of [bars, other, text]) document = addLayer(layer).apply(document);
  return document;
}

describe('pasting bindings', () => {
  const param = BUILTIN_MODULES.find((m) => m.manifest.id === 'core.visualizer.bars')?.manifest.params.find((p) => p.modulatable !== false && p.type === 'float')?.key as string;

  it('retargets to the same parameter, with a new id, keeping the shaping', () => {
    const binding = { ...createBinding(layerParamTarget('BARS', param), { source: { kind: 'band', band: 'bass' } } as never), amount: 0.7 };
    const document = addModulation('BARS', binding).apply(project());
    const plan = planBindingPaste(document, document, [binding], 'OTHER', schemas, newId);
    expect(plan.skipped).toEqual([]);
    expect(plan.bindings[0]?.target).toBe(layerParamTarget('OTHER', param));
    expect(plan.bindings[0]?.amount).toBe(0.7);
    expect(plan.bindings[0]?.id).not.toBe(binding.id);
  });

  it('leaves behind what the layer does not have, and names it', () => {
    const binding = createBinding(layerParamTarget('BARS', param));
    const document = addModulation('BARS', binding).apply(project());
    const plan = planBindingPaste(document, document, [binding], 'TEXT', schemas, newId);
    if (schemas('core.text.title')?.params.some((p) => p.key === param)) return;
    expect(plan.bindings).toEqual([]);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]).toContain('Bars');
  });

  it('finds the same effect on the destination by module', () => {
    const base = project();
    const withEffects: ProjectDocument = {
      ...base,
      layers: base.layers.map((layer) => (layer.id === 'BARS' ? { ...layer, effects: [createEffect('core.effect.blur', { id: 'E1' })] } : layer.id === 'OTHER' ? { ...layer, effects: [createEffect('core.effect.blur', { id: 'E2' })] } : layer)),
      globalEffects: [createEffect('core.effect.blur', { id: 'E3' })],
    };
    const key = schemas('core.effect.blur')?.params[0]?.key as string;
    const binding = createBinding(effectParamTarget('BARS', 'E1', key));
    expect(planBindingPaste(withEffects, withEffects, [binding], 'OTHER', schemas, newId).bindings[0]?.target).toBe(effectParamTarget('OTHER', 'E2', key));
    expect(planBindingPaste(withEffects, withEffects, [binding], GLOBAL_OWNER, schemas, newId).bindings[0]?.target).toBe(effectParamTarget(GLOBAL_OWNER, 'E3', key));
    expect(planBindingPaste(withEffects, withEffects, [binding], 'TEXT', schemas, newId).skipped).toHaveLength(1);
  });
});
