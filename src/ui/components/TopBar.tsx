// The top bar (ui-spec §1): project actions, undo/redo with labels, and the dirty marker.

import { useStudio } from '../store.ts';

export function TopBar(): React.JSX.Element {
  const name = useStudio((s) => s.document.name);
  const dirty = useStudio((s) => s.dirty);
  const path = useStudio((s) => s.path);
  const canUndo = useStudio((s) => s.canUndo);
  const canRedo = useStudio((s) => s.canRedo);
  const undoLabel = useStudio((s) => s.undoLabel);
  const redoLabel = useStudio((s) => s.redoLabel);
  const newProject = useStudio((s) => s.newProject);
  const openProject = useStudio((s) => s.openProject);
  const save = useStudio((s) => s.save);
  const saveAs = useStudio((s) => s.saveAs);
  const undo = useStudio((s) => s.undo);
  const redo = useStudio((s) => s.redo);

  return (
    <header className="topbar">
      <span className="wordmark">Pulseforge</span>
      <button type="button" onClick={newProject}>New</button>
      <button type="button" onClick={() => void openProject()}>Open…</button>
      <button type="button" onClick={() => void save()}>Save</button>
      <button type="button" onClick={() => void saveAs()}>Save as…</button>

      {/* Labelled, so it says what it will reverse rather than just "Undo" (ui-spec §10). */}
      <button type="button" data-action="undo" disabled={!canUndo} onClick={undo} title={undoLabel ?? ''}>
        ↶ {undoLabel ?? 'Undo'}
      </button>
      <button type="button" data-action="redo" disabled={!canRedo} onClick={redo} title={redoLabel ?? ''}>
        ↷ {redoLabel ?? 'Redo'}
      </button>

      <span className="spacer" />
      <span className="project-name" title={path ?? 'not saved yet'}>
        {name}{dirty ? ' •' : ''}
      </span>
    </header>
  );
}
