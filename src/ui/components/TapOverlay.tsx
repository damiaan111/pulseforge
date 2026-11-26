// Tap-to-sync, while it runs (lyrics-spec §3; M19): over the canvas, the line just tapped, the one
// to tap next large, and the one after — so the eye is on the words and the ears on the song.
//
// Keys: T taps (hold it through a line to mark the end too), Backspace undoes one tap, Esc stops.
// The big button does the same with the mouse. Every tap is one undo step in the project history as
// well, so Ctrl+Z after the session still works line by line.
//
// Where a tap lands: the playhead when the handler runs (unsnapped, from the audio element), minus
// the key event's age and the calibrated latency, scaled by the playback speed; then, if enabled,
// moved to the nearest vocal onset within 0.1 s or the nearest beat within 0.08 s (tap.ts).

import { useEffect, useMemo, useRef } from 'react';

import { lyricTokens } from '../../engine/core/lyrics.ts';
import { sourceToTimelineSeconds, TICKS_PER_SECOND } from '../../engine/core/time.ts';
import { nearestWithin, nextTapLine, onsetPeaks, tapDown, tapFinished, tapPosition, tapUp, untap, type TapResult } from '../../lyrics/tap.ts';
import { setLineTimings } from '../../project/lyrics-commands.ts';
import { history, useStudio } from '../store.ts';
import { previewControls } from './CanvasPane.tsx';

const ONSET_WINDOW = 0.1;
const BEAT_WINDOW = 0.08;

