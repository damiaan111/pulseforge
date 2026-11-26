// Rotating structured logs (M34): JSON lines, level filtering, size rotation keeping N files, the
// tail across a rotation, and a log that cannot be written never throwing into the caller.

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Logger, splitScope } from '../../src/shell/logger.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pf-logs-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const fixed = () => new Date('2026-09-25T12:00:00.000Z');

describe('the log', () => {
  it('writes one JSON object per line, and filters by level', async () => {
    const log = new Logger({ dir, level: 'info', now: fixed });
    log.info('studio', 'opened', { layers: 3 });
    log.debug('studio', 'not written at info');
    log.error('render', 'failed', new Error('boom'));
    const lines = (await readFile(log.path, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => [l['level'], l['scope'], l['msg']])).toEqual([['info', 'studio', 'opened'], ['error', 'render', 'failed']]);
    expect(lines[0]).toMatchObject({ t: '2026-09-25T12:00:00.000Z', data: { layers: 3 } });
    expect((lines[1]!['data'] as { message: string }).message).toBe('boom');
    log.setLevel('debug');
    log.debug('studio', 'now it is');
    expect(log.tail(1)[0]!.msg).toBe('now it is');
  });

  it('rotates by size, keeping N files, and the tail reads across the rotation', async () => {
    const log = new Logger({ dir, level: 'info', maxBytes: 200, keep: 3, now: fixed });
    for (let i = 0; i < 20; i += 1) log.info('x', `line ${i}`);
    const files = (await readdir(dir)).sort();
    expect(files).toEqual(['pulseforge.1.log', 'pulseforge.2.log', 'pulseforge.log']);
    const tail = log.tail(4).map((e) => e.msg);
    expect(tail).toEqual(['line 16', 'line 17', 'line 18', 'line 19']);
  });

  it('keeps a line that is not JSON as text, and never throws when it cannot write', async () => {
    const log = new Logger({ dir, now: fixed });
    await writeFile(log.path, 'plain text from somewhere\n');
    expect(log.tail(5)[0]).toMatchObject({ scope: 'raw', msg: 'plain text from somewhere' });
    // A file where the log directory should be: every write fails, none throws.
    const blocked = new Logger({ dir: join(dir, 'pulseforge.log', 'nested') });
    expect(() => blocked.error('x', 'y')).not.toThrow();
  });

  it('splits a "[scope] message" line', () => {
    expect(splitScope('[render-queue] could not start: x', 'main')).toEqual({ scope: 'render-queue', msg: 'could not start: x' });
    expect(splitScope('no tag here', 'main')).toEqual({ scope: 'main', msg: 'no tag here' });
  });
});

describe('copy diagnostics', () => {
  it('puts the environment, a failed job, settings, the cache and the log tail in one text', async () => {
    const { buildDiagnostics } = await import('../../src/shell/diagnostics.ts');
    const text = buildDiagnostics({
      generatedAt: '2026-09-25T12:00:00.000Z',
      environment: { appVersion: '0.0.0', platform: 'win32', vendor: { ffmpeg: { present: true } } },
      gpu: 'NVIDIA GeForce RTX 3060',
      settings: { logLevel: 'info', cacheCeilingGb: 20 },
      cache: { root: 'D:/cache', totalBytes: 2e9, freeBytes: 3.5e11, units: 12 },
      job: { id: 'J1', label: 'Song 16:9', status: 'failed', error: 'NVENC refused\nTry: update the driver', outputPath: 'D:/out.mp4', reportPath: null, startedAt: '2026-09-25T11:00:00Z', finishedAt: null },
      logPath: 'C:/logs/pulseforge.log',
      log: [{ t: '2026-09-25T11:59:00.000Z', level: 'error', scope: 'render', msg: 'failed' }],
    });
    expect(text).toContain('# Pulseforge diagnostics — 2026-09-25T12:00:00.000Z');
    expect(text).toContain('gpu: NVIDIA GeForce RTX 3060');
    expect(text).toContain('## Render job J1');
    expect(text).toContain('  Try: update the driver');
    expect(text).toContain('size: 2.00 GB in 12 items');
    expect(text).toContain('"scope":"render"');
  });
});
