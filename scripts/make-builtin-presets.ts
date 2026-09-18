// `npm run presets:builtin` — writes the presets that ship with the app, `presets/builtin/` (S8, D16).
//
// Built from code rather than hand-written JSON so they stay valid as modules evolve: every preset
// is made with the same `createLayerPreset` / `createProjectPreset` the Save dialog uses, and the
// script refuses to write one that names a module or a parameter the build does not have — a
// built-in that silently lost its point after a rename would be worse than none. Re-run it when a
// module's defaults change (presets store only non-defaults, so most changes need nothing) and
// commit the diff; the thumbnails are a cache and are drawn by the studio on first view.
//
// Layer presets use literal colours, so their thumbnails look as intended on any project. Project
// presets carry a palette and link their colours to its roles (`@primary`), so the look arrives
// reskinnable (compositor-spec §9).

import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ROOT } from '../setup/lib/paths.ts';
import { resolveParams } from '../src/engine/core/params.ts';
import { BUILTIN_MODULES } from '../src/engine/engine.ts';
import { createBinding, createDocument, createEffect, createModuleLayer } from '../src/project/create.ts';
import type { EffectSpec, Layer, ModuleLayer, Palette, ProjectDocument } from '../src/project/document.ts';
import { linkedRole } from '../src/project/palette.ts';
import { slugify } from '../src/project/preset-store.ts';
import { createLayerPreset, createProjectPreset, stringifyPreset, type ManifestLookup, type Preset } from '../src/project/presets.ts';

const OUT = join(ROOT, 'presets', 'builtin');
const manifests = new Map(BUILTIN_MODULES.map((m) => [m.manifest.id, m.manifest]));

const lookup: ManifestLookup = (id) => {
  const manifest = manifests.get(id);
  return manifest === undefined ? undefined : {
    version: manifest.version,
    paramsSchemaVersion: manifest.paramsSchemaVersion,
    defaults: resolveParams(manifest.params, {}).values,
  };
};

/** A module id and values, checked against its manifest: unknown ids and keys stop the script. */
function checked(module: string, params: Record<string, unknown>): Record<string, unknown> {
  const manifest = manifests.get(module);
  if (manifest === undefined) throw new Error(`No module ${module}`);
  const keys = new Set(manifest.params.map((p) => p.key));
  for (const key of Object.keys(params)) {
    if (!keys.has(key)) throw new Error(`${module} has no parameter "${key}"`);
  }
  // Palette links (`@primary`) resolve on the way to the engine, not here: check that each names a
  // real role, then validate the rest as literals.
  const literal: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && value.startsWith('@')) {
      if (linkedRole(value) === undefined) throw new Error(`${module}.${key}: "${value}" is not a palette role`);
    } else {
      literal[key] = value;
    }
  }
  const issues = resolveParams(manifest.params, literal).issues;
  if (issues.length > 0) throw new Error(`${module}: ${issues.map((i) => `${i.key}: ${i.detail}`).join('; ')}`);
  return params;
}

// Stable ids: the ids never reach the preset (it stores targets relative to the layer), but stable
// input keeps the script's output byte-identical between runs.
let counter = 0;
const id = () => `0000000000P0000000000${String(counter++).padStart(5, '0')}`;

function fx(module: string, params: Record<string, unknown> = {}): EffectSpec {
  return createEffect(module, { id: id(), params: checked(module, params) });
}

function layer(
  module: string,
  name: string,
  params: Record<string, unknown>,
  options: { effects?: EffectSpec[]; bind?: [target: string, source: string, amount: number][]; blend?: ModuleLayer['blend']; opacity?: number } = {},
): ModuleLayer {
  const base = createModuleLayer(module, { id: id(), name, params: checked(module, params) });
  const effects = options.effects ?? [];
  const modulations = (options.bind ?? []).map(([target, source, amount]) => {
    // `effects.N.key` names the Nth effect's parameter; anything else is the layer's own.
    const match = /^effects\.(\d+)\.(.+)$/.exec(target);
    const path = match === null
      ? `layers.${base.id}.params.${target}`
      : `layers.${base.id}.effects.${effects[Number(match[1])]!.id}.params.${match[2]}`;
    return createBinding(path, { id: id(), sourceType: source, amount });
  });
  return { ...base, effects, modulations, ...(options.blend === undefined ? {} : { blend: options.blend }), ...(options.opacity === undefined ? {} : { opacity: options.opacity }) };
}

