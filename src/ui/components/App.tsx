// The studio layout (ui-spec §1): top bar, left rail, centre canvas, right inspector, bottom
// timeline. Dense and dark, with the canvas the only saturated thing on screen (§12).

import { useEffect, useState } from 'react';

import { ComponentChooser } from './ComponentChooser.tsx';

import { useStudio } from '../store.ts';
import { dialogOpen } from '../shortcuts.ts';
import { CanvasPane } from './CanvasPane.tsx';
import { BatchDialog } from './BatchDialog.tsx';
import { ShadertoyDialog } from './ShadertoyDialog.tsx';
import { ExportDialog } from './ExportDialog.tsx';
import { isBatchAudio } from '../../batch/plan.ts';
import { SavePresetDialog } from './SavePresetDialog.tsx';
import { RenderQueue } from './RenderQueue.tsx';
import { ModulationMatrix } from './Modulation.tsx';
import { NodeView } from './NodeView.tsx';
import { Inspector } from './Inspector.tsx';
import { RecoveryDialog } from './RecoveryDialog.tsx';
import { LyricsDrawer } from './LyricsPanel.tsx';
import { AutoDrawer } from './AutoPanel.tsx';
import { SettingsDialog } from './SettingsDialog.tsx';
import { LeftRail } from './LeftRail.tsx';
import { Timeline } from './Timeline.tsx';
import { TopBar } from './TopBar.tsx';
import { TransportBar } from './TransportBar.tsx';

/** A scheduled shutdown stays on screen, with its cancel, until cancelled or the machine goes down. */
function ShutdownBanner(): React.JSX.Element | null {
  const pending = useStudio((s) => s.shutdownPending);
  const cancel = useStudio((s) => s.cancelShutdown);
  if (pending === null) return null;
  return (
    <div className="shutdown-banner" role="alert" data-testid="shutdown-banner">
      Everything is finished. The computer shuts down in {Math.round(pending / 60)} minutes.
      <button type="button" data-action="shutdown-cancel" onClick={() => void cancel()}>Cancel shutdown</button>
    </div>
  );
}

