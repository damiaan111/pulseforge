// The render queue drawer (ui-spec §7): status, progress, fps, ETA, and per-job actions.

import { formatDuration } from '../../export/progress.ts';
import type { BatchStatus, JobStatus, RenderJob } from '../../shell/ipc.ts';
import { useStudio } from '../store.ts';

// Local, not imported from queue.ts: that module uses node:fs and must never reach the renderer bundle.
const FINISHED: readonly JobStatus[] = ['done', 'failed', 'cancelled', 'interrupted'];

const STATUS_TEXT: Readonly<Record<JobStatus, string>> = {
  queued: 'Queued',
  running: 'Rendering',
  paused: 'Paused — not enough disk space',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted — the app closed mid-render',
};

async function act(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    useStudio.getState().notify({ text: error instanceof Error ? error.message : String(error), kind: 'bad' });
  }
}

function Job({ job }: { job: RenderJob }): React.JSX.Element {
  const api = window.pulseforge;
  const progress = job.progress;
  const finished = FINISHED.includes(job.status);
  const fraction = job.status === 'done' ? 1 : (progress?.fraction ?? 0);
  return (
    <li className={`job ${job.status}`} data-status={job.status}>
      <div className="job-head">
        <span className="job-label" title={job.outputPath}>{job.label}</span>
        <span className="job-status">{STATUS_TEXT[job.status]}</span>
      </div>
      <div className="progress"><div className="progress-fill" style={{ width: `${(fraction * 100).toFixed(1)}%` }} /></div>
      {job.status === 'running' && progress !== null ? (
        <div className="job-meta">
          {progress.frame}/{progress.total} frames · {progress.fps.toFixed(0)} fps · ETA {formatDuration(progress.etaMs)}
        </div>
      ) : null}
      {job.error !== null ? <div className="job-error">{job.error}</div> : null}
      <div className="job-actions">
        {!finished ? <button type="button" data-action="render-cancel" onClick={() => void act(() => api.cancelRender(job.id))}>Cancel</button> : null}
        {job.status === 'failed' || job.status === 'cancelled' || job.status === 'interrupted'
          ? <button type="button" onClick={() => void act(() => api.retryRender(job.id))}>Retry</button>
          : null}
        {job.status === 'paused'
          ? <button type="button" data-action="render-resume" title="Checks the disk again and carries on with the queue" onClick={() => void act(() => api.retryRender(job.id))}>Resume</button>
          : null}
        {job.status === 'done' ? <button type="button" onClick={() => void act(() => api.revealRender(job.outputPath))}>Show file</button> : null}
        {job.status === 'failed'
          ? <button type="button" data-action="render-diagnostics" title="The error, the environment and the log, to the clipboard for a bug report" onClick={() => void act(async () => {
            const { lines } = await api.copyDiagnostics({ jobId: job.id });
            useStudio.getState().notify({ text: `Diagnostics copied (${lines} lines) — paste them into a message.`, kind: 'ok' });
          })}>Copy diagnostics</button>
          : null}
        {finished ? <button type="button" onClick={() => void act(() => api.removeRender(job.id))}>Remove</button> : null}
      </div>
    </li>
  );
}

const BATCH_TRACK_TEXT: Readonly<Record<BatchStatus['tracks'][number]['state'], string>> = {
  waiting: 'Waiting',
  directing: 'Directing…',
  queued: 'Queued to render',
  failed: 'Failed',
  skipped: 'Skipped',
};

/** The batch being directed, or the last one (S13): which tracks are in, and why any are not. */
function BatchSummary({ batch }: { batch: BatchStatus }): React.JSX.Element {
  const directed = batch.tracks.filter((t) => t.state === 'queued').length;
  const problems = batch.tracks.filter((t) => t.state === 'failed' || t.state === 'skipped' || t.notes.length > 0);
  const current = batch.tracks.find((t) => t.state === 'directing');
  return (
    <div className="batch-summary" data-testid="batch-summary" data-state={batch.state}>
      <div className="job-head">
        <span className="job-label">Batch · {batch.presetLabel}</span>
        <span className="job-status">
          {batch.state === 'running' ? `Directing ${directed + 1} of ${batch.tracks.length}` : batch.state === 'cancelled' ? 'Cancelled' : 'All directed'}
        </span>
      </div>
      <div className="progress"><div className="progress-fill" style={{ width: `${((batch.tracks.filter((t) => t.state !== 'waiting' && t.state !== 'directing').length / batch.tracks.length) * 100).toFixed(1)}%` }} /></div>
      {current !== undefined ? <div className="job-meta">{current.name}</div> : null}
      {problems.length > 0 ? (
        <ul className="batch-problems">
          {problems.map((t) => (
            <li key={t.projectPath} className={t.state === 'failed' ? 'bad' : 'warn'}>
              {t.name}: {t.state === 'failed' || t.state === 'skipped' ? `${BATCH_TRACK_TEXT[t.state]} — ${t.detail ?? ''}` : t.notes.join(' ')}
            </li>
          ))}
        </ul>
      ) : null}
      {batch.state === 'running' ? (
        <div className="job-actions">
          <button type="button" data-action="batch-cancel" title="Stops directing more tracks; renders already queued stay below" onClick={() => void act(() => window.pulseforge.cancelBatch())}>Cancel batch</button>
        </div>
      ) : null}
    </div>
  );
}

export function RenderQueue(): React.JSX.Element | null {
  const open = useStudio((s) => s.queueOpen);
  const setOpen = useStudio((s) => s.setQueueOpen);
  const jobs = useStudio((s) => s.renders);
  const batch = useStudio((s) => s.batch);
  const shutdownWhenDone = useStudio((s) => s.shutdownWhenDone);
  const setShutdownWhenDone = useStudio((s) => s.setShutdownWhenDone);
  if (!open) return null;
  const anyFinished = jobs.some((job) => FINISHED.includes(job.status));

  return (
    <aside className="queue-drawer" aria-label="Render queue">
      <div className="queue-head">
        <h2>Renders</h2>
        <span className="spacer" />
        {anyFinished ? <button type="button" onClick={() => void act(() => window.pulseforge.clearFinishedRenders())}>Clear finished</button> : null}
        <button type="button" onClick={() => setOpen(false)}>Close</button>
      </div>
      <label className="queue-shutdown" title="When every render and batch is finished, shut the computer down (after two minutes, which you can cancel)">
        <input type="checkbox" data-action="shutdown-when-done" checked={shutdownWhenDone} onChange={(e) => void setShutdownWhenDone(e.target.checked)} />
        {' '}Shut down when done
      </label>
      {batch !== null ? <BatchSummary batch={batch} /> : null}
      {jobs.length === 0 ? (
        <p className="empty">Nothing queued. Use Export to add a render, or Batch for many tracks.</p>
      ) : (
        <ul className="job-list">{jobs.map((job) => <Job key={job.id} job={job} />)}</ul>
      )}
    </aside>
  );
}
