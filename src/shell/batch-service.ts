// Batch mode in the studio (S13, export-spec §12): a list of tracks becomes auto-directed projects,
// each queued for rendering the moment it is directed — so the first video is rendering while the
// rest are still being directed, and a render goes ahead of stem separation on the GPU (M28).
//
// Plain Node: the directing, the queue and the stem separation are injected, so the tests drive a
// whole batch without a GPU, and the main process wires in the real ones.

import type { DirectedTrack } from '../batch/direct-track.ts';
import { planBatch, type BatchTrack } from '../batch/plan.ts';
import { motionBlurProblems, type MotionBlur } from '../engine/core/time.ts';
import { findExportPreset, type ExportPreset } from '../export/export-presets.ts';

export interface BatchRequest {
  readonly tracks: readonly string[];
  readonly outDir: string;
  readonly presetId: string;
  /** Null: each track's best match. */
  readonly templateId: string | null;
  readonly seed: number;
  /** Separate stems before directing each track. */
  readonly stems: boolean;
  /** Refine each track's beats (S16) before directing it. Absent: the detected grid. */
  readonly refineBeats?: boolean;
  readonly motionBlur: MotionBlur | null;
  /** Karaoke (S15): render with the instrumental. Needs stems, so `stems` should be on. Absent: the song. */
  readonly audioMix?: 'full' | 'instrumental';
}

export interface BatchTrackStatus {
  readonly name: string;
  readonly audioPath: string;
  readonly projectPath: string;
  readonly outputPath: string;
  readonly state: 'waiting' | 'directing' | 'queued' | 'failed' | 'skipped';
  /** The roll's summary once directed; the reason once failed or skipped. */
  readonly detail: string | null;
  readonly notes: readonly string[];
}

export interface BatchStatus {
  readonly id: string;
  readonly state: 'running' | 'finished' | 'cancelled';
  readonly presetLabel: string;
  readonly tracks: readonly BatchTrackStatus[];
}

export interface BatchServiceOptions {
  readonly directTrack: (track: BatchTrack, options: { readonly preset: ExportPreset; readonly templateId: string | null; readonly stems: boolean; readonly refineBeats: boolean }) => Promise<DirectedTrack>;
  /** Queues one directed project's render; the queue snapshots the file as it is. */
  readonly enqueue: (request: { readonly projectPath: string; readonly presetId: string; readonly outputPath: string; readonly motionBlur: MotionBlur | null; readonly audioMix: 'full' | 'instrumental' }) => Promise<unknown>;
  readonly templateIds: () => Promise<readonly string[]>;
  readonly newId: () => string;
  readonly onChange?: (status: BatchStatus) => void;
}

export class BatchRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BatchRequestError';
  }
}

export interface BatchService {
  /** Validates, plans and starts a batch; resolves with its first status, not when it finishes. */
  start(request: BatchRequest): Promise<BatchStatus>;
  /** Stops directing more tracks. Renders already queued stay in the queue, to cancel there. */
  cancel(): void;
  status(): BatchStatus | null;
  /** True while tracks are still being directed. */
  busy(): boolean;
  /** Resolves when the running batch (if any) has directed its last track. */
  settled(): Promise<void>;
}