export function TapOverlay(): React.JSX.Element | null {
  const tap = useStudio((s) => s.tap);
  const setTap = useStudio((s) => s.setTap);
  const run = useStudio((s) => s.run);
  const notify = useStudio((s) => s.notify);
  const lyrics = useStudio((s) => s.document.lyrics);
  const audio = useStudio((s) => s.document.audio);
  const analysis = useStudio((s) => s.analysis);
  const settings = useStudio((s) => s.settings);
  const held = useRef(false);

  const placement = useMemo(() => ({ leadInTicks: audio.leadInTicks, clipInTicks: audio.clipInTicks }), [audio.leadInTicks, audio.clipInTicks]);
  const onsetTrack = analysis?.sources.get('vocals')?.features.get('onset');
  const onsets = useMemo(() => (onsetTrack === undefined ? [] : onsetPeaks(onsetTrack).map((s) => sourceToTimelineSeconds(s, placement))), [onsetTrack, placement]);
  const beats = useMemo(() => (analysis?.beatGrid?.beats ?? []).map((s) => sourceToTimelineSeconds(s, placement)), [analysis, placement]);

  useEffect(() => {
    if (tap === null) return;
    const latency = settings?.tapLatencyMs ?? 0;

    /** Where the key press meant, in ticks: corrected, then snapped. */
    const landing = (eventTimeStamp: number): number => {
      let t = tapPosition(previewControls.positionNow(), performance.now() - eventTimeStamp, latency, tap.rate);
      if (tap.snapOnsets) t = nearestWithin(t, onsets, ONSET_WINDOW) ?? t;
      else if (tap.snapBeats) t = nearestWithin(t, beats, BEAT_WINDOW) ?? t;
      return Math.round(Math.max(0, t) * TICKS_PER_SECOND);
    };
    const apply = (result: TapResult, label: string, counted: number) => {
      if (result.changes.length > 0) run(setLineTimings(result.changes, label));
      const current = useStudio.getState().tap;
      if (current === null) return;
      setTap({ ...current, session: result.session, taps: current.taps + counted });
      if (counted > 0 && tapFinished(history.current.lyrics, result.session)) {
        notify({ text: `Tapped every line in this pass. Backspace still undoes the last tap; Esc closes.`, kind: 'ok' });
      }
    };
    const stop = () => {
      previewControls.setRate(1);
      setTap(null);
    };

    const onDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (key === 'escape') {
        event.preventDefault();
        event.stopPropagation();
        stop();
        return;
      }
      if (key === 'backspace') {
        event.preventDefault();
        event.stopPropagation();
        apply(untap(useStudio.getState().tap?.session ?? tap.session), 'Undo tap', -1);
        return;
      }
      if (key !== 't' || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
      event.preventDefault();
      event.stopPropagation();
      held.current = true;
      const session = useStudio.getState().tap?.session ?? tap.session;
      apply(tapDown(history.current.lyrics, session, landing(event.timeStamp)), 'Tap', 1);
    };
    const onUp = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 't' || !held.current) return;
      held.current = false;
      const session = useStudio.getState().tap?.session ?? tap.session;
      apply(tapUp(history.current.lyrics, session, landing(event.timeStamp)), 'Tap', 0);
    };
    // Capture phase: while tapping, these keys belong to the session, not to whatever has focus.
    window.addEventListener('keydown', onDown, true);
    window.addEventListener('keyup', onUp, true);
    return () => {
      window.removeEventListener('keydown', onDown, true);
      window.removeEventListener('keyup', onUp, true);
    };
  }, [tap, settings, onsets, beats, run, setTap, notify]);

  if (tap === null) return null;
  const { session } = tap;
  const next = nextTapLine(lyrics, session);
  const finished = tapFinished(lyrics, session);
  const lines = lyrics.lines;
  const nextIndex = next === undefined ? -1 : lines.findIndex((l) => l.id === next.id);
  const previous = session.mode === 'words' ? undefined : lines.slice(0, Math.max(0, nextIndex === -1 ? lines.length : nextIndex)).reverse().find((l) => session.lineIds.includes(l.id));
  const after = session.mode === 'words' || nextIndex < 0 ? undefined : lines.slice(nextIndex + 1).find((l) => session.lineIds.includes(l.id));
  const mouseDown = (event: React.MouseEvent) => {
    event.preventDefault();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 't' }));
  };
  const mouseUp = () => window.dispatchEvent(new KeyboardEvent('keyup', { key: 't' }));

  return (
    <div className="tap-overlay" data-testid="tap-overlay" data-mode={session.mode}>
      <div className="tap-head">
        <strong>Tapping {session.mode === 'starts' ? 'line starts' : session.mode === 'ends' ? 'line ends' : 'words'}</strong>
        <span className="dim">
          {tap.rate !== 1 ? `${tap.rate}× · ` : ''}
          {tap.snapOnsets ? 'snapping to vocal onsets · ' : tap.snapBeats ? 'snapping to beats · ' : ''}
          {settings?.tapLatencyMs == null ? 'latency not calibrated' : `latency ${settings.tapLatencyMs} ms`}
        </span>
        <span className="spacer" />
        <span className="dim" data-testid="tap-count">{tap.taps} tap{tap.taps === 1 ? '' : 's'}</span>
        <button type="button" onClick={() => {
          previewControls.setRate(1);
          setTap(null);
        }}>Done (Esc)</button>
      </div>
      {session.mode === 'words' && next !== undefined ? (
        <WordsView text={next.text} index={session.wordIndex} />
      ) : (
        <div className="tap-lines">
          <div className="tap-previous">{previous?.text ?? ''}</div>
          <div className="tap-current">{finished ? 'All lines tapped' : next?.text ?? ''}</div>
          <div className="tap-next">{after?.text ?? ''}</div>
        </div>
      )}
      <button type="button" className="tap-button" onMouseDown={mouseDown} onMouseUp={mouseUp} onMouseLeave={() => held.current && mouseUp()}>
        Tap <kbd>T</kbd>
      </button>
      <p className="dim tap-help">Hold <kbd>T</kbd> through a line to mark its end · <kbd>Backspace</kbd> undo tap · <kbd>Space</kbd> play/pause · <kbd>Esc</kbd> done</p>
    </div>
  );
}

function WordsView(props: { text: string; index: number }): React.JSX.Element {
  // The same words the taps count: punctuation standing alone belongs to the word before it.
  const words = lyricTokens(props.text).map((token) => token.text);
  return (
    <div className="tap-lines tap-words">
      {words.map((word, i) => (
        <span key={i} className={i < props.index ? 'done' : i === props.index ? 'next' : ''}>{word} </span>
      ))}
      {props.index >= words.length && <span className="next">⏹ tap where the line ends</span>}
    </div>
  );
}
