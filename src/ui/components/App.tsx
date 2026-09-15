// The studio layout (ui-spec §1): top bar, left rail, centre canvas, right inspector, bottom
// timeline. Dense and dark, with the canvas the only saturated thing on screen (§12).

import { useEffect } from 'react';

import { useStudio } from '../store.ts';
import { CanvasPane } from './CanvasPane.tsx';
import { ExportDialog } from './ExportDialog.tsx';
import { RenderQueue } from './RenderQueue.tsx';
import { Inspector } from './Inspector.tsx';
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

  // ui-spec §9. The full remappable map comes later; these are the ones whose absence is felt
  // immediately. Typing in a field must not trigger them.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
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
      <ExportDialog />
      {toast === null ? null : (
        <button type="button" className={`toast ${toast.kind}`} onClick={() => notify(null)}>
          {toast.text}
        </button>
      )}
    </div>
  );
}
