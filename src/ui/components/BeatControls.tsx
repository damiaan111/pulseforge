// Refining the beat grid (S16): the second pass for music that does not sit on a click.
//
// Offered, never automatic: for anything played to a grid the built-in tracker is exact, and the
// refined grid is an edit to the project. It says which grid is in use and undoes like any edit.

import { useEffect, useRef } from 'react';

import { setBeatRefinement } from '../../project/commands.ts';
import { useStudio } from '../store.ts';

/** Below this the built-in tracker is unsure of itself, so the pass is worth suggesting. */
const UNSURE = 0.3;

export function BeatControls(): React.JSX.Element | null {
  const audio = useStudio((s) => s.audio);
  const stored = useStudio((s) => s.document.analysisSettings.beatRefinement);
  const state = useStudio((s) => s.beatRefinementState);
  const refining = useStudio((s) => s.refiningBeats);
  const confidence = useStudio((s) => s.analysis?.beatGrid?.confidence ?? 1);
  const refineBeats = useStudio((s) => s.refineBeats);
  const cancelRefineBeats = useStudio((s) => s.cancelRefineBeats);
  const reanalyse = useStudio((s) => s.reanalyse);
  const run = useStudio((s) => s.run);

  // Undo and redo change the stored grid too, and the analysis has to follow it.
  const seen = useRef(stored);
  useEffect(() => {
    if (seen.current === stored) return;
    seen.current = stored;
    void reanalyse();
  }, [stored, reanalyse]);

  if (audio === null) return null;
  const refined = state === 'applied';
  return (
    <div className="beat-controls" data-testid="beat-controls" data-state={state}>
      <p className="dim-text" data-testid="beat-source">
        {state === 'applied' && stored !== null ? `Beats: refined with ${stored.tool}${stored.sections.length > 0 ? ', sections too' : ''}.` : null}
        {state === 'stale' ? 'The refined beats belong to another audio file, so the detected ones are in use.' : null}
        {state === 'overridden' ? 'The tempo override is in use, not the refined beats.' : null}
        {state === 'none' && confidence < UNSURE ? 'The tempo is uncertain here. If the music speeds up or slows down, refining should help.' : null}
      </p>
      <div className="job-actions">
        {refining
          ? <button type="button" data-action="beats-cancel" onClick={() => void cancelRefineBeats()}>Cancel</button>
          : (
            <button type="button" data-action="beats-refine" title="Follows a tempo that changes, for rubato, live drums and sparse percussion. Stored in the project." onClick={() => void refineBeats()}>
              {refined ? 'Refine again' : 'Refine beats'}
            </button>
          )}
        {refining ? <span className="dim-text">Tracking the beats…</span> : null}
        {stored !== null && !refining
          ? <button type="button" data-action="beats-revert" title="Back to the detected beats" onClick={() => run(setBeatRefinement(null))}>Use detected</button>
          : null}
      </div>
    </div>
  );
}