export function App(): React.JSX.Element {
  const toast = useStudio((s) => s.toast);
  const notify = useStudio((s) => s.notify);
  const undo = useStudio((s) => s.undo);
  const redo = useStudio((s) => s.redo);
  const save = useStudio((s) => s.save);
  const setExportOpen = useStudio((s) => s.setExportOpen);
  const setRenders = useStudio((s) => s.setRenders);
  const loadDefaultFont = useStudio((s) => s.loadDefaultFont);

  // The queue lives in the main process; the list is fetched once and then pushed on every change.
  useEffect(() => {
    let alive = true;
    void window.pulseforge.listRenders().then((jobs) => {
      if (alive) setRenders(jobs);
    });
    const off = window.pulseforge.onRendersChanged((jobs) => setRenders(jobs));
    return () => {
      alive = false;
      off();
    };
  }, [setRenders]);

  // Batch mode (S13): the running batch is pushed from main; "all finished" too (export-spec §12).
  const setBatch = useStudio((s) => s.setBatch);
  const queueFinished = useStudio((s) => s.queueFinished);
  useEffect(() => {
    let alive = true;
    void window.pulseforge.batchStatus().then((status) => {
      if (alive) setBatch(status);
    });
    const offBatch = window.pulseforge.onBatchChanged(setBatch);
    const offFinished = window.pulseforge.onQueueFinished(queueFinished);
    return () => {
      alive = false;
      offBatch();
      offFinished();
    };
  }, [setBatch, queueFinished]);

  // Audio files dropped anywhere on the window go to the batch dialog ("drop 10 tracks in", S13).
  // Other drops (a layer row being dragged) are left to the element they land on.
  const openBatch = useStudio((s) => s.openBatch);
  useEffect(() => {
    const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') === true;
    const over = (event: DragEvent) => {
      if (hasFiles(event)) event.preventDefault();
    };
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      const files = [...(event.dataTransfer?.files ?? [])];
      const paths = files.map((file) => window.pulseforge.pathForFile(file)).filter((path) => path !== '' && isBatchAudio(path));
      if (paths.length > 0) openBatch(paths);
      else if (files.length > 0) notify({ text: 'Drop audio files (WAV, MP3, FLAC, …) to render them as a batch.', kind: 'warn' });
    };
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, [openBatch, notify]);

  // Stem separation progress, pushed from the main process while Demucs runs (M5).
  const reportStemsProgress = useStudio((s) => s.reportStemsProgress);
  useEffect(() => window.pulseforge.onStemsProgress(reportStemsProgress), [reportStemsProgress]);

  // Video extraction progress, pushed from the main process while a clip's proxy is built (M39).
  const reportVideoProgress = useStudio((s) => s.reportVideoProgress);
  useEffect(() => window.pulseforge.onVideoProgress(reportVideoProgress), [reportVideoProgress]);

  // Drop-in modules (M35): listed at start and again whenever the folder changes on disk.
  const loadModules = useStudio((s) => s.loadModules);
  useEffect(() => {
    void loadModules();
    return window.pulseforge.onModulesChanged(() => void loadModules());
  }, [loadModules]);

  // The cache ceiling evicted something, or the disk is low (M33): said, never silent.
  useEffect(() => window.pulseforge.onCacheNotice((text) => notify({ text, kind: 'warn' })), [notify]);

  // The auto-director's templates (M21): read once; the Auto drawer can reload them.
  const loadTemplates = useStudio((s) => s.loadTemplates);
  useEffect(() => {
    void loadTemplates();
  }, [loadTemplates]);

  // Autosave (M1): every N minutes (a setting, M36; one by default), and only when there is unsaved
  // work to keep. Crashed runs' autosaves are offered once, at start.
  const autosave = useStudio((s) => s.autosave);
  const loadRecovery = useStudio((s) => s.loadRecovery);
  const autosaveMinutes = useStudio((s) => s.settings?.autosaveMinutes ?? 1);
  useEffect(() => {
    void loadRecovery();
  }, [loadRecovery]);
  useEffect(() => {
    const every = autosaveMinutes === 1 ? 'every minute' : `every ${autosaveMinutes} minutes`;
    const handle = setInterval(() => void autosave(every), autosaveMinutes * 60_000);
    return () => clearInterval(handle);
  }, [autosave, autosaveMinutes]);

  // User settings (tap latency, D33), once; and whether lyric alignment (M26) is installed.
  const loadSettings = useStudio((s) => s.loadSettings);
  const loadAlignAvailability = useStudio((s) => s.loadAlignAvailability);
  useEffect(() => {
    void loadSettings();
    void loadAlignAvailability();
  }, [loadSettings, loadAlignAvailability]);

  // Alignment progress, pushed from the main process while WhisperX runs.
  const reportAlignProgress = useStudio((s) => s.reportAlignProgress);
  useEffect(() => window.pulseforge.onLyricsAlignProgress(reportAlignProgress), [reportAlignProgress]);

  // The bundled typeface, once: text layers need it before they can draw anything (§8.13).
  useEffect(() => {
    void loadDefaultFont();
  }, [loadDefaultFont]);

  // ui-spec §9. The full remappable map comes later; these are the ones whose absence is felt
  // immediately. Typing in a field must not trigger them.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Esc closes the topmost overlay, as every dialog elsewhere does — before the typing check,
      // so it works with focus in the dialog's own controls.
      if (event.key === 'Escape') {
        const state = useStudio.getState();
        if (state.settingsOpen) state.setSettingsOpen(false);
        else if (state.presetDialog !== null) state.setPresetDialog(null);
        else if (state.exportOpen) state.setExportOpen(false);
        else if (state.batchOpen) state.setBatchOpen(false);
        else if (state.shadertoyOpen) state.setShadertoyOpen(false);
        else if (state.nodeViewOpen) state.setNodeViewOpen(false);
        else if (state.queueOpen) state.setQueueOpen(false);
        else if (state.matrixOpen) state.setMatrixOpen(false);
        else if (state.lyricsOpen) state.setLyricsOpen(false);
        else if (state.autoOpen) state.setAutoOpen(false);
        else if (state.toast !== null) state.notify(null);
        else if (state.selectedLayerId !== null) state.select(null);
        return;
      }
      const target = event.target as HTMLElement | null;
      const typing = target !== null
        && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (typing || dialogOpen()) return;
      if (!event.ctrlKey && !event.metaKey) return;
      const key = event.key.toLowerCase();
      if (key === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if (key === 's') {
        event.preventDefault();
        void save();
      } else if (key === 'e') {
        event.preventDefault();
        setExportOpen(true);
      } else if (key === ',') {
        event.preventDefault();
        useStudio.getState().setSettingsOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, save, setExportOpen]);

  // Toasts are for background events and should not pile up (ui-spec §11).
  useEffect(() => {
    if (toast === null || toast.kind === 'bad') return;
    const handle = setTimeout(() => notify(null), 4000);
    return () => clearTimeout(handle);
  }, [toast, notify]);

  return (
    <div className="studio">
      <TopBar />
      <div className="middle">
        <LeftRail />
        <CanvasPane />
        <Inspector />
      </div>
      <div className="bottom">
        <TransportBar />
        <Timeline />
      </div>
      <RenderQueue />
      <ModulationMatrix />
      <NodeView />
      <LyricsDrawer />
      <AutoDrawer />
      <ExportDialog />
      <BatchDialog />
      <ShadertoyDialog />
      <SettingsDialog />
      <FirstRun />
      <SavePresetDialog />
      <RecoveryDialog />
      <ShutdownBanner />
      {toast === null ? null : (
        <button type="button" className={`toast ${toast.kind}`} onClick={() => notify(null)}>
          {toast.text}
        </button>
      )}
    </div>
  );
}

/** A fresh download: nothing can play or render until the essentials are in. */
function FirstRun(): React.JSX.Element | null {
  const [needed, setNeeded] = useState(false);
  useEffect(() => {
    void window.pulseforge.componentsInfo().then((info) => setNeeded(info.components.some((c) => c.id === 'core' && !c.installed)));
  }, []);
  if (!needed) return null;
  // Reloaded rather than patched up: everything that read "no FFmpeg, no fonts" at start reads again.
  return <ComponentChooser firstRun onClose={() => setNeeded(false)} onChanged={() => window.location.reload()} />;
}
