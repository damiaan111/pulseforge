// MIDI as a modulation source (C3), from the document to the evaluated signal. The traps are the
// ones markers and lyrics taught: a field the snapshot's whitelist drops, a field the derived-track
// key leaves out, and a document without MIDI that must save and snapshot exactly as before.

import { describe, expect, it } from 'vitest';

import {
  MIDI_PULSE_SECONDS, bindingLevels, compileModulation, midiNotesFor, midiPulse, type ModulationBinding as EngineBinding,
} from '../../src/engine/core/modulation.ts';
import { addModulation, setMidi } from '../../src/project/commands.ts';
import { createBinding, createDocument, createModuleLayer } from '../../src/project/create.ts';
import type { MidiClip, ModuleLayer, ProjectDocument } from '../../src/project/document.ts';
import { History } from '../../src/project/history.ts';
import { loadDocument } from '../../src/project/load.ts';
import { asMidiBinding, defaultBinding, describeMidiFilter, describeSource, midiChannelCounts, SOURCE_CHOICES } from '../../src/project/modulation-authoring.ts';
import { stringifyDocument } from '../../src/project/serialize.ts';
import { toRenderProject } from '../../src/project/snapshot.ts';
import type { ParamSpec } from '../../src/engine/core/params.ts';

const clip: MidiClip = {
  name: 'drums.mid',
  notes: [
    { ticks: 48_000, endTicks: 50_000, note: 36, velocity: 127, channel: 9 },
    { ticks: 96_000, endTicks: 98_000, note: 38, velocity: 64, channel: 9 },
    { ticks: 144_000, endTicks: 200_000, note: 60, velocity: 127, channel: 0 },
  ],
  extra: {},
};

const TARGET = 'layers.layer.params.glow';
const midiBinding = (patch: Partial<ModulationBinding['source']> = {}): ModulationBinding => {
  const base = asMidiBinding(createBinding(TARGET, { id: 'bind', sourceType: 'midi' }));
  return { ...base, envelope: { attackMs: 0, releaseMs: 0, mode: 'peak', extra: {} }, source: { ...base.source, ...patch } };
};
type ModulationBinding = ReturnType<typeof createBinding>;

function project(binding: ModulationBinding, midi: MidiClip | null = clip): ProjectDocument {
  const layer: ModuleLayer = { ...createModuleLayer('core.bars', { id: 'layer' }), modulations: [binding] };
  return { ...createDocument({ id: 'p', timestamp: 't', audio: { path: 'a.wav', durationTicks: 480_000 } }), layers: [layer], midi };
}

const compileFor = (document: ProjectDocument) => {
  const { project: render } = toRenderProject(document);
  const layer = render.layers[0] as { modulations: readonly EngineBinding[] };
  return compileModulation({
    bindings: layer.modulations,
    analysis: { sources: new Map() } as never,
    durationSeconds: 10,
    seed: 1,
    placement: render.audio,
    ...(render.midiNotes === undefined ? {} : { midiNotes: render.midiNotes }),
  });
};

const level = (document: ProjectDocument, t: number) => bindingLevels(compileFor(document), t).get('bind');

