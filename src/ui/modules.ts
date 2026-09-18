// Every module the studio knows: the built-ins plus whatever the `modules/` folder holds (M35).
//
// The inspector, the "Add layer" buttons and the effect picker all read this instead of the static
// built-in list, so a drop-in module appears everywhere a built-in does — the schema generates its
// panel exactly as it does for a built-in (module-spec §13), with no UI code of its own.

import { useMemo } from 'react';

import type { ModuleDefinition, ModuleManifest } from '../engine/core/module.ts';
import { BUILTIN_MODULES } from '../engine/engine.ts';
import { shaderModuleDefinition, type ShaderModuleSource } from '../engine/modules/shader-module.ts';
import { useStudio } from './store.ts';

const cache = new WeakMap<readonly ShaderModuleSource[], readonly ModuleDefinition[]>();

/** Built-ins first, then drop-ins; the same array for the same sources, so effects do not re-run. */
export function moduleDefinitions(userModules: readonly ShaderModuleSource[]): readonly ModuleDefinition[] {
  const known = cache.get(userModules);
  if (known !== undefined) return known;
  const all = [...BUILTIN_MODULES, ...userModules.map(shaderModuleDefinition)];
  cache.set(userModules, all);
  return all;
}

export function useModules(): { all: readonly ModuleDefinition[]; manifests: ReadonlyMap<string, ModuleManifest> } {
  const userModules = useStudio((s) => s.userModules);
  return useMemo(() => {
    const all = moduleDefinitions(userModules);
    return { all, manifests: new Map(all.map((m) => [m.manifest.id, m.manifest])) };
  }, [userModules]);
}
