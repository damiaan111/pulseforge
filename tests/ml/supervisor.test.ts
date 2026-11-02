import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

import { LineSplitter, parseInbound, SIDECAR_PROTOCOL_VERSION } from '../../src/ml/protocol.ts';
import {
  SidecarCancelledError,
  SidecarRequestError,
  SidecarSupervisor,
  SidecarUnavailableError,
} from '../../src/ml/supervisor.ts';

/**
 * A stub sidecar in Node: it speaks the same JSON-lines protocol the Python one does, so the
 * supervisor's behaviour — restart, cancellation, crash handling, ordering — is testable without
 * Python, torch or a GPU. `script` is the stub's per-request behaviour.
 */
function stub(script: string, options: { protocol?: number; readyDelayMs?: number } = {}) {
  const source = `
    const protocol = ${options.protocol ?? SIDECAR_PROTOCOL_VERSION};
    const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
    setTimeout(() => send({ type: 'ready', protocol, pid: process.pid }), ${options.readyDelayMs ?? 0});
    let buffer = '';
    const cancelled = new Set();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (line.trim() === '') continue;
        const message = JSON.parse(line);
        if (message.type === 'shutdown') { process.exit(0); }
        if (message.type === 'cancel') { cancelled.add(message.id); continue; }
        (async (request) => { ${script} })(message);
      }
    });
  `;
  return () => spawn(process.execPath, ['-e', source], { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
}

let ids = 0;
const newId = () => `req${String(ids++).padStart(3, '0')}`;

const ECHO = `send({ type: 'result', id: request.id, data: { echoed: request.command, params: request.params } });`;

describe('protocol', () => {
  it('turns unrecognised output into a log rather than a failure', () => {
    // torch, CUDA and Demucs all write to stdout uninvited; a banner must not look like a bug.
    expect(parseInbound('Loading model...')).toEqual({ type: 'log', message: 'Loading model...' });
    expect(parseInbound('{"nope": 1}')).toEqual({ type: 'log', message: '{"nope": 1}' });
    expect(parseInbound('   ')).toBeUndefined();
  });

  it('requires an id on anything that belongs to a request', () => {
    expect(parseInbound('{"type":"result"}')!.type).toBe('log');
    expect(parseInbound('{"type":"result","id":"a","data":{"x":1}}')).toEqual({
      type: 'result',
      id: 'a',
      data: { x: 1 },
    });
  });

  it('splits lines across chunk boundaries', () => {
    const splitter = new LineSplitter();
    expect(splitter.push('{"a"')).toEqual([]);
    expect(splitter.push(':1}\n{"b":2}\n{"c"')).toEqual(['{"a":1}', '{"b":2}']);
    expect(splitter.flush()).toEqual(['{"c"']);
  });
});

describe('SidecarSupervisor', () => {
  it('starts, reports ready, and answers a request', async () => {
    const states: string[] = [];
    const supervisor = new SidecarSupervisor({
      spawn: stub(ECHO),
      newId,
      onStateChange: (state) => states.push(state),
    });
    const result = await supervisor.request('health', { deep: true });
    expect(result).toEqual({ echoed: 'health', params: { deep: true } });
    expect(supervisor.state).toBe('ready');
    expect(states).toContain('starting');
    await supervisor.stop();
    expect(supervisor.state).toBe('stopped');
  });

  it('keeps one process across many requests', async () => {
    // The point of supervising: ~4 s of Python start and model load is paid once, not per track.
    const supervisor = new SidecarSupervisor({ spawn: stub(ECHO), newId });
    await supervisor.request('health');
    const pid = supervisor.pid;
    await supervisor.request('health');
    await supervisor.request('health');
    expect(supervisor.pid).toBe(pid);
    await supervisor.stop();
  });

  it('runs requests one at a time', async () => {
    const supervisor = new SidecarSupervisor({
      spawn: stub(`
        send({ type: 'progress', id: request.id, fraction: 0.5, stage: 'working' });
        await new Promise((r) => setTimeout(r, 20));
        send({ type: 'result', id: request.id, data: { n: request.params.n } });
      `),
      newId,
    });
    const order: number[] = [];
    await Promise.all([
      supervisor.request('work', { n: 1 }).then((r) => order.push(r['n'] as number)),
      supervisor.request('work', { n: 2 }).then((r) => order.push(r['n'] as number)),
      supervisor.request('work', { n: 3 }).then((r) => order.push(r['n'] as number)),
    ]);
    // Serialised because the sidecar does one GPU job at a time (M28).
    expect(order).toEqual([1, 2, 3]);
    await supervisor.stop();
  });

  it('forwards progress to the request that asked for it', async () => {
    const supervisor = new SidecarSupervisor({
      spawn: stub(`
        send({ type: 'progress', id: request.id, fraction: 0.25, stage: 'separating' });
        send({ type: 'progress', id: request.id, fraction: 0.75 });
        send({ type: 'result', id: request.id, data: {} });
      `),
      newId,
    });
    const seen: { fraction?: number; stage?: string }[] = [];
    await supervisor.request('separate', {}, { onProgress: (p) => seen.push(p) });
    expect(seen).toEqual([{ fraction: 0.25, stage: 'separating' }, { fraction: 0.75 }]);
    await supervisor.stop();
  });

  it('reports a sidecar error as an error, with its type', async () => {
    const supervisor = new SidecarSupervisor({
      spawn: stub(`send({ type: 'error', id: request.id, errorType: 'CudaUnavailable', message: 'CUDA is not available to torch' });`),
      newId,
    });
    await expect(supervisor.request('separate')).rejects.toBeInstanceOf(SidecarRequestError);
    await expect(supervisor.request('separate')).rejects.toThrow(/CUDA is not available/);
    // The process is still usable: an error is not a crash.
    expect(supervisor.state).toBe('ready');
    await supervisor.stop();
  });

  it('a failed request does not poison the ones behind it', async () => {
    const supervisor = new SidecarSupervisor({
      spawn: stub(`
        if (request.params.fail) send({ type: 'error', id: request.id, errorType: 'Boom', message: 'nope' });
        else send({ type: 'result', id: request.id, data: { ok: true } });
      `),
      newId,
    });
    const failure = supervisor.request('work', { fail: true });
    const after = supervisor.request('work', { fail: false });
    await expect(failure).rejects.toThrow(/nope/);
    await expect(after).resolves.toEqual({ ok: true });
    await supervisor.stop();
  });

  it('cancellation asks the sidecar to stop and keeps the process alive', async () => {
    const supervisor = new SidecarSupervisor({
      spawn: stub(`
        // A long job that checks for cancellation, like apply_model's callback does.
        for (let i = 0; i < 100; i += 1) {
          await new Promise((r) => setTimeout(r, 5));
          if (cancelled.has(request.id)) { send({ type: 'cancelled', id: request.id }); return; }
        }
        send({ type: 'result', id: request.id, data: { finished: true } });
      `),
      newId,
    });
    const controller = new AbortController();
    const running = supervisor.request('separate', {}, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();

    await expect(running).rejects.toBeInstanceOf(SidecarCancelledError);
    // Killing the process would throw away a loaded model and any cleanup it owed.
    expect(supervisor.state).toBe('ready');
    await expect(supervisor.request('health')).resolves.toBeDefined();
    await supervisor.stop();
  });

  it('an already-aborted signal never reaches the sidecar', async () => {
    const supervisor = new SidecarSupervisor({ spawn: stub(ECHO), newId });
    const controller = new AbortController();
    controller.abort();
    await expect(supervisor.request('health', {}, { signal: controller.signal })).rejects.toBeInstanceOf(
      SidecarCancelledError,
    );
    await supervisor.stop();
  });

  it('a crash mid-request rejects it with the stderr tail rather than hanging', async () => {
    const supervisor = new SidecarSupervisor({
      spawn: stub(`
        process.stderr.write('Traceback (most recent call last):\\n  RuntimeError: out of memory\\n');
        process.exit(3);
      `),
      newId,
    });
    const error = await supervisor.request('separate').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SidecarUnavailableError);
    // Somebody is watching a progress bar: it must fail, and say why.
    expect((error as SidecarUnavailableError).stderrTail).toContain('out of memory');
    expect(supervisor.state).toBe('stopped');
  });

  it('restarts on the next request after a crash', async () => {
    let spawns = 0;
    const supervisor = new SidecarSupervisor({
      spawn: () => {
        spawns += 1;
        // The first process dies on its first request; the replacement works.
        const script = spawns === 1 ? `process.exit(1);` : ECHO;
        return stub(script)();
      },
      newId,
    });
    await expect(supervisor.request('health')).rejects.toBeInstanceOf(SidecarUnavailableError);
    await expect(supervisor.request('health')).resolves.toBeDefined();
    expect(spawns).toBe(2);
    await supervisor.stop();
  });

  it('refuses a sidecar speaking another protocol version', async () => {
    const supervisor = new SidecarSupervisor({ spawn: stub(ECHO, { protocol: 99 }), newId });
    const error = await supervisor.request('health').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SidecarUnavailableError);
    expect((error as Error).message).toContain('protocol 99');
    expect((error as SidecarUnavailableError).fixes.join(' ')).toContain('npm run setup');
  });

  it('gives up if the sidecar never reports ready', async () => {
    const supervisor = new SidecarSupervisor({
      spawn: stub(ECHO, { readyDelayMs: 10_000 }),
      newId,
      startTimeoutMs: 100,
    });
    const error = await supervisor.request('health').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SidecarUnavailableError);
    expect((error as Error).message).toContain('did not report ready');
  });

  it('shuts itself down when idle, to give the renderer its VRAM back', async () => {
    const states: string[] = [];
    const supervisor = new SidecarSupervisor({
      spawn: stub(ECHO),
      newId,
      idleTimeoutMs: 40,
      onStateChange: (state) => states.push(state),
    });
    await supervisor.request('health');
    expect(supervisor.state).toBe('ready');

    // Torch holds VRAM while loaded, and the renderer needs it (M28).
    await vi.waitFor(() => expect(supervisor.state).toBe('stopped'), { timeout: 5_000 });
    expect(states).toContain('stopping');

    // And it comes back on demand.
    await expect(supervisor.request('health')).resolves.toBeDefined();
    await supervisor.stop();
  });

  it('a request keeps the sidecar alive past its idle timeout', async () => {
    const supervisor = new SidecarSupervisor({
      spawn: stub(`await new Promise((r) => setTimeout(r, 120)); send({ type: 'result', id: request.id, data: {} });`),
      newId,
      idleTimeoutMs: 40,
    });
    await expect(supervisor.request('slow')).resolves.toBeDefined();
    expect(supervisor.state).toBe('ready');
    await supervisor.stop();
  });

  it('collects sidecar chatter as logs', async () => {
    const logs: string[] = [];
    const supervisor = new SidecarSupervisor({
      spawn: stub(`
        process.stdout.write('Selected model is a bag of 4 models\\n');
        send({ type: 'result', id: request.id, data: {} });
      `),
      newId,
      onLog: (message) => logs.push(message),
    });
    await supervisor.request('separate');
    expect(logs).toContain('Selected model is a bag of 4 models');
    await supervisor.stop();
  });

  it('stopping a supervisor that never started is harmless', async () => {
    const supervisor = new SidecarSupervisor({ spawn: stub(ECHO), newId });
    await expect(supervisor.stop()).resolves.toBeUndefined();
    expect(supervisor.state).toBe('stopped');
  });
});
