// The studio's render queue, in the main process (M24, ui-spec §7, export-spec §12–13).
//
// `RenderQueue` owns order, persistence and cancellation; this file supplies the runner that
// actually renders, which is `renderDocument` — the same function `npm run render` calls, so a
// render from the studio and from the CLI cannot differ.
//
// Plain Node: no Electron import, so it is exercised end to end by a Node script as well as by
// the app. The main process wires its `onChange` to the renderer.

import { TICKS_PER_SECOND, type MotionBlur } from '../engine/core/time.ts';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { findExportPreset } from '../export/export-presets.ts';
import { ProgressTracker } from '../export/progress.ts';
import { comparisonDocument, comparisonTicks, renderComparison } from '../export/comparison.ts';
import { probeCodecs } from '../export/encoder-probe.ts';
import { defaultEncodeSettings } from '../export/ffmpeg-args.ts';
import { RenderQueue, type JobRange, type RenderJob } from '../export/queue.ts';
import type { GpuQueue } from '../node/gpu-queue.ts';
import { renderDocument } from '../export/render-document.ts';
import { aspectBucket } from '../project/document.ts';
import { newId } from '../project/ids.ts';
import { loadDocument } from '../project/load.ts';
import { FFMPEG_EXE, FFPROBE_EXE } from '../../setup/lib/paths.ts';

/** Scratch no job needs any more: a finished render's, or one taken off the list. */
export async function sweepWork(workRoot: string, keep: ReadonlySet<string>): Promise<void> {
  const names = await readdir(workRoot).catch(() => [] as string[]);
  await Promise.all(names.filter((name) => !keep.has(name)).map((name) => rm(join(workRoot, name), { recursive: true, force: true }).catch(() => undefined)));
}

export interface RenderServiceOptions {
  /** `queue.json` and the document snapshots. */
  readonly root: string;
  /** Per-job scratch: analysis blob, export audio, result JSON. Can be large — keep it off a full drive. */
  readonly workRoot: string;
  /**
   * The analysis cache root, the same one the studio's preview analysis uses, so a render is a
   * cache hit. A function is read per job, so a cache root changed in Settings applies at once.
   */
  readonly cacheRoot: string | (() => string);
  /** Where video clips are extracted; on a drive with room (M39). */
  readonly videoCacheRoot?: string | (() => string);
  readonly onChange?: (jobs: readonly RenderJob[]) => void;
  /** How often a running job checks for cancellation. */
  readonly cancelPollMs?: number;
  /** The global GPU queue (M28): a render waits its turn behind ML work, and goes ahead of queued ML. */
  readonly gpu?: GpuQueue;
}

export interface RenderRequest {
  /** The serialised document, exactly as the studio holds it now. */
  readonly text: string;
  readonly projectPath: string | null;
  readonly presetId: string;
  readonly outputPath: string;
  /** Motion blur (S10); absent or null is off. */
  readonly motionBlur?: MotionBlur | null;
  /** Spatial supersampling (export-spec §9); absent is off. */
  readonly supersample?: 1 | 2;
  /** Part of the timeline (S9); absent or null renders all of it. */
  readonly range?: JobRange | null;
  /** 'instrumental': a karaoke render (S15). Absent: the song. */
  readonly audioMix?: 'full' | 'instrumental';
  /** An A/B render (C10): this project on the right, the request's own on the left. */
  readonly compare?: { readonly text: string; readonly projectPath: string | null; readonly label: string };
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
  /** Resolves when nothing is queued or running, or the queue is held for disk space. */
  idle(): Promise<void>;
}

/** m:ss.s for a job label. */
function clock(ticks: number): string {
  const seconds = ticks / 48_000;
  const m = Math.floor(seconds / 60);
  return `${m}:${(seconds - m * 60).toFixed(1).padStart(4, '0')}`;
}

export class RenderRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderRequestError';
  }
}

/** One render within a job: all of it, or a side of an A/B (round 0 or 1 of 2). */
interface RenderSide {
  readonly text: string;
  readonly projectPath: string | null;
  readonly outputPath: string;
  readonly workDir: string;
  readonly audioMix: 'full' | 'instrumental';
  readonly seconds: number | undefined;
  readonly rounds: number;
  readonly round: number;
}

