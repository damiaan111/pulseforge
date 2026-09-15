// Transport (ui-spec §1, §9): play/pause, timecode, and the honest preview-fps readout.

import { useEffect } from 'react';

import { ticksToSeconds } from '../../engine/core/time.ts';
import { timelineDurationTicks } from '../../project/snapshot.ts';
import { useStudio } from '../store.ts';
import { previewControls } from './CanvasPane.tsx';

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
        && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (typing || event.ctrlKey || event.metaKey) return;
      if (event.key === ' ' || event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (previewControls.transport() === 'playing') previewControls.pause();
        else previewControls.play();
      } else if (event.key === 'Home') {
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
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  return `${String(minutes).padStart(2, '0')}:${rest.toFixed(2).padStart(5, '0')}`;
}
