// MIDI as a modulation source (C3): the imported file, and what a binding listens to in it.

import { midiNotesFor } from '../../engine/core/modulation.ts';
import { noteName, parseMidi } from '../../midi/parse.ts';
import { setMidi } from '../../project/commands.ts';
import type { MidiClip, SourceSpec } from '../../project/document.ts';
import { midiChannelCounts } from '../../project/modulation-authoring.ts';
import { useStudio } from '../store.ts';

const NOTES = Array.from({ length: 128 }, (_, note) => note);
const CHANNELS = Array.from({ length: 16 }, (_, channel) => channel);

/** The file: import, replace, remove. Stored in the project, so nothing here points at a path. */
export function MidiFileControls(): React.JSX.Element {
  const midi = useStudio((s) => s.document.midi);
  const run = useStudio((s) => s.run);
  const notify = useStudio((s) => s.notify);

  async function importFile(): Promise<void> {
    try {
      const picked = await window.pulseforge.pickMidi();
      if (picked === null) return;
      const parsed = parseMidi(picked.bytes);
      if (parsed.notes.length === 0) {
        notify({ text: `${picked.name} has no notes in it.`, kind: 'warn' });
        return;
      }
      const clip: MidiClip = { name: picked.name, notes: parsed.notes, extra: {} };
      run(setMidi(clip));
      const said = `${picked.name}: ${parsed.notes.length} notes, ${parsed.tempoChanges} tempo ${parsed.tempoChanges === 1 ? 'change' : 'changes'}.`;
      notify({ text: [said, ...parsed.warnings].join(' '), kind: parsed.warnings.length === 0 ? 'ok' : 'warn' });
    } catch (error) {
      notify({ text: `Importing the MIDI file failed. ${error instanceof Error ? error.message : String(error)}`, kind: 'bad' });
    }
  }

  return (
    <div className="midi-file" data-testid="midi-file">
      <button type="button" className="wide" data-action="midi-import" title="A MIDI file to drive parameters with, timed from the start of the audio file" onClick={() => void importFile()}>
        {midi === null ? 'Import MIDI file…' : 'Replace MIDI file…'}
      </button>
      {midi !== null && (
        <div className="midi-summary">
          <span className="dim" title={midi.name}>{midi.name} · {midi.notes.length} notes</span>
          <button type="button" data-action="midi-remove" title="Bindings on it are kept, and do nothing until there is a file again" onClick={() => run(setMidi(null))}>Remove</button>
        </div>
      )}
    </div>
  );
}

type NoteMode = 'all' | 'note' | 'range';

function modeOf(source: SourceSpec): NoteMode {
  if (source.noteLow === 0 && source.noteHigh === 127) return 'all';
  return source.noteLow === source.noteHigh ? 'note' : 'range';
}

function NotePicker(props: { label: string; value: number; action: string; onChange: (note: number) => void }): React.JSX.Element {
  return (
    <label className="field">
      <span>{props.label}</span>
      <select value={props.value} data-action={props.action} onChange={(e) => props.onChange(Number(e.target.value))}>
        {NOTES.map((note) => <option key={note} value={note}>{noteName(note)} ({note})</option>)}
      </select>
    </label>
  );
}

/** A binding's filter: all notes, one note or a range, on every channel or one. */
export function MidiSourceFields(props: { source: SourceSpec; setSource: (value: Partial<SourceSpec>) => void }): React.JSX.Element {
  const { source, setSource } = props;
  const midi = useStudio((s) => s.document.midi);
  const mode = modeOf(source);
  const counts = midi === null ? new Map<number, number>() : midiChannelCounts(midi);
  const matching = midi === null ? 0 : midiNotesFor(midi.notes, source).length;

  function setMode(next: NoteMode): void {
    if (next === 'all') setSource({ noteLow: 0, noteHigh: 127 });
    // Middle C unless a note is already chosen: a filter that says nothing is not a choice.
    else if (next === 'note') setSource({ noteHigh: mode === 'all' ? 60 : source.noteLow, noteLow: mode === 'all' ? 60 : source.noteLow });
    else setSource(mode === 'all' ? { noteLow: 36, noteHigh: 72 } : { noteHigh: Math.min(127, source.noteLow + 12) });
  }

  return (
    <>
      {midi === null && <MidiFileControls />}
      <label className="field">
        <span>Notes</span>
        <select value={mode} data-action="midi-note-mode" onChange={(e) => setMode(e.target.value as NoteMode)}>
          <option value="all">All notes</option>
          <option value="note">One note</option>
          <option value="range">A range</option>
        </select>
      </label>
      {mode === 'note' && <NotePicker label="Note" value={source.noteLow} action="midi-note" onChange={(note) => setSource({ noteLow: note, noteHigh: note })} />}
      {mode === 'range' && (
        <>
          <NotePicker label="From" value={source.noteLow} action="midi-note-low" onChange={(note) => setSource({ noteLow: note, noteHigh: Math.max(note, source.noteHigh) })} />
          <NotePicker label="To" value={source.noteHigh} action="midi-note-high" onChange={(note) => setSource({ noteHigh: note, noteLow: Math.min(note, source.noteLow) })} />
        </>
      )}
      <label className="field">
        <span>Channel</span>
        <select value={source.channel ?? ''} data-action="midi-channel" onChange={(e) => setSource({ channel: e.target.value === '' ? null : Number(e.target.value) })}>
          <option value="">All channels</option>
          {CHANNELS.map((channel) => <option key={channel} value={channel}>Channel {channel + 1}{counts.has(channel) ? ` (${counts.get(channel) ?? 0} notes)` : ''}</option>)}
        </select>
      </label>
      {midi !== null && <p className="dim binding-hint" data-testid="midi-match">{matching} of {midi.notes.length} notes match.</p>}
    </>
  );
}
