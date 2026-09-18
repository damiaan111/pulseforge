// The global GPU job queue (M28): one heavy job at a time, renders first, models freed first.

import { describe, expect, it } from 'vitest';

import { GpuJobCancelledError, GpuQueue } from '../../src/node/gpu-queue.ts';

/** A job that waits until released, recording when it starts and finishes. */
function gate(log: string[], name: string) {
  let release!: () => void;
  const done = new Promise<void>((resolve) => { release = resolve; });
  return {
    release: () => release(),
    job: async () => {
      log.push(`start ${name}`);
      await done;
      log.push(`end ${name}`);
      return name;
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('GpuQueue', () => {
  it('runs one job at a time', async () => {
    const log: string[] = [];
    const queue = new GpuQueue();
    const a = gate(log, 'a');
    const b = gate(log, 'b');
    const pa = queue.run('ml', 'a', a.job);
    const pb = queue.run('ml', 'b', b.job);
    await tick();
    expect(log).toEqual(['start a']);
    a.release();
    await pa;
    await tick();
    expect(log).toEqual(['start a', 'end a', 'start b']);
    b.release();
    await expect(pb).resolves.toBe('b');
  });

  it('puts a waiting render ahead of waiting ML jobs, and never pre-empts the running one', async () => {
    const log: string[] = [];
    const queue = new GpuQueue();
    const first = gate(log, 'stems-1');
    const second = gate(log, 'stems-2');
    const render = gate(log, 'render');
    const p1 = queue.run('ml', 'stems-1', first.job);
    const p2 = queue.run('ml', 'stems-2', second.job);
    const pr = queue.run('render', 'render', render.job);
    await tick();
    expect(queue.pending.map((j) => j.label)).toEqual(['render', 'stems-2']);
    first.release();
    await p1;
    await tick();
    expect(log.at(-1)).toBe('start render');
    render.release();
    await pr;
    await tick();
    second.release();
    await p2;
    expect(log).toEqual(['start stems-1', 'end stems-1', 'start render', 'end render', 'start stems-2', 'end stems-2']);
  });

  it('frees the ML models before every render', async () => {
    const log: string[] = [];
    const queue = new GpuQueue({ beforeRender: async () => { log.push('free models'); } });
    await queue.run('ml', 'stems', async () => { log.push('stems'); });
    await queue.run('render', 'render', async () => { log.push('render'); });
    expect(log).toEqual(['stems', 'free models', 'render']);
  });

  it('a failing job does not stop the queue', async () => {
    const queue = new GpuQueue();
    const failing = queue.run('ml', 'bad', async () => { throw new Error('boom'); });
    const after = queue.run('ml', 'good', async () => 'ok');
    await expect(failing).rejects.toThrow('boom');
    await expect(after).resolves.toBe('ok');
    expect(queue.running).toBeNull();
  });

  it('a job cancelled while waiting never starts', async () => {
    const log: string[] = [];
    const queue = new GpuQueue();
    const blocker = gate(log, 'blocker');
    const running = queue.run('ml', 'blocker', blocker.job);
    const controller = new AbortController();
    const waiting = queue.run('ml', 'waiting', async () => { log.push('should not run'); }, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toBeInstanceOf(GpuJobCancelledError);
    blocker.release();
    await running;
    await tick();
    expect(log).toEqual(['start blocker', 'end blocker']);
  });
});
