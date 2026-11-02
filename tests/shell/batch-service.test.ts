// The studio's batch runner (S13) with directing and queueing faked: each track is queued as soon as
// it is directed, a failure is marked and the batch carries on, cancel skips the rest, and the
// completion watcher fires once when everything is finished.

import { describe, expect, it } from 'vitest';

import type { BatchTrack } from '../../src/batch/plan.ts';
import { completionWatcher, createBatchService, type BatchStatus } from '../../src/shell/batch-service.ts';

const request = { tracks: ['m/A.wav', 'm/B.wav', 'm/C.wav'], outDir: 'out', presetId: 'youtube-1080p', templateId: null, seed: 1, stems: false, motionBlur: null };

function service(options: { fail?: string; gate?: Promise<void> } = {}) {
  const queued: string[] = [];
  const changes: BatchStatus[] = [];
  let n = 0;
  const batch = createBatchService({
    async directTrack(track: BatchTrack) {
      await options.gate;
      if (track.name === options.fail) throw new Error('could not decode');
      return { document: {} as never, templateName: 'Neon Pulse', summary: `${track.name} look`, notes: [], durationSeconds: 1 };
    },
    async enqueue(r) {
      queued.push(r.outputPath);
    },
    templateIds: async () => ['neon-pulse'],
    newId: () => `batch${n++}`,
    onChange: (s) => changes.push(s),
  });
  return { batch, queued, changes };
}

describe('batch service', () => {
  it('directs and queues every track in order, and finishes', async () => {
    const { batch, queued } = service();
    const first = await batch.start(request);
    expect(first.tracks.map((t) => t.state)).toEqual(['waiting', 'waiting', 'waiting']);
    await batch.settled();
    expect(queued).toEqual(['out/A - youtube-1080p.mp4', 'out/B - youtube-1080p.mp4', 'out/C - youtube-1080p.mp4']);
    expect(batch.status()).toMatchObject({ state: 'finished' });
    expect(batch.status()!.tracks.map((t) => t.detail)).toEqual(['A look', 'B look', 'C look']);
    expect(batch.busy()).toBe(false);
  });

  it('marks a track that fails, with why, and carries on', async () => {
    const { batch, queued } = service({ fail: 'B' });
    await batch.start(request);
    await batch.settled();
    expect(batch.status()!.tracks.map((t) => t.state)).toEqual(['queued', 'failed', 'queued']);
    expect(batch.status()!.tracks[1]!.detail).toBe('could not decode');
    expect(queued).toHaveLength(2);
  });

  it('cancel skips the tracks not yet started, and one batch runs at a time', async () => {
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const { batch } = service({ gate });
    await batch.start(request);
    await expect(batch.start(request)).rejects.toThrow(/already/);
    batch.cancel();
    open();
    await batch.settled();
    expect(batch.status()!.state).toBe('cancelled');
    expect(batch.status()!.tracks.map((t) => t.state)).toEqual(['queued', 'skipped', 'skipped']);
  });

  it('refuses a request it cannot run', async () => {
    const { batch } = service();
    await expect(batch.start({ ...request, tracks: [] })).rejects.toThrow(/at least one track/);
    await expect(batch.start({ ...request, outDir: '' })).rejects.toThrow(/output folder/);
    await expect(batch.start({ ...request, presetId: 'vhs' })).rejects.toThrow(/preset/);
    await expect(batch.start({ ...request, templateId: 'nope' })).rejects.toThrow(/template/);
    await expect(batch.start({ ...request, motionBlur: { samples: 99, shutterDegrees: 180 } })).rejects.toThrow(/samples/);
  });
});

describe('completionWatcher', () => {
  it('fires once when the work runs out, counting only what finished since', () => {
    const fired: { done: number; failed: number }[] = [];
    const watch = completionWatcher((s) => fired.push(s));
    // Last session's finished jobs are history, not a completion.
    watch.update([{ id: 'old', status: 'done' }], false);
    expect(fired).toEqual([]);
    watch.update([{ id: 'old', status: 'done' }, { id: 'a', status: 'running' }], false);
    // Directing still going: not finished even though the queue is momentarily idle.
    watch.update([{ id: 'old', status: 'done' }, { id: 'a', status: 'done' }], true);
    expect(fired).toEqual([]);
    watch.update([{ id: 'old', status: 'done' }, { id: 'a', status: 'done' }, { id: 'b', status: 'failed' }], false);
    expect(fired).toEqual([{ done: 1, failed: 1 }]);
    watch.update([{ id: 'old', status: 'done' }, { id: 'a', status: 'done' }, { id: 'b', status: 'failed' }], false);
    expect(fired).toHaveLength(1);
  });
});