const LAYERS: [Layer, string[]][] = [
  [layer('core.visualizer.bars', 'Neon bars', { barCount: 72, fill: '#ff2d95', maxHeight: 0.55 }, {
    effects: [fx('core.effect.bloom', { threshold: 0.45, intensity: 1.1 })],
    bind: [['effects.0.intensity', 'onset', 0.8]],
  }), ['neon', 'bars', 'glow', 'club']],
  [layer('core.visualizer.curve', 'Cyan horizon', { mirror: true, fillBody: 0.4, fill: '#00e5ff', thickness: 0.005 }, {
    effects: [fx('core.effect.bloom', { threshold: 0.5, intensity: 0.8 })],
  }), ['calm', 'curve', 'cyan']],
  [layer('core.visualizer.radial', 'Radial pulse', { barCount: 128, radius: 0.2, length: 0.2, fill: '#ff2d95', innerGlow: 0.5 }, {
    effects: [fx('core.effect.bloom', { threshold: 0.5, intensity: 1 }), fx('core.effect.chromatic', { amount: 0.006 })],
    bind: [['effects.1.amount', 'beat', 0.008]],
  }), ['radial', 'club', 'neon']],
  [layer('core.visualizer.orb', 'Deep orb', { drive: 'beat', swell: 0.6, ripple: 0.4, fill: '#7a2fff', core: 1.4 }, {
    effects: [fx('core.effect.bloom', { threshold: 0.3, intensity: 1.2, radius: 0.04 })],
  }), ['ambient', 'orb', 'glow']],
  [layer('core.visualizer.tunnel', 'Retro tunnel', { rings: 9, twist: 0.6, fill: '#00e5ff' }, {
    effects: [fx('core.effect.scanlines', { lines: 180, depth: 0.5 }), fx('core.effect.bloom')],
  }), ['retro', 'tunnel', 'crt']],
  [layer('core.visualizer.particles', 'Embers', { count: 700, fill: '#ffb347', direction: 'up', speed: 0.08, flare: 1.6 }, {
    effects: [fx('core.effect.bloom', { threshold: 0.4, intensity: 1 })],
  }), ['particles', 'warm', 'ambient']],
  [layer('core.visualizer.spectrogram', 'Heat map', { style: 'heat', window: 6, fill: '#ff5a1f' }), ['spectrogram', 'analysis']],
  [layer('core.visualizer.waves', 'Soft waves', { lines: 12, amplitude: 0.09, fill: '#8ea4d2' }, {
    effects: [fx('core.effect.blur', { radius: 0.003 })],
  }), ['calm', 'waves', 'ambient']],
  [layer('core.scene3d.terrain', 'Synthwave flight', { direction: 'toward', flow: 14, low: '#3a7bff', high: '#ff2d95' }, {
    effects: [fx('core.effect.bloom', { threshold: 0.5, intensity: 0.9 })],
  }), ['3d', 'synthwave', 'terrain', 'retro']],
  [layer('core.scene3d.shapes', 'Chrome knot', { shape: 'knot', metalness: 0.85, roughness: 0.2, faceted: false, color: '#c9d4ff', rim: '#ff2d95', glow: 0.3 }, {
    effects: [fx('core.effect.dof', { focus: 5.2, range: 0.8, amount: 0.6 }), fx('core.effect.bloom', { threshold: 0.6 })],
  }), ['3d', 'cinematic', 'shape']],
  [layer('core.scene3d.city', 'Night city', { layout: 'downtown', size: 26, low: '#1c3fff', high: '#00e5ff', glow: 1.1 }, {
    effects: [fx('core.effect.dof', { focus: 22, range: 6, amount: 0.5 }), fx('core.effect.bloom', { threshold: 0.5 })],
  }), ['3d', 'city', 'bars', 'cinematic']],
];