export function createBatchService(options: BatchServiceOptions): BatchService {
  let current: BatchStatus | null = null;
  let cancelled = false;
  let running: Promise<void> = Promise.resolve();

  const update = (next: BatchStatus) => {
    current = next;
    options.onChange?.(next);
  };
  const setTrack = (index: number, change: Partial<BatchTrackStatus>) => {
    if (current === null) return;
    update({ ...current, tracks: current.tracks.map((t, i) => (i === index ? { ...t, ...change } : t)) });
  };

  async function run(plan: readonly BatchTrack[], request: BatchRequest, preset: ExportPreset): Promise<void> {
    for (const [index, track] of plan.entries()) {
      if (cancelled) {
        setTrack(index, { state: 'skipped', detail: 'The batch was cancelled before this track.' });
        continue;
      }
      setTrack(index, { state: 'directing' });
      try {
        const directed = await options.directTrack(track, { preset, templateId: request.templateId, stems: request.stems, refineBeats: request.refineBeats === true });
        await options.enqueue({ projectPath: track.projectPath, presetId: preset.id, outputPath: track.outputPath, motionBlur: request.motionBlur, audioMix: request.audioMix ?? 'full' });
        setTrack(index, { state: 'queued', detail: directed.summary, notes: directed.notes });
      } catch (error) {
        // One bad track never stops the batch: it is marked, with why, and the next one starts.
        setTrack(index, { state: 'failed', detail: error instanceof Error ? error.message : String(error) });
      }
    }
    if (current !== null) update({ ...current, state: cancelled ? 'cancelled' : 'finished' });
  }

  return {
    async start(request) {
      if (current?.state === 'running') throw new BatchRequestError('A batch is already being directed. Wait for it, or cancel it.');
      if (!Array.isArray(request.tracks) || request.tracks.length === 0 || !request.tracks.every((t) => typeof t === 'string' && t !== '')) {
        throw new BatchRequestError('Add at least one track.');
      }
      if (typeof request.outDir !== 'string' || request.outDir === '') throw new BatchRequestError('Choose an output folder.');
      const preset = findExportPreset(request.presetId);
      if (preset === undefined) throw new BatchRequestError(`Unknown export preset "${request.presetId}".`);
      if (request.templateId !== null && !(await options.templateIds()).includes(request.templateId)) {
        throw new BatchRequestError(`Unknown template "${request.templateId}".`);
      }
      if (!Number.isSafeInteger(request.seed)) throw new BatchRequestError('The seed must be a whole number.');
      if (request.motionBlur !== null && motionBlurProblems(request.motionBlur).length > 0) {
        throw new BatchRequestError(motionBlurProblems(request.motionBlur).join('; '));
      }
      if (request.audioMix !== undefined && request.audioMix !== 'full' && request.audioMix !== 'instrumental') {
        throw new BatchRequestError('The audio must be the song ("full") or the instrumental.');
      }
      const plan = planBatch(request.tracks, { outDir: request.outDir, preset, seed: request.seed, templateId: request.templateId });
      cancelled = false;
      const status: BatchStatus = {
        id: options.newId(),
        state: 'running',
        presetLabel: preset.label,
        tracks: plan.map((t) => ({ name: t.name, audioPath: t.audioPath, projectPath: t.projectPath, outputPath: t.outputPath, state: 'waiting', detail: null, notes: [] })),
      };
      update(status);
      running = run(plan, request, preset);
      return status;
    },
    cancel() {
      if (current?.state === 'running') cancelled = true;
    },
    status: () => current,
    busy: () => current?.state === 'running',
    settled: () => running,
  };
}

export interface CompletionSummary {
  readonly done: number;
  readonly failed: number;
}

/**
 * Notices the moment everything is finished (export-spec §12: "notification on completion",
 * "shutdown when done"): the queue has nothing queued or running and no batch is still directing,
 * after having had work. Fires once per such moment, with how the finished jobs went.
 */
export function completionWatcher(onComplete: (summary: CompletionSummary) => void): {
  update(jobs: readonly { readonly status: string; readonly id: string }[], batchBusy: boolean): void;
} {
  let wasBusy = false;
  const seen = new Set<string>();
  return {
    update(jobs, batchBusy) {
      const busy = batchBusy || jobs.some((job) => job.status === 'queued' || job.status === 'running' || job.status === 'paused');
      if (busy) {
        wasBusy = true;
        return;
      }
      if (!wasBusy) {
        // Idle and nothing new: whatever is listed (last session's jobs) is history, not news.
        for (const job of jobs) seen.add(job.id);
        return;
      }
      wasBusy = false;
      // Count only the jobs that finished since the last completion, not the whole history.
      const fresh = jobs.filter((job) => !seen.has(job.id));
      for (const job of jobs) seen.add(job.id);
      onComplete({ done: fresh.filter((j) => j.status === 'done').length, failed: fresh.filter((j) => j.status === 'failed').length });
    },
  };
}
