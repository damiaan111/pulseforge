// The studio layout (ui-spec §1): top bar, left rail, centre canvas, right inspector, bottom
// timeline. Dense and dark, with the canvas the only saturated thing on screen (§12).

import { useEffect } from 'react';

import { useStudio } from '../store.ts';
import { CanvasPane } from './CanvasPane.tsx';
import { ExportDialog } from './ExportDialog.tsx';
import { SavePresetDialog } from './SavePresetDialog.tsx';
import { RenderQueue } from './RenderQueue.tsx';
import { ModulationMatrix } from './Modulation.tsx';
import { Inspector } from './Inspector.tsx';
import { RecoveryDialog } from './RecoveryDialog.tsx';
import { LyricsDrawer } from './LyricsPanel.tsx';
import { AutoDrawer } from './AutoPanel.tsx';
import { SettingsDialog } from './SettingsDialog.tsx';
import { LeftRail } from './LeftRail.tsx';
import { Timeline } from './Timeline.tsx';
import { TopBar } from './TopBar.tsx';
import { TransportBar } from './TransportBar.tsx';

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
        else if (state.queueOpen) state.setQueueOpen(false);
        else if (state.matrixOpen) state.setMatrixOpen(false);
        else if (state.lyricsOpen) state.setLyricsOpen(false);
        else if (state.autoOpen) state.setAutoOpen(false);
        else if (state.toast !== null) state.notify(null);
        return;
      }
      const target = event.target as HTMLElement | null;
      const typing = target !== null
        && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (typing) return;
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
      <LyricsDrawer />
      <AutoDrawer />
      <ExportDialog />
      <SettingsDialog />
      <SavePresetDialog />
      <RecoveryDialog />
      {toast === null ? null : (
        <button type="button" className={`toast ${toast.kind}`} onClick={() => notify(null)}>
          {toast.text}
        </button>
      )}
    </div>
  );
}
