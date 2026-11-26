// Keyframes in the project (S1, docs/keyframes-spec.md §3, §5, §6): the commands, the file format,
// the snapshot to the engine, and what deleting and duplicating a layer do to its tracks.

import { describe, expect, it } from 'vitest';

import {
  moveKeyframes, removeKeyframes, removeTrack, setKeyframe, setKeyframeEasing, setKeyframeTime, setTrackEnabled, trackFor,
} from '../../src/project/automation-commands.ts';
import { duplicateLayer, removeLayer } from '../../src/project/commands.ts';
import { createDocument, createModuleLayer } from '../../src/project/create.ts';
import type { ProjectDocument } from '../../src/project/document.ts';
import { createTestIdFactory } from '../../src/project/ids.ts';
import { parseDocument } from '../../src/project/parse.ts';
import { stringifyDocument } from '../../src/project/serialize.ts';
import { toRenderProject } from '../../src/project/snapshot.ts';

const S = 48_000;
const L1 = '0000000000N000000000000001';
const target = `layers.${L1}.params.radius`;

function base(): { doc: ProjectDocument; newId: () => string } {
  const newId = createTestIdFactory('K');
  const doc = { ...createDocument({ id: '0000000000P000000000000001', timestamp: '2026-09-25T00:00:00.000Z' }), layers: [createModuleLayer('core.visualizer.radial', { id: L1, name: 'Ring' })] };
  return { doc, newId };
}

describe('keyframe commands', () => {
  it('setting a key creates the track; setting at the same tick updates it; keys stay sorted', () => {
    const { doc, newId } = base();
    let d = setKeyframe(target, 2 * S, 0.3, { newId }).apply(doc);
    d = setKeyframe(target, 0, 0.1, { newId }).apply(d);
    d = setKeyframe(target, 2 * S, 0.35, { newId }).apply(d);
    const track = trackFor(d, target)!;
    expect(track.keyframes.map((k) => [k.ticks, k.value])).toEqual([[0, 0.1], [2 * S, 0.35]]);
    expect(d.automation).toHaveLength(1);
  });

  it('a key added after another takes the easing of the key before it', () => {
    const { doc, newId } = base();
    let d = setKeyframe(target, 0, 0.1, { newId, easing: 'easeInOut' }).apply(doc);
    d = setKeyframe(target, 4 * S, 0.3, { newId }).apply(d);
    d = setKeyframe(target, 2 * S, 0.2, { newId }).apply(d);
    // The 4 s key took easeInOut from the 0 s key when it was added; so did the one inserted at 2 s.
    expect(trackFor(d, target)!.keyframes.map((k) => k.easing)).toEqual(['easeInOut', 'easeInOut', 'easeInOut']);
  });

  it('moving a key onto another replaces that one; time is clamped at 0', () => {
    const { doc, newId } = base();
    let d = setKeyframe(target, 1 * S, 1, { newId }).apply(doc);
    d = setKeyframe(target, 3 * S, 3, { newId }).apply(d);
    const [k1] = trackFor(d, target)!.keyframes;
    d = moveKeyframes([k1!.id], 2 * S).apply(d);
    expect(trackFor(d, target)!.keyframes.map((k) => [k.ticks, k.value])).toEqual([[3 * S, 1]]);
    d = setKeyframeTime(k1!.id, -500).apply(d);
    expect(trackFor(d, target)!.keyframes[0]!.ticks).toBe(0);
  });

  it('removing the last key removes the track; easing, enable and remove-track apply', () => {
    const { doc, newId } = base();
    let d = setKeyframe(target, 0, 1, { newId }).apply(doc);
    const track = trackFor(d, target)!;
    d = setKeyframeEasing([track.keyframes[0]!.id], { cubic: [0.2, 0, 0.1, 1] }).apply(d);
    expect(trackFor(d, target)!.keyframes[0]!.easing).toEqual({ cubic: [0.2, 0, 0.1, 1] });
    d = setTrackEnabled(track.id, false).apply(d);
    expect(trackFor(d, target)!.enabled).toBe(false);
    expect(removeKeyframes([track.keyframes[0]!.id]).apply(d).automation).toEqual([]);
    expect(removeTrack(track.id).apply(d).automation).toEqual([]);
  });

  it('deleting a layer takes its tracks; duplicating copies them onto the copy', () => {
    const { doc, newId } = base();
    const d = setKeyframe(target, 0, 1, { newId }).apply(doc);
    expect(removeLayer(L1).apply(d).automation).toEqual([]);
    const dup = duplicateLayer(L1, newId).apply(d);
    const copy = dup.layers.find((l) => l.id !== L1)!;
    expect(dup.automation.map((t) => t.target)).toEqual([target, `layers.${copy.id}.params.radius`]);
    expect(new Set(dup.automation.flatMap((t) => [t.id, ...t.keyframes.map((k) => k.id)])).size).toBe(4);
  });
});

describe('keyframes in the file and to the engine', () => {
  it('round-trips, sorted, with cubic easing; a project without keys saves without the field', () => {
    const { doc, newId } = base();
    expect(JSON.parse(stringifyDocument(doc))['automation']).toBeUndefined();
    let d = setKeyframe(target, 2 * S, 0.3, { newId, easing: { cubic: [0.1, 0.2, 0.3, 1.4] } }).apply(doc);
    d = setKeyframe(`layers.${L1}.params.fill`, 0, '@accent', { newId }).apply(d);
    const back = parseDocument(JSON.parse(stringifyDocument(d)));
    expect(back.issues).toEqual([]);
    expect(stringifyDocument(back.document)).toBe(stringifyDocument(d));
  });

  it('reports a duplicate tick and a track on a missing layer, keeping them', () => {
    const { doc } = base();
    const raw = JSON.parse(stringifyDocument(doc));
    raw.automation = [
      { id: '0000000000K000000000000001', target: target, enabled: true, keyframes: [
        { id: '0000000000K000000000000002', ticks: 0, value: 1, easing: 'linear' },
        { id: '0000000000K000000000000003', ticks: 0, value: 2, easing: 'bouncy' },
      ] },
      { id: '0000000000K000000000000004', target: 'layers.0000000000N000000000000009.opacity', enabled: true, keyframes: [] },
    ];
    const { document, issues } = parseDocument(raw);
    expect(issues.map((i) => i.problem).sort()).toEqual(['broken-reference', 'invalid-value', 'invalid-value']);
    expect(document.automation[0]!.keyframes.map((k) => k.value)).toEqual([2]);
    expect(document.automation).toHaveLength(2);
  });

  it('the snapshot sends enabled tracks with keys, palette links resolved', () => {
    const { doc: plain, newId } = base();
    const doc = { ...plain, palette: { colors: ['#ff2d95'], roles: { primary: 0 }, extra: {} } };
    let d = setKeyframe(`layers.${L1}.params.fill`, 0, '@primary', { newId }).apply(doc);
    d = setKeyframe(target, 0, 0.3, { newId }).apply(d);
    d = setTrackEnabled(trackFor(d, target)!.id, false).apply(d);
    const { project } = toRenderProject(d);
    expect(project.automation?.map((t) => t.target)).toEqual([`layers.${L1}.params.fill`]);
    expect(project.automation?.[0]?.keyframes[0]?.value).toBe('#ff2d95');
  });
});
