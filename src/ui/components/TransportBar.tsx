// Transport (ui-spec §1, §9): play/pause, timecode, and the honest preview-fps readout.

import { actionForKey, keyName } from '../shortcuts.ts';
import { useEffect } from 'react';

import { ticksToSeconds } from '../../engine/core/time.ts';
import { timelineDurationTicks } from '../../project/snapshot.ts';
import { useStudio } from '../store.ts';
import { previewControls } from './CanvasPane.tsx';
import { jumpToStop } from '../marker-nav.ts';

export function TransportBar(): React.JSX.Element {
  const document = useStudio((s) => s.document);
  const transport = useStudio((s) => s.transport);
  const timelineSeconds = useStudio((s) => s.timelineSeconds);
  const stats = useStudio((s) => s.stats);
  const total = ticksToSeconds(timelineDurationTicks(document));

  // Space plays and pauses, as it does everywhere else (ui-spec §9).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target !== null
        && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
      if (typing || event.ctrlKey || event.metaKey || event.altKey) return;
      const action = actionForKey(keyName(event), useStudio.getState().settings?.shortcuts ?? {});
      if (action === 'play') {
        event.preventDefault();
        // Space on a focused button would also *press* it on key-up — after clicking "Bars",
        // Space played the preview and added another bars layer. Dropping focus prevents that.
        if (target?.tagName === 'BUTTON') target.blur();
        if (previewControls.transport() === 'playing') previewControls.pause();
        else previewControls.play();
      } else if (action === 'start') {
        event.preventDefault();
        previewControls.seek(0);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="transport">
      <button type="button" onClick={() => previewControls.seek(0)} title="Back to start (Home)">⏮</button>
      <button
        type="button"
        className="primary"
        onClick={() => (transport === 'playing' ? previewControls.pause() : previewControls.play())}
        title="Play / pause (Space)"
      >
        {transport === 'playing' ? '⏸' : '▶'}
      </button>
      <button type="button" onClick={() => previewControls.stop()} title="Stop">⏹</button>
      <button type="button" data-action="marker-prev" onClick={() => jumpToStop(-1)} title="Previous marker or section ([)">◂◆</button>
      <button type="button" data-action="marker-next" onClick={() => jumpToStop(1)} title="Next marker or section (])">◆▸</button>

      <span className="timecode">{formatTime(timelineSeconds)} / {formatTime(total)}</span>

      <span className="spacer" />
      {stats !== null && transport === "playing" && (
        <span className={stats.droppedRecent > 0 ? 'badge warn' : 'badge dim'}>
          {stats.renderedFps.toFixed(0)} fps preview
          {stats.droppedRecent > 0 ? ` · ${stats.droppedRecent} dropped` : ''}
        </span>
      )}
    </div>
  );
}

export function formatTime(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  // Integer hundredths first. Splitting minutes before rounding printed 59.996 s as "00:60.00".
  const hundredths = Math.round(safe * 100);
  const minutes = Math.floor(hundredths / 6000);
  const rest = (hundredths - minutes * 6000) / 100;
  return `${String(minutes).padStart(2, '0')}:${rest.toFixed(2).padStart(5, '0')}`;
}
