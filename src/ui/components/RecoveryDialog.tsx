// Crash recovery (M1, ui-spec §10): on start, a run that ended without a clean quit or a save left
// an autosave behind. This offers it back — which project, when, why it was taken, and a short
// summary of how it differs from the saved file — and lets the person restore or discard it.
// Nothing is discarded without being asked: closing the dialog leaves the autosave for next time.

import { useMemo, useState } from 'react';

import { loadDocument } from '../../project/load.ts';
import { summarizeRecovery } from '../../project/recovery-diff.ts';
import type { RecoveryCandidate } from '../../shell/ipc.ts';
import { useStudio } from '../store.ts';

export function RecoveryDialog(): React.JSX.Element | null {
  const recovery = useStudio((s) => s.recovery);
  const [dismissed, setDismissed] = useState(false);
  const candidate = recovery[0];
  if (dismissed || candidate === undefined) return null;
  return (
    <div className="modal-backdrop">
      <div className="modal recovery-dialog" role="dialog" aria-label="Recover unsaved work">
        <h2>Recover unsaved work?</h2>
        <p className="recovery-lead">
          Pulseforge did not close normally last time. It kept an autosave of work that was not saved.
        </p>
        <RecoveryCard candidate={candidate} />
        {recovery.length > 1 ? <p className="recovery-more">{recovery.length - 1} older autosave{recovery.length === 2 ? '' : 's'} will be offered after this one.</p> : null}
        <div className="modal-actions">
          <button type="button" data-action="recovery-later" title="Keep the autosave and decide next time" onClick={() => setDismissed(true)}>Later</button>
          <Discard candidate={candidate} />
          <Restore candidate={candidate} />
        </div>
      </div>
    </div>
  );
}

function RecoveryCard(props: { candidate: RecoveryCandidate }): React.JSX.Element {
  const { candidate } = props;
  const lines = useMemo(() => {
    try {
      const recovered = loadDocument(candidate.text).document;
      let saved = null;
      if (candidate.savedText !== null) {
        try {
          saved = loadDocument(candidate.savedText).document;
        } catch {
          return ['The saved file could not be read, so it cannot be compared.', ...summarizeRecovery(null, recovered).map((l) => l.replace('never saved', 'not readable on disk'))];
        }
      }
      return summarizeRecovery(saved, recovered);
    } catch (error) {
      return [`The autosave could not be read: ${error instanceof Error ? error.message : String(error)}`];
    }
  }, [candidate]);
  return (
    <div className="recovery-card" data-recovery={candidate.sessionId}>
      <div className="recovery-name">{candidate.projectName || 'Untitled'}</div>
      <div className="recovery-meta">
        {candidate.projectPath ?? 'Never saved'} · autosaved {new Date(candidate.savedAt).toLocaleString()} ({candidate.reason})
      </div>
      <ul className="recovery-summary">
        {lines.map((line) => <li key={line}>{line}</li>)}
      </ul>
    </div>
  );
}

function Restore(props: { candidate: RecoveryCandidate }): React.JSX.Element {
  const restore = useStudio((s) => s.restoreRecovery);
  return (
    <button type="button" className="primary" data-action="recovery-restore" onClick={() => void restore(props.candidate)}>
      Restore
    </button>
  );
}

function Discard(props: { candidate: RecoveryCandidate }): React.JSX.Element {
  const discard = useStudio((s) => s.discardRecovery);
  return (
    <button type="button" data-action="recovery-discard" title="Delete this autosave" onClick={() => {
      if (window.confirm(`Delete the autosave of “${props.candidate.projectName || 'Untitled'}”? This cannot be undone.`)) void discard(props.candidate.sessionId);
    }}>
      Discard
    </button>
  );
}
