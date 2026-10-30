import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDocument } from '../../src/project/create.ts';
import { DiskSpaceError, diskSpaceError, estimateOutputBytes, formatBytes, isDiskFullFailure, spaceProblem } from '../../src/export/disk-space.ts';
import { freeBytesAt } from '../../src/node/free-bytes.ts';
import { diagnoseEncoderFailure } from '../../src/export/encoder.ts';
import { RenderQueue, type JobRunner } from '../../src/export/queue.ts';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pulseforge-disk-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('estimateOutputBytes', () => {
  const fourMinutes = { width: 1920, height: 1080, frames: 14_400, fps: 60, audioBitrateKbps: 320 };

  it('covers the largest real render measured, 303 MB for a minute of 1080p60', () => {
    const minute = estimateOutputBytes({ ...fourMinutes, frames: 3600 });
    expect(minute).toBeGreaterThan(303e6);
    expect(minute).toBeLessThan(700e6);
  });

  it('grows with pixels and frames', () => {
    const base = estimateOutputBytes(fourMinutes);
    expect(estimateOutputBytes({ ...fourMinutes, width: 3840, height: 2160 })).toBeGreaterThan(3.5 * base);
    expect(estimateOutputBytes({ ...fourMinutes, frames: 28_800 })).toBeGreaterThan(1.9 * base);
  });

  it('counts the audio', () => {
    const silent = estimateOutputBytes({ ...fourMinutes, audioBitrateKbps: 0 });
    expect(estimateOutputBytes(fourMinutes) - silent).toBe(240 * 40_000);
  });
});

describe('freeBytesAt', () => {
  it('reads the drive of a path that does not exist yet', async () => {
    const free = await freeBytesAt(join(root, 'not', 'made', 'yet', 'video.mp4'));
    expect(free).toBeGreaterThan(0);
  });
});

describe('spaceProblem', () => {
  it('says how much is needed and how much there is', () => {
    expect(spaceProblem('D:\\v.mp4', 2.5e9, 800e6)).toBe('Not enough disk space for D:\\v.mp4: it could take up to 2.5 GB, and the drive has 800 MB free.');
  });

  it('passes a render that fits, and one whose drive cannot be read', () => {
    expect(spaceProblem('v.mp4', 1e9, 1e9)).toBeNull();
    expect(spaceProblem('v.mp4', 1e9, null)).toBeNull();
  });
});

describe('formatBytes', () => {
  it('reads as megabytes and gigabytes', () => {
    expect(formatBytes(1_200_001)).toBe('2 MB');
    expect(formatBytes(3.44e9)).toBe('3.4 GB');
  });
});

describe('a disk that fills during a render', () => {
  it('recognises the encoder diagnosis and the raw error', () => {
    expect(isDiskFullFailure(diagnoseEncoderFailure('av_interleaved_write_frame(): No space left on device') as string)).toBe(true);
    expect(isDiskFullFailure('write ENOSPC')).toBe(true);
    expect(isDiskFullFailure('NVENC could not start')).toBe(false);
  });
});

describe('the queue and the disk (export-spec §14: pause rather than corrupt)', () => {
  const make = (run: JobRunner) => {
    let id = 0;
    return new RenderQueue({ root, run, newId: () => `job${id++}`, now: () => '2026-10-30T00:00:00.000Z' });
  };
  const request = (name: string) => ({ document: createDocument({ name }), aspect: '16:9', presetName: 'p', outputPath: join(root, `${name}.mp4`) });

  it('holds the job and the jobs behind it, and carries on after a resume', async () => {
    const seen: string[] = [];
    let full = true;
    const queue = make(async ({ job }) => {
      seen.push(job.id);
      if (full) throw diskSpaceError('Not enough disk space.');
      return {};
    });
    await queue.enqueue(request('a'));
    await queue.enqueue(request('b'));
    await queue.drain();

    expect(seen).toEqual(['job0']);
    expect(queue.list().map((j) => j.status)).toEqual(['paused', 'queued']);
    expect(queue.get('job0')?.error).toBe('Not enough disk space.');
    expect(queue.isHeld).toBe(true);

    full = false;
    await queue.retry('job0');
    await queue.drain();
    expect(queue.list().map((j) => j.status)).toEqual(['done', 'done']);
    expect(queue.isHeld).toBe(false);
  });

  it('survives a restart, and a held job can be cancelled', async () => {
    const queue = make(async () => {
      throw new DiskSpaceError('full');
    });
    await queue.enqueue(request('a'));
    await queue.drain();

    const again = make(async () => ({}));
    await again.load();
    expect(again.get('job0')?.status).toBe('paused');
    await again.cancel('job0');
    expect(again.get('job0')?.status).toBe('cancelled');
  });

  it('leaves any other failure to fail, so the night goes on', async () => {
    const queue = make(async ({ job }) => {
      if (job.id === 'job0') throw new Error('shader');
      return {};
    });
    await queue.enqueue(request('a'));
    await queue.enqueue(request('b'));
    await queue.drain();
    expect(queue.list().map((j) => j.status)).toEqual(['failed', 'done']);
  });
});
