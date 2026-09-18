// The presets that ship in presets/builtin/ (S8, D16): every one must load, apply cleanly to a
// fresh project with nothing left behind in the notes, and reach the engine with its palette links
// resolved. A built-in that arrives half-broken is the first thing a new user sees.

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ROOT } from '../../setup/lib/paths.ts';
import { resolveParams } from '../../src/engine/core/params.ts';
import { BUILTIN_MODULES } from '../../src/engine/engine.ts';
import { createDocument } from '../../src/project/create.ts';
import { applyPreset } from '../../src/project/preset-apply.ts';
import { PresetStore } from '../../src/project/preset-store.ts';
import type { ManifestLookup } from '../../src/project/presets.ts';
import { toRenderProject } from '../../src/project/snapshot.ts';

const manifests = new Map(BUILTIN_MODULES.map((m) => [m.manifest.id, m.manifest]));
const lookup: ManifestLookup = (id) => {
  const manifest = manifests.get(id);
  return manifest === undefined ? undefined : {
    version: manifest.version,
    paramsSchemaVersion: manifest.paramsSchemaVersion,
    defaults: resolveParams(manifest.params, {}).values,
  };
};

let counter = 0;
const newId = () => `0000000000T0000000000${String(counter++).padStart(5, '0')}`;

const store = new PresetStore({ root: join(ROOT, 'out', 'no-user-presets'), builtinRoot: join(ROOT, 'presets', 'builtin') });
const library = await store.list();

describe('built-in presets', () => {
  it('all load, and there are some of each scope', () => {
    expect(library.problems).toEqual([]);
    expect(library.entries.filter((e) => e.scope === 'layer').length).toBeGreaterThanOrEqual(8);
    expect(library.entries.filter((e) => e.scope === 'project').length).toBeGreaterThanOrEqual(3);
    for (const entry of library.entries) expect(entry.origin).toBe('builtin');
  });

  it.each(library.entries.map((e) => [`${e.scope}/${e.slug}`, e] as const))('%s applies cleanly', (_name, entry) => {
    const document = createDocument({ timestamp: '2026-01-01T00:00:00.000Z' });
    const mode = entry.scope === 'project' ? 'look' : 'add';
    const applied = applyPreset(entry.preset, mode, { document, selectedLayerId: null, manifests: lookup, newId });
    expect(applied.notes).toEqual([]);
    const snapshot = toRenderProject(applied.command.apply(document));
    // No unresolved palette link, unknown module or other snapshot complaint.
    expect(snapshot.notes).toEqual([]);
    expect(entry.tags.length).toBeGreaterThan(0);
  });
});
