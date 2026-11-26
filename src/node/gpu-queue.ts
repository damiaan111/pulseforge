// The global GPU job queue (M28, PROJECT.md §4): renders, Demucs and (later) WhisperX never share
// the GPU at once.
//
// An RTX 3060 has 12 GB. A 4K render's targets and NVENC session, plus a loaded Demucs model, plus
// WhisperX, do not fit together — and when two jobs contend, the failure is an out-of-memory error
// twenty minutes into something, or a driver reset. So heavy GPU jobs take turns:
//
//   - one job at a time, in arrival order within a priority;
//   - a waiting **render** goes before a waiting ML job ("interactive rendering takes priority,
//     ML jobs yield" — the export is what the user is waiting to watch);
//   - before a render starts, `beforeRender` runs, which is where the ML sidecar is stopped so its
//     models give their VRAM back ("models freed between jobs").
//
// A job already running is never pre-empted: a stem separation takes seconds, and killing one half
// way through would throw away the model load and leave half-written files for nothing.
//
// The live preview is not in here. It is interactive, light, and must never wait behind a
// separation; the jobs in this queue are the ones that allocate heavily.

export type GpuJobKind = 'render' | 'ml';

export interface GpuJobInfo {
  readonly kind: GpuJobKind;
  readonly label: string;
}

export interface GpuQueueOptions {
  /** Called before each render starts, e.g. to stop the ML sidecar and free its VRAM. */
  readonly beforeRender?: () => Promise<void>;
  /** Called whenever what is running or waiting changes — for a status line. */
  readonly onChange?: (state: { readonly running: GpuJobInfo | null; readonly waiting: readonly GpuJobInfo[] }) => void;
}

interface Waiting extends GpuJobInfo {
  readonly start: () => void;
  readonly cancel: (reason: Error) => void;
}

export class GpuJobCancelledError extends Error {
  constructor(label: string) {
    super(`"${label}" was cancelled before it reached the GPU.`);
    this.name = 'GpuJobCancelledError';
  }
}

export class GpuQueue {
  private readonly options: GpuQueueOptions;
  private runningJob: GpuJobInfo | null = null;
  private readonly waiting: Waiting[] = [];

  constructor(options: GpuQueueOptions = {}) {
    this.options = options;
  }

  get running(): GpuJobInfo | null {
    return this.runningJob;
  }

  get pending(): readonly GpuJobInfo[] {
    return this.waiting.map(({ kind, label }) => ({ kind, label }));
  }

  /**
   * Runs `job` when the GPU is free, and resolves with its result. An aborted `signal` while still
   * waiting takes the job out of the queue without ever starting it.
   */
  run<T>(kind: GpuJobKind, label: string, job: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(new GpuJobCancelledError(label));
        return;
      }
      const entry: Waiting = {
        kind,
        label,
        start: () => {
          signal?.removeEventListener('abort', onAbort);
          void this.execute(entry, job).then(resolve, reject);
        },
        cancel: reject,
      };
      const onAbort = () => {
        const index = this.waiting.indexOf(entry);
        if (index < 0) return; // already started: cancelling it is the job's own business
        this.waiting.splice(index, 1);
        this.changed();
        reject(new GpuJobCancelledError(label));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      // Renders queue ahead of every waiting ML job, behind earlier renders.
      const at = kind === 'render' ? this.waiting.findIndex((w) => w.kind !== 'render') : -1;
      if (at < 0) this.waiting.push(entry);
      else this.waiting.splice(at, 0, entry);
      this.changed();
      this.next();
    });
  }

  private next(): void {
    if (this.runningJob !== null) return;
    const entry = this.waiting.shift();
    if (entry === undefined) {
      this.changed();
      return;
    }
    this.runningJob = { kind: entry.kind, label: entry.label };
    this.changed();
    entry.start();
  }

  private async execute<T>(entry: Waiting, job: () => Promise<T>): Promise<T> {
    try {
      if (entry.kind === 'render') await this.options.beforeRender?.();
      return await job();
    } finally {
      this.runningJob = null;
      this.next();
    }
  }

  private changed(): void {
    this.options.onChange?.({ running: this.runningJob, waiting: this.pending });
  }
}
