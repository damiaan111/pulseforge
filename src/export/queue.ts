// The render queue (M24, export-spec §12).
//
// Three properties carry the feature; everything else is bookkeeping.
//
//  1. **Snapshot on enqueue.** A job renders the project *as it was when queued*. The document
//     is serialised to a file in the queue directory the moment the job is created, so editing
//     — or closing — the project afterwards cannot change what comes out. This is the whole
//     reason a queue is worth having: "queue three variants and keep working" has to be safe.
//  2. **Persisted.** The queue is written to disk on every change, so a crash or a reboot
//     during an overnight batch loses at most the job that was mid-render.
//  3. **Sequential.** Jobs contend for one GPU (PROJECT.md M28), so they run one at a time.
//     Parallelism here would make every job slower and the machine unusable.
//
// Deliberately GPU-free: the queue owns *what* runs and in what order, and is handed a runner
// that owns *how*. That split is what makes the whole thing testable without a renderer, and it
// is also why the queue can be driven from the CLI and the app alike.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { stringifyDocument } from '../project/serialize.ts';
import type { ProjectDocument } from '../project/document.ts';
import type { ProgressSnapshot } from './progress.ts';

export const QUEUE_FORMAT_VERSION = 1;

export type JobStatus = 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled' | 'interrupted';

/** Statuses that will never change on their own — what "the queue is drained" means. */
const TERMINAL: readonly JobStatus[] = ['done', 'failed', 'cancelled', 'interrupted'];

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL.includes(status);
}

export interface JobRange {
  readonly inTicks: number;
  readonly outTicks: number;
}

export interface RenderJob {
  readonly id: string;
  /** What the UI calls it — usually the project name plus the aspect. */
  readonly label: string;
  /** Where the project lives, when it has been saved. Null for an unsaved document. */
  readonly projectPath: string | null;
  /** The serialised document as it was at enqueue. The job renders *this*, never the live one. */
  readonly snapshotPath: string;
  readonly snapshotHash: string;
  readonly aspect: string;
  readonly presetName: string;
  /** Null renders the whole timeline. */
  readonly range: JobRange | null;
  readonly outputPath: string;
  readonly status: JobStatus;
  readonly progress: ProgressSnapshot | null;
  readonly enqueuedAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly error: string | null;
  readonly reportPath: string | null;
}

export interface EnqueueRequest {
  readonly document: ProjectDocument;
  readonly label?: string;
  readonly projectPath?: string | null;
  readonly aspect: string;
  readonly presetName: string;
  readonly range?: JobRange | null;
  readonly outputPath: string;
}

/**
 * Runs one job. Injected, so the queue never imports the renderer — and so the tests below
 * exercise ordering, persistence and cancellation without a GPU in sight.
 */
export type JobRunner = (context: JobContext) => Promise<JobOutcome>;

export interface JobContext {
  readonly job: RenderJob;
  /** The document as it was enqueued, read back from the snapshot. */
  readonly documentJson: string;
  /** Call as the encoder reports frames; persisted and forwarded to `onChange`. */
  readonly report: (progress: ProgressSnapshot) => void;
  /** Poll this: true once the job has been cancelled or the queue stopped. */
  readonly isCancelled: () => boolean;
}

export interface JobOutcome {
  readonly reportPath?: string;
}

export interface QueueOptions {
  /** Directory for `queue.json` and the document snapshots. */
  readonly root: string;
  readonly run: JobRunner;
  readonly newId: () => string;
  /** Injected so tests are byte-stable, as `History` does. */
  readonly now?: () => string;
  /** Fired after every state change — the UI's single subscription point. */
  readonly onChange?: (jobs: readonly RenderJob[]) => void;
}

interface QueueFile {
  readonly formatVersion: number;
  readonly jobs: readonly RenderJob[];
}

export class RenderQueue {
  private readonly root: string;
  private readonly runner: JobRunner;
  private readonly newId: () => string;
  private readonly now: () => string;
  private readonly onChange: ((jobs: readonly RenderJob[]) => void) | undefined;

