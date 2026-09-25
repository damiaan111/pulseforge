// The render queue drawer (ui-spec §7): status, progress, fps, ETA, and per-job actions.

import { formatDuration } from '../../export/progress.ts';
import type { JobStatus, RenderJob } from '../../shell/ipc.ts';
import { useStudio } from '../store.ts';

// Local, not imported from queue.ts: that module uses node:fs and must never reach the renderer bundle.
const FINISHED: readonly JobStatus[] = ['done', 'failed', 'cancelled', 'interrupted'];

const STATUS_TEXT: Readonly<Record<JobStatus, string>> = {
  queued: 'Queued',
  running: 'Rendering',
  paused: 'Paused',
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

export function RenderQueue(): React.JSX.Element | null {
  const open = useStudio((s) => s.queueOpen);
  const setOpen = useStudio((s) => s.setQueueOpen);
  const jobs = useStudio((s) => s.renders);
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
      {jobs.length === 0 ? (
        <p className="empty">Nothing queued. Use Export to add a render.</p>
      ) : (
        <ul className="job-list">{jobs.map((job) => <Job key={job.id} job={job} />)}</ul>
      )}
    </aside>
  );
}