describe('the midi source', () => {
  it('pulses at a note, as hard as it was played, and falls to nothing', () => {
    const document = project(midiBinding());
    expect(level(document, 0.5)).toBe(0);
    expect(level(document, 1)).toBeCloseTo(1, 5);
    expect(level(document, 1 + MIDI_PULSE_SECONDS / 2)).toBeCloseTo(0.5, 5);
    expect(level(document, 1 + MIDI_PULSE_SECONDS)).toBe(0);
    expect(level(document, 2)).toBeCloseTo(64 / 127, 5);
  });

  it('takes the strongest of overlapping notes, so a chord is one hit', () => {
    const notes = [{ ticks: 0, note: 60, velocity: 127, channel: 0 }, { ticks: 4_800, note: 64, velocity: 30, channel: 0 }];
    const ticks = notes.map((n) => n.ticks);
    expect(midiPulse(notes, ticks, 0.1)).toBeCloseTo(1 - 0.1 / MIDI_PULSE_SECONDS, 6);
    expect(midiPulse(notes, ticks, 0)).toBe(1);
  });

  it('filters by note, by range and by channel', () => {
    const notes = clip.notes;
    const of = (noteLow: number, noteHigh: number, channel: number | null) => midiNotesFor(notes, { type: 'midi', stem: 'mix', noteLow, noteHigh, channel }).map((n) => n.note);
    expect(of(36, 36, null)).toEqual([36]);
    expect(of(36, 38, null)).toEqual([36, 38]);
    expect(of(0, 127, 0)).toEqual([60]);
    expect(of(0, 127, 9)).toEqual([36, 38]);
    expect(level(project(midiBinding({ noteLow: 38, noteHigh: 38 })), 1)).toBe(0);
    expect(level(project(midiBinding({ channel: 9 })), 3)).toBe(0);
  });

  it('moves with the song: through a lead-in and a trim, and silent outside the clip', () => {
    const base = project(midiBinding());
    const placed = { ...base, audio: { ...base.audio, leadInTicks: 24_000, clipInTicks: 48_000, clipOutTicks: 120_000 } };
    // The note at 1 s of the file is the first thing in the clip, half a second into the timeline.
    expect(level(placed, 0.25)).toBe(0);
    expect(level(placed, 0.5)).toBeCloseTo(1, 5);
    // The note at 3 s is past the clip's end.
    expect(level(placed, 2.5)).toBe(0);
  });

  it('keeps two filters apart when both go through the envelope pass', () => {
    const kick = { ...midiBinding({ noteLow: 36, noteHigh: 36 }), id: 'kick', envelope: { attackMs: 1, releaseMs: 100, mode: 'peak' as const, extra: {} } };
    const snare = { ...kick, id: 'snare', source: { ...kick.source, noteLow: 38, noteHigh: 38 } };
    const layer: ModuleLayer = { ...createModuleLayer('core.bars', { id: 'layer' }), modulations: [kick, snare] };
    const levels = bindingLevels(compileFor({ ...project(kick), layers: [layer] }), 1.001);
    expect(levels.get('kick')).toBeGreaterThan(0.5);
    expect(levels.get('snare')).toBe(0);
  });

  it('survives the envelope pass: no note is lost between its 240 Hz samples', () => {
    const notes = Array.from({ length: 200 }, (_, i) => ({ ticks: 4_801 + i * 4_801, endTicks: 0, note: 60, velocity: 127, channel: 0 }));
    const binding = { ...midiBinding(), envelope: { attackMs: 1, releaseMs: 50, mode: 'peak' as const, extra: {} } };
    const program = compileFor(project(binding, { name: 'm', notes, extra: {} }));
    for (const note of notes) expect(bindingLevels(program, note.ticks / 48_000 + 0.01).get('bind')).toBeGreaterThan(0.5);
  });

  it('calibrates to nothing: it is 0..1 by definition', () => {
    const document = project(midiBinding());
    expect(document.layers[0]?.modulations[0]?.inputRange).toBe('auto');
    expect(level(document, 2)).toBeCloseTo(64 / 127, 5);
  });

  it('says why a binding is inactive, and keeps it', () => {
    expect(compileFor(project(midiBinding(), null)).issues).toEqual([expect.objectContaining({ bindingId: 'bind', problem: 'unsupported', detail: expect.stringContaining('has none yet') })]);
    expect(compileFor(project(midiBinding({ noteLow: 100, noteHigh: 101 }))).issues).toEqual([expect.objectContaining({ detail: expect.stringContaining('no notes in the MIDI file match') })]);
  });

  it('is deterministic: the same document gives the same numbers', () => {
    const document = project(midiBinding());
    const a = compileFor(document);
    const b = compileFor(document);
    for (let t = 0; t < 4; t += 1 / 60) expect(bindingLevels(a, t).get('bind')).toBe(bindingLevels(b, t).get('bind'));
  });
});

/** The fixtures' short ids are reported as malformed, which is beside the point here. */
const notAboutIds = (issue: { path: string }) => !/(^|\.)id$/.test(issue.path);

