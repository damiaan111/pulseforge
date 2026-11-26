// What a recovered autosave holds that the saved file does not (M1, ui-spec §10: "a diff summary of
// what it contains"), in a few plain lines — enough to decide "restore" or "discard" without opening
// both. Pure; compares layers by id, so a renamed layer reads as changed, not as removed and added.

import { stringifyDocument } from './serialize.ts';
import { walkLayers, type Layer, type ProjectDocument } from './document.ts';

export function summarizeRecovery(saved: ProjectDocument | null, recovered: ProjectDocument): readonly string[] {
  const recoveredLayers = layerMap(recovered);
  const count = recoveredLayers.size;
  if (saved === null) {
    return [`A project that was never saved, with ${count} layer${count === 1 ? '' : 's'}.`];
  }
  if (stringifyDocument({ ...saved, modifiedAt: '' }) === stringifyDocument({ ...recovered, modifiedAt: '' })) {
    return ['The same as the saved file.'];
  }

  const savedLayers = layerMap(saved);
  const added = [...recoveredLayers.keys()].filter((id) => !savedLayers.has(id));
  const removed = [...savedLayers.keys()].filter((id) => !recoveredLayers.has(id));
  const changed = [...recoveredLayers.keys()].filter((id) => savedLayers.has(id) && recoveredLayers.get(id) !== savedLayers.get(id));
  const lines: string[] = [];
  const names = (ids: readonly string[], layers: ReadonlyMap<string, string>, from: ProjectDocument) =>
    ids.slice(0, 3).map((id) => `“${nameOf(from, id) ?? layers.get(id) ?? id}”`).join(', ') + (ids.length > 3 ? `, and ${ids.length - 3} more` : '');
  if (added.length > 0) lines.push(`${added.length} layer${added.length === 1 ? '' : 's'} added: ${names(added, recoveredLayers, recovered)}.`);
  if (removed.length > 0) lines.push(`${removed.length} layer${removed.length === 1 ? '' : 's'} removed: ${names(removed, savedLayers, saved)}.`);
  if (changed.length > 0) lines.push(`${changed.length} layer${changed.length === 1 ? '' : 's'} edited: ${names(changed, recoveredLayers, recovered)}.`);
  if (json(saved.palette) !== json(recovered.palette)) lines.push('The palette changed.');
  if (json(saved.audio) !== json(recovered.audio)) lines.push('The audio clip changed (file, trim, fades or gain).');
  if (json(saved.canvas) !== json(recovered.canvas)) lines.push('The canvas changed.');
  if (json(saved.globalEffects) !== json(recovered.globalEffects)) lines.push('The global effects changed.');
  if (json(saved.lyrics) !== json(recovered.lyrics)) {
    const timed = (d: ProjectDocument) => d.lyrics.lines.filter((l) => l.startTicks !== null).length;
    lines.push(`The lyrics changed (${recovered.lyrics.lines.length} lines, ${timed(recovered)} timed; the saved file has ${saved.lyrics.lines.length}, ${timed(saved)} timed).`);
  }
  if (saved.name !== recovered.name) lines.push(`Renamed “${saved.name}” → “${recovered.name}”.`);
  return lines.length > 0 ? lines : ['Small changes (settings that are not layers, palette, audio or canvas).'];
}

/** Layer id → its serialised form, for "is it the same?" comparisons. */
function layerMap(document: ProjectDocument): Map<string, string> {
  const map = new Map<string, string>();
  for (const { layer } of walkLayers(document.layers)) map.set(layer.id, json(shallow(layer)));
  return map;
}

/** A layer without its children: a group whose child changed is not itself "edited". */
function shallow(layer: Layer): unknown {
  return layer.kind === 'group' ? { ...layer, children: layer.children.map((c) => c.id) } : layer;
}

function nameOf(document: ProjectDocument, id: string): string | undefined {
  for (const { layer } of walkLayers(document.layers)) if (layer.id === id) return layer.name === '' ? '(unnamed)' : layer.name;
  return undefined;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}
