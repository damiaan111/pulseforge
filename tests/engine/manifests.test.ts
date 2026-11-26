// Every built-in manifest, checked as data (module-spec §2–3). The GPU suites check that modules
// draw; this checks what the inspector, presets and modulation read before anything is drawn.

import { describe, expect, it } from 'vitest';

import { resolveParams } from '../../src/engine/core/params.ts';
import { BUILTIN_MODULES } from '../../src/engine/engine.ts';

describe('built-in manifests', () => {
  it('have unique ids', () => {
    const ids = BUILTIN_MODULES.map((m) => m.manifest.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });

  it.each(BUILTIN_MODULES.map((m) => [m.manifest.id, m] as const))('%s declares each parameter key once', (_id, module) => {
    // Two parameters under one key share one stored value: the second silently wins, and a
    // modulation aimed at one moves both. The 3D scenes' camera parameters are appended to each
    // scene's own, which is exactly where a collision hides.
    const keys = module.manifest.params.map((p) => p.key);
    expect(keys.filter((key, i) => keys.indexOf(key) !== i)).toEqual([]);
  });

  it.each(BUILTIN_MODULES.map((m) => [m.manifest.id, m] as const))('%s resolves its own defaults with no issues', (_id, module) => {
    expect(resolveParams(module.manifest.params, {}).issues).toEqual([]);
  });
});
