// Plain summaries of a project for display.
//
// Kept apart from the DOM so it is unit-testable without a browser, which is the pattern the
// React studio follows too: derive a view model, then render it.

import { aspectBucket, walkLayers, type AspectBucket, type ProjectDocument } from '../project/document.ts';

export type { EnvironmentReport } from '../shell/ipc.ts';

/** Structurally what `SnapshotNote` is; re-declared so the UI does not import the snapshot type. */
export interface SnapshotNoteView {
  readonly path: string;
  readonly detail: string;
}

export interface ProjectSummary {
  readonly aspect: AspectBucket;
  /** Every layer, groups included, at any depth. */
  readonly layerCount: number;
  readonly groupCount: number;
  readonly effectCount: number;
  readonly bindingCount: number;
  readonly moduleIds: readonly string[];
}

export function describeProject(document: ProjectDocument): ProjectSummary {
  let layerCount = 0;
  let groupCount = 0;
  let effectCount = document.globalEffects.length;
  let bindingCount = document.globalModulations.length;
  const moduleIds = new Set<string>();

  for (const { layer } of walkLayers(document.layers)) {
    layerCount += 1;
    if (layer.kind === 'group') groupCount += 1;
    else moduleIds.add(layer.module);
    effectCount += layer.effects.length;
    bindingCount += layer.modulations.length;
    for (const effect of layer.effects) moduleIds.add(effect.module);
  }
  for (const effect of document.globalEffects) moduleIds.add(effect.module);

  return {
    aspect: aspectBucket(document.canvas.width, document.canvas.height),
    layerCount,
    groupCount,
    effectCount,
    bindingCount,
    moduleIds: [...moduleIds].sort(),
  };
}
