// Combine audio files (C13): a project has one audio file, so several become one. The list is in
// the audio panel rather than a dialog's selection because a file dialog does not keep an order, and
// the order is the whole point.

import { useState } from 'react';

import { adoptAudio } from '../audio-import.ts';
import { useStudio } from '../store.ts';

const nameOf = (path: string) => path.split(/[/\\]/).pop() ?? path;

export function CombineAudio(): React.JSX.Element {
  const notify = useStudio((s) => s.notify);
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);

  function swap(a: number, b: number): void {
    const next = [...files];
    next[a] = files[b] as string;
    next[b] = files[a] as string;
    setFiles(next);
  }

  async function add(): Promise<void> {
    const picked = await window.pulseforge.pickAudioFiles();
    setFiles([...files, ...picked.filter((path) => !files.includes(path))]);
  }

  async function combine(): Promise<void> {
    setBusy(true);
    try {
      const combined = await window.pulseforge.combineAudio(files);
      if (!await adoptAudio(combined.path)) return;
      notify({ text: `Combined ${combined.parts.length} files, in this order: ${combined.parts.join(', ')}`, kind: 'ok' });
      setFiles([]);
      setOpen(false);
    } catch (error) {
      notify({ text: `Combining the audio failed. ${error instanceof Error ? error.message : String(error)}`, kind: 'bad' });
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return <button type="button" className="wide" data-action="combine-audio-open" title="Several files, one after the other, as this project's audio" onClick={() => setOpen(true)}>Combine audio files…</button>;
  }
  return (
    <div className="combine-audio" data-testid="combine-audio">
      <p className="dim note">One after the other, top first, at 48 kHz stereo, as a new file in the library. It replaces this project's audio; the originals are not touched.</p>
      {files.length === 0 ? <p className="empty">No files yet.</p> : (
        <ol className="combine-list">
          {files.map((path, index) => (
            <li key={path}>
              <span className="combine-name" title={path}>{index + 1}. {nameOf(path)}</span>
              <button type="button" data-action="combine-audio-up" title="Earlier" disabled={index === 0} onClick={() => swap(index, index - 1)}>↑</button>
              <button type="button" data-action="combine-audio-down" title="Later" disabled={index === files.length - 1} onClick={() => swap(index, index + 1)}>↓</button>
              <button type="button" data-action="combine-audio-remove" title="Take it off the list" onClick={() => setFiles(files.filter((other) => other !== path))}>✕</button>
            </li>
          ))}
        </ol>
      )}
      <div className="layer-actions">
        <button type="button" data-action="combine-audio-add" disabled={busy} onClick={() => void add()}>Add files…</button>
        <button type="button" data-action="combine-audio-run" disabled={busy || files.length < 2} title={files.length < 2 ? 'Choose at least two files' : ''} onClick={() => void combine()}>{busy ? 'Combining…' : 'Combine'}</button>
        <button type="button" data-action="combine-audio-cancel" disabled={busy} onClick={() => { setFiles([]); setOpen(false); }}>Cancel</button>
      </div>
    </div>
  );
}