function project(name: string, palette: Palette, layers: Layer[], globalEffects: EffectSpec[]): ProjectDocument {
  return { ...createDocument({ id: id(), name, timestamp: '2026-01-01T00:00:00.000Z' }), palette, layers, globalEffects };
}

const palette = (colors: string[], roles: Record<string, number>): Palette => ({ colors, roles, extra: {} });

const PROJECTS: [ProjectDocument, string[]][] = [
  [project('Synthwave night', palette(['#ff2d95', '#3a7bff', '#0b0614', '#2a0845'], { primary: 0, accent: 1, background: 2, secondary: 3 }), [
    layer('core.source.background', 'Sky', { mode: 'gradient', colorA: '@background', colorB: '@secondary', angle: 90 }),
    layer('core.scene3d.terrain', 'Ground', { direction: 'toward', flow: 12, low: '@accent', high: '@primary' }),
    layer('core.visualizer.curve', 'Horizon line', { baseline: 0.42, height: 0.2, mirror: true, fill: '@primary' }, { blend: 'add' }),
  ], [fx('core.effect.bloom', { threshold: 0.55 }), fx('core.effect.grain', { amount: 0.05 }), fx('core.effect.vignette')]), ['synthwave', 'retro', '3d']],
  [project('Club bars', palette(['#ff2d95', '#00e5ff', '#000000'], { primary: 0, accent: 1, background: 2 }), [
    layer('core.source.background', 'Black', { mode: 'solid', colorA: '@background' }),
    layer('core.visualizer.radial', 'Ring', { barCount: 128, fill: '@accent', innerGlow: 0.4 }, { blend: 'add' }),
    layer('core.visualizer.bars', 'Floor', { barCount: 64, fill: '@primary' }),
  ], [fx('core.effect.bloom', { threshold: 0.45, intensity: 1 }), fx('core.effect.chromatic'), fx('core.effect.vignette')]), ['club', 'bars', 'neon']],
  [project('Cinematic chrome', palette(['#c9d4ff', '#ff2d95', '#05070f', '#16213e'], { primary: 0, accent: 1, background: 2, secondary: 3 }), [
    layer('core.source.background', 'Backdrop', { mode: 'gradient', gradient: 'radial', colorA: '@secondary', colorB: '@background' }),
    layer('core.visualizer.particles', 'Dust', { count: 300, fill: '@primary', size: 0.006, speed: 0.02 }, { opacity: 0.6 }),
    layer('core.scene3d.shapes', 'Subject', { shape: 'knot', metalness: 0.85, roughness: 0.2, faceted: false, color: '@primary', rim: '@accent' }, {
      effects: [fx('core.effect.dof', { focus: 5.2, range: 0.8, amount: 0.6 })],
    }),
  ], [fx('core.effect.bloom', { threshold: 0.6 }), fx('core.effect.grade', { contrast: 1.1, saturation: 0.9 }), fx('core.effect.grain', { amount: 0.04 }), fx('core.effect.vignette')]), ['cinematic', '3d', 'dark']],
];

async function writeAll(scope: 'layer' | 'project', presets: readonly Preset[]): Promise<void> {
  const dir = join(OUT, scope);
  await mkdir(dir, { recursive: true });
  // A rename in this file must not leave the old file behind as a ghost preset.
  for (const file of await readdir(dir)) if (file.endsWith('.json')) await rm(join(dir, file));
  for (const preset of presets) {
    const path = join(dir, `${slugify(preset.name)}.json`);
    await writeFile(path, stringifyPreset(preset));
    console.log(`  ${scope}/${slugify(preset.name)}.json`);
  }
}

const layerPresets = LAYERS.map(([source, tags]) => createLayerPreset(source, lookup, { name: source.name, tags }));
const projectPresets = PROJECTS.map(([document, tags]) => createProjectPreset(document, lookup, { name: document.name, tags }));
console.log(`Writing ${layerPresets.length} layer and ${projectPresets.length} project presets to ${OUT}`);
await writeAll('layer', layerPresets);
await writeAll('project', projectPresets);
