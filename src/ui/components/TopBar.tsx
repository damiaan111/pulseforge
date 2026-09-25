// The top bar (ui-spec §1): project actions, undo/redo with labels, and the dirty marker.

import { findLayer } from '../../project/commands.ts';
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
  const setExportOpen = useStudio((s) => s.setExportOpen);
  const setPresetDialog = useStudio((s) => s.setPresetDialog);
  const layerSelected = useStudio((s) => s.selectedLayerId !== null && findLayer(s.document, s.selectedLayerId)?.kind === 'module');
  const queueOpen = useStudio((s) => s.queueOpen);
  const setQueueOpen = useStudio((s) => s.setQueueOpen);
  const matrixOpen = useStudio((s) => s.matrixOpen);
  const setMatrixOpen = useStudio((s) => s.setMatrixOpen);
  const autoOpen = useStudio((s) => s.autoOpen);
  const setAutoOpen = useStudio((s) => s.setAutoOpen);
  const lyricsOpen = useStudio((s) => s.lyricsOpen);
  const setLyricsOpen = useStudio((s) => s.setLyricsOpen);
  const activeRenders = useStudio((s) => s.renders.filter((job) => job.status === 'queued' || job.status === 'running').length);

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

      <button type="button" data-action="topbar-save-preset" title="Save the selected layer, or the project, as a preset" onClick={() => setPresetDialog(layerSelected ? 'layer' : 'project')}>
        Save preset…
      </button>

      <span className="spacer" />
      <span className="project-name" title={path ?? 'not saved yet'}>
        {name}{dirty ? ' •' : ''}
      </span>
      <button type="button" data-action="auto-drawer" className={autoOpen ? 'active' : ''} title="The auto-director: a complete project from the track, Surprise me, and why it chose what it chose" onClick={() => setAutoOpen(!autoOpen)}>
        ✦ Auto
      </button>
      <button type="button" data-action="lyrics-drawer" className={lyricsOpen ? 'active' : ''} title="The lyrics: text, timings, checklist, tap to sync" onClick={() => setLyricsOpen(!lyricsOpen)}>
        ♪ Lyrics
      </button>
      <button type="button" data-action="modulation-matrix" className={matrixOpen ? 'active' : ''} title="Every modulation binding in the project" onClick={() => setMatrixOpen(!matrixOpen)}>
        ∿ Modulation
      </button>
      <button type="button" data-action="render-queue" className={queueOpen ? 'active' : ''} onClick={() => setQueueOpen(!queueOpen)}>
        Renders{activeRenders > 0 ? ` (${activeRenders})` : ''}
      </button>
      <button type="button" className="primary" data-action="export" title="Ctrl+E" onClick={() => setExportOpen(true)}>
        ▸ Export
      </button>
    </header>
  );
}
