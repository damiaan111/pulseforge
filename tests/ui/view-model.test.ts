// The renderer's view model (src/ui/view-model.ts) — the part of the UI that can be tested
// without a browser, which is where the counting logic belongs so the DOM code stays trivial.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { createDocument, createEffect, createGroupLayer, createModuleLayer } from '../../src/project/create.ts';
import { loadDocument } from '../../src/project/load.ts';
import { describeProject } from '../../src/ui/view-model.ts';

const fixture = () =>
  loadDocument(readFileSync(fileURLToPath(new URL('../project/fixtures/v1-full.pvproj', import.meta.url)), 'utf8')).document;

const blank = () => createDocument({ timestamp: '2026-09-14T00:00:00.000Z' });

describe('describeProject', () => {
  it('describes an empty project honestly', () => {
    expect(describeProject(blank())).toMatchObject({
      aspect: '16:9',
      layerCount: 0,
      groupCount: 0,
      effectCount: 0,
      bindingCount: 0,
      moduleIds: [],
    });
  });

  it('counts layers inside groups, not just the top level', () => {
    const document = {
      ...blank(),
      layers: [
        createModuleLayer('core.visualizer.bars', { id: '0000000000K000000000000001' }),
        createGroupLayer([
          createModuleLayer('core.test.pattern', { id: '0000000000K000000000000002' }),
          createModuleLayer('core.visualizer.bars', { id: '0000000000K000000000000003' }),
        ], { id: '0000000000G000000000000001' }),
      ],
    };
    const summary = describeProject(document);
    expect(summary.layerCount).toBe(4); // three modules plus the group itself
    expect(summary.groupCount).toBe(1);
    expect(summary.moduleIds).toEqual(['core.test.pattern', 'core.visualizer.bars']);
  });

  it('counts global effects and bindings alongside the per-layer ones', () => {
    const document = {
      ...fixture(),
      globalEffects: [createEffect('core.effect.vignette', { id: '0000000000E000000000000099' })],
    };
    const summary = describeProject(document);
    // The fixture has one bloom on its bars layer, plus this global vignette.
    expect(summary.effectCount).toBe(2);
    expect(summary.bindingCount).toBe(1);
    expect(summary.moduleIds).toContain('core.effect.bloom');
    expect(summary.moduleIds).toContain('core.effect.vignette');
  });

  it('reports the aspect bucket the canvas falls into', () => {
    const vertical = createDocument({ timestamp: '2026-09-14T00:00:00.000Z', canvas: { width: 1080, height: 1920 } });
    expect(describeProject(vertical).aspect).toBe('9:16');
  });
});
