// Applying presets from the browser (S8), and what a thumbnail is drawn from.

import { describe, expect, it } from 'vitest';

import { createBinding, createDocument, createModuleLayer } from '../../src/project/create.ts';
import type { ProjectDocument } from '../../src/project/document.ts';
import { applyPreset, defaultApplyMode } from '../../src/project/preset-apply.ts';
import { THUMBNAIL, thumbnailDocument, thumbnailFrames } from '../../src/project/preset-thumbnail.ts';
import { createLayerPreset, createProjectPreset, type ManifestLookup } from '../../src/project/presets.ts';

const manifests: ManifestLookup = (id) => ({
  'core.visualizer.bars': { version: '1', paramsSchemaVersion: 1, defaults: { glow: 0.4, barCount: 64 } },
  'core.visualizer.orb': { version: '1', paramsSchemaVersion: 1, defaults: { radius: 0.2 } },
} as Record<string, ReturnType<ManifestLookup>>)[id];

let counter = 0;
const newId = () => `N${String(counter++).padStart(3, '0')}`;

const L1 = '0000000000L000000000000001';
const L2 = '0000000000L000000000000002';

function document(): ProjectDocument {
  const mine = {
    ...createModuleLayer('core.visualizer.orb', { id: L1, name: 'Mine', params: { radius: 0.3 } }),
    modulations: [createBinding(`layers.${L1}.params.radius`, { id: 'B1' })],
  };
  return { ...createDocument({ timestamp: '2026-01-01T00:00:00.000Z' }), layers: [mine] };
}

function barsPreset() {
  const source = {
    ...createModuleLayer('core.visualizer.bars', { id: L2, name: 'Neon bars', params: { glow: 0.9 } }),
    modulations: [createBinding(`layers.${L2}.params.glow`, { id: 'B2', amount: 0.5 })],
  };
  return createLayerPreset(source, manifests, { name: 'Neon bars', tags: ['neon'] });
}

describe('applying a preset from the browser', () => {
  it('a click replaces the selected layer, or adds one when nothing is selected', () => {
    const preset = barsPreset();
    expect(defaultApplyMode(preset, document(), L1)).toBe('replace');
    expect(defaultApplyMode(preset, document(), null)).toBe('add');
    expect(defaultApplyMode(createProjectPreset(document(), manifests), document(), L1)).toBe('look');
  });

  it('add puts a new layer of the preset on top and selects it', () => {
    const { command, select } = applyPreset(barsPreset(), 'add', { document: document(), selectedLayerId: null, manifests, newId });
    const next = command.apply(document());
    expect(next.layers).toHaveLength(2);
    expect(next.layers[1]!.id).toBe(select);
    expect(next.layers[1]!.kind === 'module' && next.layers[1]!.module).toBe('core.visualizer.bars');
  });

  it('replace swaps the selected layer for the preset, in the same place', () => {
    const { command, select } = applyPreset(barsPreset(), 'replace', { document: document(), selectedLayerId: L1, manifests, newId });
    const next = command.apply(document());
    expect(next.layers).toHaveLength(1);
    const layer = next.layers[0]!;
    expect(layer.id).toBe(select);
    expect(layer.kind === 'module' && layer.module).toBe('core.visualizer.bars');
    expect(command.label).toContain('Neon bars');
  });

  it('style keeps the layer’s own name and modulations', () => {
    const { command } = applyPreset(barsPreset(), 'style', { document: document(), selectedLayerId: L1, manifests, newId });
    const layer = command.apply(document()).layers[0]!;
    expect(layer.name).toBe('Mine');
    expect(layer.kind === 'module' && layer.modulations.map((m) => m.id)).toEqual(['B1']);
  });

  it('modulations keeps the layer whole and takes only the bindings', () => {
    const { command, notes, select } = applyPreset(barsPreset(), 'modulations', { document: document(), selectedLayerId: L1, manifests, newId });
    const layer = command.apply(document()).layers[0]!;
    expect(select).toBe(L1);
    expect(layer.kind === 'module' && layer.module).toBe('core.visualizer.orb');
    expect(layer.kind === 'module' && layer.params).toEqual({ radius: 0.3 });
    expect(layer.kind === 'module' && layer.modulations.map((m) => m.target)).toEqual([`layers.${L1}.params.glow`]);
    // The orb has no glow: said, not silently kept as a dead binding.
    expect(notes.join(' ')).toContain('core.visualizer.bars');
  });

  it('refuses to change a locked layer, but may still add beside it', () => {
    const locked = { ...document(), layers: document().layers.map((l) => ({ ...l, locked: true })) };
    for (const mode of ['replace', 'style', 'modulations'] as const) {
      expect(() => applyPreset(barsPreset(), mode, { document: locked, selectedLayerId: L1, manifests, newId })).toThrow(/locked/);
    }
    expect(() => applyPreset(barsPreset(), 'add', { document: locked, selectedLayerId: L1, manifests, newId })).not.toThrow();
  });

  it('refuses to replace when nothing is selected, with a sentence', () => {
    expect(() => applyPreset(barsPreset(), 'replace', { document: document(), selectedLayerId: null, manifests, newId })).toThrow(/Select a layer/);
  });

  it('a project preset replaces the look, or merges it above, and leaves the rest', () => {
    const look = createProjectPreset({ ...document(), layers: [createModuleLayer('core.visualizer.bars', { id: L2 })] }, manifests, { name: 'Look' });
    const base = { ...document(), seed: 42 };
    const replaced = applyPreset(look, 'look', { document: base, selectedLayerId: null, manifests, newId }).command.apply(base);
    expect(replaced.layers.map((l) => l.kind === 'module' && l.module)).toEqual(['core.visualizer.bars']);
    expect(replaced.seed).toBe(42);
    const merged = applyPreset(look, 'merge', { document: base, selectedLayerId: null, manifests, newId }).command.apply(base);
    expect(merged.layers.map((l) => l.kind === 'module' && l.module)).toEqual(['core.visualizer.orb', 'core.visualizer.bars']);
  });
});

describe('the thumbnail document', () => {
  it('is the preset alone on a small dark canvas', () => {
    const { document: thumb, notes } = thumbnailDocument(barsPreset(), manifests, newId);
    expect(thumb.canvas).toMatchObject({ width: THUMBNAIL.width, height: THUMBNAIL.height, background: '#05060a' });
    expect(thumb.layers).toHaveLength(1);
    expect(thumb.layers[0]!.kind === 'module' && thumb.layers[0]!.params).toEqual({ glow: 0.9 });
    expect(notes).toEqual([]);
  });

  it('spreads its frames over the reference track', () => {
    const frames = thumbnailFrames();
    expect(frames).toHaveLength(THUMBNAIL.frames);
    expect(new Set(frames).size).toBe(frames.length);
    expect(frames.at(-1)! / THUMBNAIL.fps).toBeLessThan(THUMBNAIL.referenceSeconds);
  });
});