  private jobs: RenderJob[] = [];
  private cancelled = new Set<string>();
  private draining: Promise<void> | null = null;
  private stopping = false;
  /** Set between jobs, so "stop after this one" does not kill the render in flight. */
  private paused = false;

  constructor(options: QueueOptions) {
    this.root = options.root;
    this.runner = options.run;
    this.newId = options.newId;
    this.now = options.now ?? (() => new Date().toISOString());
    this.onChange = options.onChange;
  }

  get queueFilePath(): string {
    return join(this.root, 'queue.json');
  }

  list(): readonly RenderJob[] {
    return this.jobs;
  }

  get(id: string): RenderJob | undefined {
    return this.jobs.find((job) => job.id === id);
  }

  /** Jobs still waiting or running — what "is anything left to do" means. */
  get pending(): readonly RenderJob[] {
    return this.jobs.filter((job) => !isTerminal(job.status));
  }

  /**
   * Load a persisted queue.
   *
   * A job recorded as `running` did not finish — the process died mid-render. It becomes
   * `interrupted` rather than being silently restarted: relaunching the app should not kick off
   * a forty-minute 4K render nobody asked for. `retry` puts it back in line when the user says so.
   */
  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.queueFilePath, 'utf8');
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw cause;
    }
    let parsed: QueueFile;
    try {
      parsed = JSON.parse(text) as QueueFile;
    } catch {
      return; // A corrupt queue file loses the queue, never the projects it pointed at.
    }
    if (parsed.formatVersion !== QUEUE_FORMAT_VERSION || !Array.isArray(parsed.jobs)) return;

    this.jobs = parsed.jobs.map((job) =>
      job.status === 'running'
        ? { ...job, status: 'interrupted', error: 'Pulseforge stopped while this job was rendering.', finishedAt: this.now() }
        : job,
    );
    this.emit();
  }

  async enqueue(request: EnqueueRequest): Promise<RenderJob> {
    await mkdir(join(this.root, 'snapshots'), { recursive: true });
    const id = this.newId();
    const json = stringifyDocument(request.document);
    const snapshotPath = join(this.root, 'snapshots', `${id}.pvproj`);
    await writeAtomic(snapshotPath, json);

    const job: RenderJob = {
      id,
      label: request.label ?? `${request.document.name} (${request.aspect})`,
      projectPath: request.projectPath ?? null,
      snapshotPath,
      snapshotHash: createHash('sha256').update(json).digest('hex'),
      aspect: request.aspect,
      presetName: request.presetName,
      range: request.range ?? null,
      outputPath: request.outputPath,
      status: 'queued',
      progress: null,
      enqueuedAt: this.now(),
      startedAt: null,
      finishedAt: null,
      error: null,
      reportPath: null,
    };
    this.jobs.push(job);
    await this.persist();
    return job;
  }

  /**
   * Move a job within the queue. Only queued jobs move: reordering the running one would mean
   * nothing, and reordering a finished one is just noise in the history.
   */
  async move(id: string, toIndex: number): Promise<void> {
    const from = this.jobs.findIndex((job) => job.id === id);
    if (from < 0) return;
    if (this.jobs[from]!.status !== 'queued') return;
    const [job] = this.jobs.splice(from, 1);
    this.jobs.splice(Math.min(Math.max(toIndex, 0), this.jobs.length), 0, job as RenderJob);
    await this.persist();
  }

  /**
   * Cancel a queued or running job. A queued one stops immediately; a running one is flagged and
   * the runner sees it on its next poll, so the encoder can close cleanly rather than being
   * killed mid-frame (export-spec §13).
   */
  async cancel(id: string): Promise<void> {
    const job = this.get(id);
    if (job === undefined || isTerminal(job.status)) return;
    this.cancelled.add(id);
    if (job.status === 'queued') {
      this.patch(id, { status: 'cancelled', finishedAt: this.now() });
      await this.persist();
    }
  }

  /** Requeue a job that failed, was cancelled, or was interrupted. Its snapshot still stands. */
  async retry(id: string): Promise<void> {
    const job = this.get(id);
    if (job === undefined || job.status === 'queued' || job.status === 'running') return;
    this.cancelled.delete(id);
    this.patch(id, { status: 'queued', progress: null, startedAt: null, finishedAt: null, error: null });
    await this.persist();
  }

  /** Remove a job and its snapshot. A running job is cancelled first rather than orphaned. */
  async remove(id: string): Promise<void> {
    const job = this.get(id);
    if (job === undefined) return;
    if (!isTerminal(job.status)) await this.cancel(id);
    this.jobs = this.jobs.filter((entry) => entry.id !== id);
    await rm(job.snapshotPath, { force: true });
    await this.persist();
  }

  /** Drop every finished job from the list, leaving what still matters. */
  async clearFinished(): Promise<void> {
    const finished = this.jobs.filter((job) => isTerminal(job.status));
    this.jobs = this.jobs.filter((job) => !isTerminal(job.status));
    for (const job of finished) await rm(job.snapshotPath, { force: true });
    await this.persist();
  }

  /**
   * Run queued jobs, one at a time, until the queue drains or is paused.
   *
   * Calling it while it is already draining returns the run in progress rather than starting a
   * second one — otherwise two callers would race for the GPU, which is exactly what sequential
   * execution exists to prevent.
   */
  async drain(): Promise<void> {
    if (this.draining !== null) return this.draining;
    this.paused = false;
    this.draining = this.loop().finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  /** Finish the running job, then stop. The queue keeps its remaining jobs. */
  pause(): void {
    this.paused = true;
  }

  /** Stop after the current job and cancel it too — the "stop everything" action. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.paused = true;
    const running = this.jobs.find((job) => job.status === 'running');
    if (running !== undefined) await this.cancel(running.id);
    await this.draining;
    this.stopping = false;
  }

  get isDraining(): boolean {
    return this.draining !== null;
  }

  private async loop(): Promise<void> {
    for (;;) {
      if (this.paused) return;
      const job = this.jobs.find((entry) => entry.status === 'queued');
      if (job === undefined) return;

      this.patch(job.id, { status: 'running', startedAt: this.now(), error: null });
      await this.persist();

      try {
        const documentJson = await readFile(job.snapshotPath, 'utf8');
        const outcome = await this.runner({
          job: this.get(job.id) as RenderJob,
          documentJson,
          report: (progress) => {
            this.patch(job.id, { progress });
            this.emit();
          },
          isCancelled: () => this.cancelled.has(job.id) || this.stopping,
        });
        this.patch(job.id, {
          status: this.cancelled.has(job.id) ? 'cancelled' : 'done',
          finishedAt: this.now(),
          reportPath: outcome.reportPath ?? null,
        });
      } catch (cause) {
        // A failure ends this job, never the queue: an overnight batch must survive one bad
        // project rather than stopping at it and wasting the night.
        this.patch(job.id, {
          status: this.cancelled.has(job.id) ? 'cancelled' : 'failed',
          finishedAt: this.now(),
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
      this.cancelled.delete(job.id);
      await this.persist();
    }
  }

  private patch(id: string, changes: Partial<RenderJob>): void {
    this.jobs = this.jobs.map((job) => (job.id === id ? { ...job, ...changes } : job));
  }

  private async persist(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const file: QueueFile = { formatVersion: QUEUE_FORMAT_VERSION, jobs: this.jobs };
    await writeAtomic(this.queueFilePath, `${JSON.stringify(file, null, 2)}\n`);
    this.emit();
  }

  private emit(): void {
    this.onChange?.(this.jobs);
  }
}

/** Temp file then rename, as `project-io.ts` does: a crash mid-write leaves the old queue intact. */
async function writeAtomic(path: string, text: string): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, text, 'utf8');
  await rename(temp, path);
}