describe('in the document', () => {
  it('round-trips the file and a binding\'s filter', () => {
    const document = project(midiBinding({ noteLow: 36, noteHigh: 38, channel: 9 }));
    const { document: read, issues } = loadDocument(stringifyDocument(document));
    expect(issues.filter(notAboutIds)).toEqual([]);
    expect(read.midi).toEqual(clip);
    expect(read.layers[0]?.modulations[0]?.source).toMatchObject({ type: 'midi', noteLow: 36, noteHigh: 38, channel: 9 });
    expect(read.layers[0]?.modulations[0]?.lookAheadMs).toBe(0);
  });

  it('adds nothing to a project without it: no field in the file, none in the snapshot', () => {
    const plain = { ...project(createBinding(TARGET, { id: 'bind', sourceType: 'rms' }), null) };
    const text = stringifyDocument(plain);
    expect(text).not.toContain('midi');
    expect(text).not.toContain('noteLow');
    expect(text).not.toContain('"channel"');
    const render = toRenderProject(plain).project;
    expect('midiNotes' in render).toBe(false);
    const source = (render.layers[0] as { modulations: readonly EngineBinding[] }).modulations[0]?.source;
    expect(Object.keys(source ?? {})).not.toContain('noteLow');
  });

  it('reads a project saved before MIDI existed', () => {
    const { document } = loadDocument(JSON.stringify({ schemaVersion: 1, id: 'p', name: 'old' }));
    expect(document.midi).toBeNull();
  });

  it('repairs bad notes and reports them', () => {
    const document = project(midiBinding());
    const raw = JSON.parse(stringifyDocument(document)) as { midi: { notes: { note: number }[] } };
    (raw.midi.notes[0] as { note: number }).note = 200;
    const { document: read, issues } = loadDocument(JSON.stringify(raw));
    expect(read.midi?.notes[0]?.note).toBe(127);
    expect(issues.filter(notAboutIds).map((i) => i.path)).toEqual(['midi.notes[0].note']);
  });

  it('whitelists the filter into the engine binding', () => {
    const render = toRenderProject(project(midiBinding({ noteLow: 1, noteHigh: 2, channel: 3 }))).project;
    expect((render.layers[0] as { modulations: readonly EngineBinding[] }).modulations[0]?.source).toMatchObject({ noteLow: 1, noteHigh: 2, channel: 3 });
    expect(render.midiNotes).toEqual(clip.notes.map(({ ticks, note, velocity, channel }) => ({ ticks, note, velocity, channel })));
  });

  it('imports and removes as undoable steps, keeping the bindings', () => {
    const history = new History(project(midiBinding(), null));
    history.run(setMidi(clip));
    expect(history.current.midi).toBe(clip);
    history.undo();
    expect(history.current.midi).toBeNull();
    history.redo();
    history.run(setMidi(null));
    expect(history.current.midi).toBeNull();
    expect(history.current.layers[0]?.modulations).toHaveLength(1);
  });
});

describe('in the studio', () => {
  const glow: ParamSpec = { key: 'glow', label: 'Glow', group: 'Look', type: 'float', default: 0, min: 0, max: 1 };

  it('is offered, and a new binding has no look-ahead: MIDI is exact, not detected', () => {
    expect(SOURCE_CHOICES.some((c) => c.type === 'midi')).toBe(true);
    const made = defaultBinding(TARGET, glow, { newId: () => 'id', sourceType: 'midi' });
    expect(made.lookAheadMs).toBe(0);
    expect(createBinding(TARGET, { sourceType: 'rms' }).lookAheadMs).not.toBe(0);
  });

  it('adds through a command like any other binding', () => {
    const base = project(midiBinding());
    const after = addModulation('layer', defaultBinding(TARGET, glow, { newId: () => 'second', sourceType: 'midi' })).apply(base);
    expect(after.layers[0]?.modulations).toHaveLength(2);
  });

  it('says what a binding listens to', () => {
    expect(describeMidiFilter({ noteLow: 0, noteHigh: 127, channel: null })).toBe('All notes');
    expect(describeMidiFilter({ noteLow: 36, noteHigh: 36, channel: 9 })).toBe('C2, channel 10');
    expect(describeMidiFilter({ noteLow: 36, noteHigh: 47, channel: null })).toBe('C2 to B2');
    expect(describeSource(midiBinding({ noteLow: 36, noteHigh: 36 }))).toBe('MIDI · C2');
  });

  it('counts each channel\'s notes for the picker', () => {
    expect([...midiChannelCounts(clip)]).toEqual([[9, 2], [0, 1]]);
  });
});