export async function createRenderService(options: RenderServiceOptions): Promise<RenderService> {
  const queue: RenderQueue = new RenderQueue({
    root: options.root,
    newId,
    ...(options.onChange !== undefined ? { onChange: options.onChange } : {}),
    run: async ({ job, documentJson, compareJson, report, isCancelled }) => {
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
        const renderOne = (side: RenderSide) => renderDocument({
          documentText: side.text,
          projectPath: side.projectPath,
          size: preset.size ?? undefined,
          seconds: side.seconds,
          codec: preset.codec,
          motionBlur: job.motionBlur ?? undefined,
          supersample: job.supersample,
          range: job.range ?? undefined,
          audioMix: side.audioMix,
          outputPath: side.outputPath,
          workDir: side.workDir,
          cacheRoot: typeof options.cacheRoot === 'function' ? options.cacheRoot() : options.cacheRoot,
          videoCacheRoot: typeof options.videoCacheRoot === 'function' ? options.videoCacheRoot() : options.videoCacheRoot,
          name: 'job',
          signal: controller.signal,
          onProgress: (progress) => {
            // An A/B job is two renders of the same length under one bar.
            tracker ??= new ProgressTracker({ total: progress.total * side.rounds, now: () => performance.now() });
            tracker.update(progress.encoded + side.round * progress.total);
            report(tracker.snapshot);
          },
        });
        const workDir = join(options.workRoot, job.id);
        if (compareJson !== undefined) {
          const compare = job.compare;
          if (compare === undefined) throw new Error('This A/B job has lost the project it compares with.');
          const seconds = comparisonTicks(loadDocument(documentJson).document, loadDocument(compareJson).document) / TICKS_PER_SECOND;
          const compareRun = async () => {
            const support = (await probeCodecs(FFMPEG_EXE))[preset.codec];
            return renderComparison({
              ffmpegExe: FFMPEG_EXE,
              ffprobeExe: FFPROBE_EXE,
              settings: { ...defaultEncodeSettings(preset.codec), encoder: support.encoder },
              outputPath: job.outputPath,
              workDir,
              labels: { left: job.label, right: compare.label },
              signal: controller.signal,
              renderSide: (side, outputPath) => renderOne({
                ...(side === 'left'
                  ? { text: documentJson, projectPath: job.projectPath, audioMix: job.audioMix ?? 'full', round: 0 }
                  // Only the left side's sound reaches the file, so the right renders plain.
                  : { text: compareJson, projectPath: compare.projectPath, audioMix: 'full', round: 1 }),
                outputPath,
                workDir: join(workDir, side),
                seconds,
                rounds: 2,
              }),
            });
          };
          const compared = options.gpu === undefined
            ? await compareRun()
            : await options.gpu.run('render', job.label, compareRun, controller.signal);
          tracker ??= new ProgressTracker({ total: compared.frames * 2, now: () => performance.now() });
          tracker.update(compared.frames * 2);
          report(tracker.snapshot);
          await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
          return { reportPath: compared.reportPath };
        }
        const render = () => renderOne({ text: documentJson, projectPath: job.projectPath, outputPath: job.outputPath, workDir, audioMix: job.audioMix ?? 'full', seconds: undefined, rounds: 1, round: 0 });
        const result = options.gpu === undefined
          ? await render()
          : await options.gpu.run('render', job.label, render, controller.signal);
        if (!result.report.verification.ok) {
          throw new Error(`The rendered file failed verification: ${result.report.verification.issues.join('; ')}`);
        }
        // The last progress line the child printed is throttled and usually short of the end, so
        // a finished job would otherwise show "50/120" for ever. The frame count is now known.
        tracker ??= new ProgressTracker({ total: result.frames, now: () => performance.now() });
        tracker.update(result.frames);
        report(tracker.snapshot);
        // Scratch for this render alone; a failed job keeps its own, to retry and to read.
        await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
        return { reportPath: result.reportPath };
      } finally {
        clearInterval(poll);
      }
    },
  });
  await queue.load();
  await sweepWork(options.workRoot, new Set(queue.list().filter((job) => job.status !== 'done').map((job) => job.id)));

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
      const compare = request.compare;
      const other = compare === undefined ? undefined : loadDocument(compare.text).document;
      if (other !== undefined && other.audio.path === '') throw new RenderRequestError(`${compare?.label ?? 'The other project'} has no audio, so there is nothing to render it to.`);
      const job = await queue.enqueue({
        document,
        ...(other === undefined || compare === undefined ? {} : {
          compare: { document: comparisonDocument(document, other), projectPath: compare.projectPath, label: compare.label },
        }),
        projectPath: request.projectPath,
        aspect: aspectBucket(size.width, size.height),
        presetName: preset.id,
        motionBlur: request.motionBlur ?? null,
        ...(request.supersample === 2 ? { supersample: 2 as const } : {}),
        range: request.range ?? null,
        ...(request.audioMix === undefined ? {} : { audioMix: request.audioMix }),
        outputPath: request.outputPath,
        label: `${document.name} — ${preset.label}${request.range == null ? '' : ` · ${clock(request.range.inTicks)}–${clock(request.range.outTicks)}`}${request.motionBlur == null ? '' : ' · motion blur'}${request.supersample === 2 ? ' · 2× supersampled' : ''}${request.audioMix === 'instrumental' ? ' · karaoke' : ''}${compare === undefined ? '' : ` · A/B with ${compare.label}`}`,
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
      while (queue.pending.length > 0 && !queue.isHeld) {
        await queue.drain();
        if (queue.pending.length > 0 && !queue.isHeld) await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
  };
}
