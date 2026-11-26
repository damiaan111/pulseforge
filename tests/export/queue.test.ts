import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDocument } from '../../src/project/create.ts';
import { ProgressTracker, formatDuration } from '../../src/export/progress.ts';
import { RenderQueue, isTerminal, type JobContext, type JobRunner } from '../../src/export/queue.ts';

let root: string;
let ids = 0;
let clock = 0;

const newId = () => `job${String(ids++).padStart(3, '0')}`;
const now = () => `2026-09-15T00:00:${String(clock++).padStart(2, '0')}.000Z`;

function makeQueue(run: JobRunner, onChange?: (jobs: readonly unknown[]) => void): RenderQueue {
  ids = 0;
  clock = 0;
  return new RenderQueue({ root, run, newId, now, ...(onChange === undefined ? {} : { onChange }) });
}

const request = (overrides: Record<string, unknown> = {}) => ({
  document: createDocument({ name: 'Song' }),
  aspect: '16:9',
  presetName: 'youtube-1080p60',
  outputPath: join(root, 'out.mp4'),
  ...overrides,
});

/** A runner that just succeeds, recording the order it saw. */
function recordingRunner(seen: string[]): JobRunner {
  return async (context) => {
    seen.push(context.job.id);
    return {};
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pulseforge-queue-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('ProgressTracker', () => {
  it('measures over a window, so an early slow patch stops counting', () => {
    let t = 0;
    // 2000 frames so the run is still in progress at the end — an ETA needs remaining work.
    const tracker = new ProgressTracker({ total: 2000, now: () => t, windowMs: 10_000 });

    // 10 s of crawling: 10 frames.
    t = 10_000;
    tracker.update(10);
    // Then 10 s at 100 fps.
    for (let i = 1; i <= 10; i += 1) {
      t = 10_000 + i * 1000;
      tracker.update(10 + i * 100);
    }
    const snapshot = tracker.snapshot;
    // A cumulative average would say ~50 fps and roughly double the true remaining time.
    expect(snapshot.fps).toBeGreaterThan(90);
    expect(snapshot.fps).toBeLessThan(110);
    // ~1000 frames left at ~100 fps ≈ 10 s. A cumulative average would say ~20 s.
    expect(snapshot.etaMs).toBeGreaterThan(8_000);
    expect(snapshot.etaMs).toBeLessThan(12_000);
  });

  it('ignores a frame count that goes backwards', () => {
    let t = 0;
    const tracker = new ProgressTracker({ total: 100, now: () => t });
    t = 1000;
    tracker.update(50);
    t = 2000;
    // FFmpeg's progress stream can repeat; a backwards jump would give a negative rate.
    tracker.update(20);
    expect(tracker.snapshot.frame).toBe(50);
    expect(tracker.snapshot.fps).toBeGreaterThan(0);
  });

  it('has no ETA until there is a rate, and none at the end', () => {
    let t = 0;
    const tracker = new ProgressTracker({ total: 100, now: () => t });
    expect(tracker.snapshot.etaMs).toBeUndefined();
    t = 1000;
    tracker.update(100);
    expect(tracker.snapshot.fraction).toBe(1);
    expect(tracker.snapshot.etaMs).toBeUndefined();
  });

  it('clamps to the total rather than reporting more frames than exist', () => {
    let t = 0;
    const tracker = new ProgressTracker({ total: 10, now: () => t });
    t = 100;
    tracker.update(999);
    expect(tracker.snapshot.frame).toBe(10);
  });

  it('formats durations the way a progress line wants', () => {
    expect(formatDuration(12_000)).toBe('12s');
    expect(formatDuration(252_000)).toBe('4m 12s');
    expect(formatDuration(3_852_000)).toBe('1h 04m 12s');
    expect(formatDuration(undefined)).toBe('—');
  });
});

describe('RenderQueue', () => {
  it('snapshots the document at enqueue, so later edits cannot change the output', async () => {
    const queue = makeQueue(async () => ({}));
    const document = createDocument({ name: 'Original' });
    const job = await queue.enqueue(request({ document }));

    // The live document changes afterwards — as it would while a render waits its turn.
    const edited = { ...document, name: 'Edited', seed: 999 };
    expect(edited.name).not.toBe(document.name);

    const snapshot = JSON.parse(await readFile(job.snapshotPath, 'utf8')) as { name: string };
    expect(snapshot.name).toBe('Original');
    expect(job.snapshotHash).toHaveLength(64);
  });

  it('runs jobs one at a time, in order', async () => {
    const seen: string[] = [];
    const queue = makeQueue(recordingRunner(seen));
    await queue.enqueue(request());
    await queue.enqueue(request());
    await queue.enqueue(request());
    await queue.drain();

    expect(seen).toEqual(['job000', 'job001', 'job002']);
    expect(queue.list().every((job) => job.status === 'done')).toBe(true);
    expect(queue.pending).toHaveLength(0);
  });

  it('never runs two jobs at once, even if drain is called twice', async () => {
    let running = 0;
    let overlapped = false;
    const queue = makeQueue(async () => {
      running += 1;
      if (running > 1) overlapped = true;
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return {};
    });
    await queue.enqueue(request());
    await queue.enqueue(request());

    // Two callers press Render; they must share one drain, not race for the GPU.
    await Promise.all([queue.drain(), queue.drain()]);
    expect(overlapped).toBe(false);
    expect(queue.list().every((job) => job.status === 'done')).toBe(true);
  });

  it('one failing job does not stop the batch', async () => {
    const seen: string[] = [];
    const queue = makeQueue(async (context) => {
      seen.push(context.job.id);
      if (context.job.id === 'job001') throw new Error('encoder unavailable');
      return {};
    });
    await queue.enqueue(request());
    await queue.enqueue(request());
    await queue.enqueue(request());
    await queue.drain();

    // An overnight batch must survive one bad project rather than wasting the night on it.
    expect(seen).toHaveLength(3);
    expect(queue.get('job001')!.status).toBe('failed');
    expect(queue.get('job001')!.error).toContain('encoder unavailable');
    expect(queue.get('job002')!.status).toBe('done');
  });

  it('cancelling a queued job skips it without running it', async () => {
    const seen: string[] = [];
    const queue = makeQueue(recordingRunner(seen));
    await queue.enqueue(request());
    const second = await queue.enqueue(request());
    await queue.cancel(second.id);
    await queue.drain();

    expect(seen).toEqual(['job000']);
    expect(queue.get(second.id)!.status).toBe('cancelled');
  });

  it('cancelling a running job is seen by the runner and recorded', async () => {
    let sawCancellation = false;
    const queue = makeQueue(async (context: JobContext) => {
      await queue.cancel(context.job.id);
      // The runner polls rather than being killed, so the encoder can close cleanly.
      sawCancellation = context.isCancelled();
      return {};
    });
    const job = await queue.enqueue(request());
    await queue.drain();

    expect(sawCancellation).toBe(true);
    expect(queue.get(job.id)!.status).toBe('cancelled');
  });

  it('reorders queued jobs', async () => {
    const seen: string[] = [];
    const queue = makeQueue(recordingRunner(seen));
    await queue.enqueue(request());
    const second = await queue.enqueue(request());
    await queue.move(second.id, 0);
    await queue.drain();
    expect(seen).toEqual(['job001', 'job000']);
  });

  it('pause stops after the running job and keeps the rest', async () => {
    const seen: string[] = [];
    const queue = makeQueue(async (context) => {
      seen.push(context.job.id);
      queue.pause();
      return {};
    });
    await queue.enqueue(request());
    await queue.enqueue(request());
    await queue.drain();

    expect(seen).toEqual(['job000']);
    expect(queue.get('job001')!.status).toBe('queued');

    // Draining again picks up where it left off.
    await queue.drain();
    expect(seen).toEqual(['job000', 'job001']);
  });

  it('retry puts a failed job back in line against the same snapshot', async () => {
    let attempts = 0;
    const queue = makeQueue(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('disk full');
      return {};
    });
    const job = await queue.enqueue(request());
    await queue.drain();
    expect(queue.get(job.id)!.status).toBe('failed');

    const snapshotBefore = job.snapshotPath;
    await queue.retry(job.id);
    expect(queue.get(job.id)!.status).toBe('queued');
    expect(queue.get(job.id)!.error).toBeNull();
    expect(queue.get(job.id)!.snapshotPath).toBe(snapshotBefore);

    await queue.drain();
    expect(queue.get(job.id)!.status).toBe('done');
  });

  it('progress reaches the change listener', async () => {
    const seenFractions: number[] = [];
    const queue = makeQueue(
      async (context) => {
        context.report({ frame: 50, total: 100, fraction: 0.5, fps: 60, etaMs: 833, elapsedMs: 833 });
        return {};
      },
      (jobs) => {
        const job = (jobs as { progress: { fraction: number } | null }[])[0];
        if (job?.progress) seenFractions.push(job.progress.fraction);
      },
    );
    await queue.enqueue(request());
    await queue.drain();
    expect(seenFractions).toContain(0.5);
  });

  it('removing a job deletes its snapshot', async () => {
    const queue = makeQueue(async () => ({}));
    const job = await queue.enqueue(request());
    expect(existsSync(job.snapshotPath)).toBe(true);
    await queue.remove(job.id);
    expect(existsSync(job.snapshotPath)).toBe(false);
    expect(queue.list()).toHaveLength(0);
  });

  it('clearFinished keeps what still matters', async () => {
    const queue = makeQueue(async () => ({}));
    await queue.enqueue(request());
    await queue.drain();
    const pendingJob = await queue.enqueue(request());
    await queue.clearFinished();
    expect(queue.list().map((job) => job.id)).toEqual([pendingJob.id]);
  });
});

describe('RenderQueue persistence', () => {
  it('survives a restart with its jobs intact', async () => {
    const first = makeQueue(async () => ({}));
    await first.enqueue(request({ document: createDocument({ name: 'A' }) }));
    await first.enqueue(request({ document: createDocument({ name: 'B' }) }));

    const reloaded = makeQueue(async () => ({}));
    await reloaded.load();
    expect(reloaded.list().map((job) => job.label)).toEqual(['A (16:9)', 'B (16:9)']);
    expect(reloaded.pending).toHaveLength(2);
  });

  it('keeps a job’s motion blur across a restart; a job without one is off (S10)', async () => {
    const first = makeQueue(async () => ({}));
    await first.enqueue(request({ motionBlur: { samples: 8, shutterDegrees: 180 } }));
    await first.enqueue(request());

    const reloaded = makeQueue(async () => ({}));
    await reloaded.load();
    expect(reloaded.list().map((job) => job.motionBlur)).toEqual([{ samples: 8, shutterDegrees: 180 }, null]);
  });

  it('a job that was running when the process died is interrupted, not silently restarted', async () => {
    const queue = makeQueue(async () => ({}));
    const job = await queue.enqueue(request());
    // Simulate the crash: the file says "running" because nothing wrote the end state.
    const file = JSON.parse(await readFile(queue.queueFilePath, 'utf8')) as { formatVersion: number; jobs: unknown[] };
    file.jobs = [{ ...(file.jobs[0] as Record<string, unknown>), status: 'running' }];
    await writeFile(queue.queueFilePath, JSON.stringify(file));

    const reloaded = makeQueue(async () => ({}));
    await reloaded.load();
    // Relaunching must not kick off a forty-minute 4K render nobody asked for.
    expect(reloaded.get(job.id)!.status).toBe('interrupted');
    expect(reloaded.get(job.id)!.error).toContain('stopped while this job was rendering');
    expect(isTerminal('interrupted')).toBe(true);

    await reloaded.retry(job.id);
    expect(reloaded.get(job.id)!.status).toBe('queued');
  });

  it('a corrupt queue file loses the queue, not the projects', async () => {
    const queue = makeQueue(async () => ({}));
    await queue.enqueue(request());
    await writeFile(queue.queueFilePath, '{ not json');

    const reloaded = makeQueue(async () => ({}));
    await expect(reloaded.load()).resolves.toBeUndefined();
    expect(reloaded.list()).toHaveLength(0);
  });

  it('an empty root loads cleanly', async () => {
    const queue = makeQueue(async () => ({}));
    await expect(queue.load()).resolves.toBeUndefined();
    expect(queue.list()).toHaveLength(0);
  });

  it('concurrent changes all persist, and the file ends up matching memory', async () => {
    // Enqueues racing each other used to share one temp file name; the second rename then failed.
    const queue = makeQueue(async () => ({}));
    await Promise.all(Array.from({ length: 12 }, (_, i) => queue.enqueue(request({ label: `job ${i}` }))));
    const onDisk = JSON.parse(await readFile(queue.queueFilePath, 'utf8')) as { jobs: unknown[] };
    expect(onDisk.jobs).toHaveLength(12);
    expect(queue.list()).toHaveLength(12);
  });
});
