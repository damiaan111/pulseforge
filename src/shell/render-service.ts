// The studio's render queue, in the main process (M24, ui-spec §7, export-spec §12–13).
//
// `RenderQueue` owns order, persistence and cancellation; this file supplies the runner that
// actually renders, which is `renderDocument` — the same function `npm run render` calls, so a
// render from the studio and from the CLI cannot differ.
//
// Plain Node: no Electron import, so it is exercised end to end by a Node script as well as by
// the app. The main process wires its `onChange` to the renderer.

import { join } from 'node:path';

import { findExportPreset } from '../export/export-presets.ts';
import { ProgressTracker } from '../export/progress.ts';
import { RenderQueue, type RenderJob } from '../export/queue.ts';
import { renderDocument } from '../export/render-document.ts';
import { aspectBucket } from '../project/document.ts';
import { newId } from '../project/ids.ts';
import { loadDocument } from '../project/load.ts';

export interface RenderServiceOptions {
  /** `queue.json` and the document snapshots. */
  readonly root: string;
  /** Per-job scratch: analysis blob, export audio, result JSON. Can be large — keep it off a full drive. */
  readonly workRoot: string;
  /** The analysis cache root, the same one the studio's preview analysis uses, so a render is a cache hit. */
  readonly cacheRoot: string;
  readonly onChange?: (jobs: readonly RenderJob[]) => void;
  /** How often a running job checks for cancellation. */
  readonly cancelPollMs?: number;
}

export interface RenderRequest {
  /** The serialised document, exactly as the studio holds it now. */
  readonly text: string;
  readonly projectPath: string | null;
  readonly presetId: string;
  readonly outputPath: string;
}

export interface RenderService {
  list(): readonly RenderJob[];
  enqueue(request: RenderRequest): Promise<RenderJob>;
  cancel(id: string): Promise<void>;
  retry(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  clearFinished(): Promise<void>;
  /** Cancels whatever is running and waits for it — for app shutdown. */
  stop(): Promise<void>;
  /** Resolves when nothing is queued or running. */
  idle(): Promise<void>;
}

export class RenderRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderRequestError';
  }
}

export async function createRenderService(options: RenderServiceOptions): Promise<RenderService> {
  const queue: RenderQueue = new RenderQueue({
    root: options.root,
    newId,
    ...(options.onChange !== undefined ? { onChange: options.onChange } : {}),
    run: async ({ job, documentJson, report, isCancelled }) => {
      const preset = findExportPreset(job.presetName);
      if (preset === undefined) throw new Error(`Unknown export preset "${job.presetName}".`);

      // The queue's cancellation is a flag it expects to be polled; the render host wants an
      // AbortSignal it can act on at once. This is the adapter, and it is why a cancel stops the
      // GPU work within a poll interval rather than at the end of the render.
      const controller = new AbortController();
      const poll = setInterval(() => {
        if (isCancelled()) controller.abort();
      }, options.cancelPollMs ?? 200);
      let tracker: ProgressTracker | undefined;
      try {
        const result = await renderDocument({
          documentText: documentJson,
          projectPath: job.projectPath,
          size: preset.size ?? undefined,
          codec: preset.codec,
          outputPath: job.outputPath,
          workDir: join(options.workRoot, job.id),
          cacheRoot: options.cacheRoot,
          name: 'job',
          signal: controller.signal,
          onProgress: (progress) => {
            tracker ??= new ProgressTracker({ total: progress.total, now: () => performance.now() });
            tracker.update(progress.encoded);
            report(tracker.snapshot);
          },
        });
        if (!result.report.verification.ok) {
          throw new Error(`The rendered file failed verification: ${result.report.verification.issues.join('; ')}`);
        }
        // The last progress line the child printed is throttled and usually short of the end, so
        // a finished job would otherwise show "50/120" for ever. The frame count is now known.
        tracker ??= new ProgressTracker({ total: result.frames, now: () => performance.now() });
        tracker.update(result.frames);
        report(tracker.snapshot);
        return { reportPath: result.reportPath };
      } finally {
        clearInterval(poll);
      }
    },
  });
  await queue.load();

  const kick = () => {
    queue.drain().catch((error: unknown) => {
      // The loop catches job failures itself; reaching here means the queue could not persist.
      console.error(`[render-queue] ${error instanceof Error ? error.message : String(error)}`);
    });
  };

  return {
    list: () => queue.list(),

    async enqueue(request) {
      const preset = findExportPreset(request.presetId);
      if (preset === undefined) throw new RenderRequestError(`Unknown export preset "${request.presetId}".`);
      if (!request.outputPath.toLowerCase().endsWith('.mp4')) {
        throw new RenderRequestError('The output file must be an .mp4 (D5: MP4 only).');
      }
      const { document } = loadDocument(request.text);
      if (document.audio.path === '') throw new RenderRequestError('The project has no audio. Import audio before rendering.');
      const size = preset.size ?? document.canvas;
      const job = await queue.enqueue({
        document,
        projectPath: request.projectPath,
        aspect: aspectBucket(size.width, size.height),
        presetName: preset.id,
        outputPath: request.outputPath,
        label: `${document.name} — ${preset.label}`,
      });
      kick();
      return job;
    },

    cancel: (id) => queue.cancel(id),
    async retry(id) {
      await queue.retry(id);
      kick();
    },
    remove: (id) => queue.remove(id),
    clearFinished: () => queue.clearFinished(),
    stop: () => queue.stop(),
    async idle() {
      while (queue.pending.length > 0) {
        await queue.drain();
        if (queue.pending.length > 0) await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
  };
}
