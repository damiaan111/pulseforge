import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureDownloaded, type DownloadReporter, type DownloadRequest } from '../../setup/lib/download.ts';
import { SetupError } from '../../setup/lib/errors.ts';

const PAYLOAD = Buffer.from(Array.from({ length: 256 * 1024 }, (_, i) => (i * 31) % 251));
const PAYLOAD_SHA = createHash('sha256').update(PAYLOAD).digest('hex');

interface ServerBehaviour {
  status?: number;
  ignoreRange?: boolean;
  /** Cut the connection after this many bytes on the first request. */
  dropAfterBytes?: number;
  body?: Buffer;
}

let dir: string;
let server: Server;
let baseUrl: string;
let behaviour: ServerBehaviour;
let requests: Array<{ range: string | undefined }>;

const quiet: DownloadReporter = { info() {}, warn() {}, detail() {}, progress() {}, endProgress() {} };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pulseforge-download-'));
  behaviour = {};
  requests = [];
  server = createServer((req, res) => {
    requests.push({ range: req.headers.range });
    const body = behaviour.body ?? PAYLOAD;
    if (behaviour.status !== undefined) {
      res.writeHead(behaviour.status).end();
      return;
    }
    const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
    if (range?.[1] !== undefined && !behaviour.ignoreRange) {
      const start = Number(range[1]);
      res.writeHead(206, { 'Content-Length': body.length - start, 'Content-Range': `bytes ${start}-${body.length - 1}/${body.length}` });
      res.end(body.subarray(start));
      return;
    }
    res.writeHead(200, { 'Content-Length': body.length });
    if (behaviour.dropAfterBytes !== undefined && requests.length === 1) {
      res.write(body.subarray(0, behaviour.dropAfterBytes), () => res.destroy());
      return;
    }
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

function request(overrides: Partial<DownloadRequest> = {}): DownloadRequest {
  return {
    step: 'test',
    label: 'payload',
    url: `${baseUrl}/payload.bin`,
    dest: join(dir, 'payload.bin'),
    sha256: PAYLOAD_SHA,
    expectedSize: PAYLOAD.length,
    retries: 2,
    retryDelaysMs: [0],
    ...overrides,
  };
}

describe('ensureDownloaded', () => {
  it('downloads and verifies a file', async () => {
    const result = await ensureDownloaded(request(), quiet);
    expect(result).toEqual({ sha256: PAYLOAD_SHA, bytes: PAYLOAD.length, source: 'downloaded' });
    expect(await readFile(join(dir, 'payload.bin'))).toEqual(PAYLOAD);
    expect(existsSync(join(dir, 'payload.bin.part'))).toBe(false);
  });

  it('does not re-download a file that already verifies', async () => {
    await writeFile(join(dir, 'payload.bin'), PAYLOAD);
    const result = await ensureDownloaded(request(), quiet);
    expect(result.source).toBe('cached');
    expect(requests).toHaveLength(0);
  });

  it('resumes a partial download with a Range request', async () => {
    await writeFile(join(dir, 'payload.bin.part'), PAYLOAD.subarray(0, 100_000));
    await ensureDownloaded(request(), quiet);
    expect(requests[0]?.range).toBe('bytes=100000-');
    expect(await readFile(join(dir, 'payload.bin'))).toEqual(PAYLOAD);
  });

  it('recovers from a dropped connection by resuming', async () => {
    behaviour.dropAfterBytes = 50_000;
    await ensureDownloaded(request(), quiet);
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(requests[1]?.range).toMatch(/^bytes=\d+-$/);
    expect(await readFile(join(dir, 'payload.bin'))).toEqual(PAYLOAD);
  });

  it('restarts cleanly when the server ignores Range', async () => {
    behaviour.ignoreRange = true;
    await writeFile(join(dir, 'payload.bin.part'), PAYLOAD.subarray(0, 100_000));
    await ensureDownloaded(request(), quiet);
    expect(await readFile(join(dir, 'payload.bin'))).toEqual(PAYLOAD);
  });

  it('rejects a checksum mismatch, deletes the file and explains', async () => {
    behaviour.body = Buffer.from(PAYLOAD).fill(7, 0, 10);
    const error = await ensureDownloaded(request(), quiet).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SetupError);
    expect((error as SetupError).what).toMatch(/does not match the pinned SHA-256/);
    expect((error as SetupError).fix.length).toBeGreaterThan(0);
    expect(existsSync(join(dir, 'payload.bin'))).toBe(false);
    expect(existsSync(join(dir, 'payload.bin.part'))).toBe(false);
  });

  it('replaces an existing file that no longer verifies', async () => {
    await writeFile(join(dir, 'payload.bin'), Buffer.from('tampered'));
    const result = await ensureDownloaded(request(), quiet);
    expect(result.source).toBe('downloaded');
    expect(await readFile(join(dir, 'payload.bin'))).toEqual(PAYLOAD);
  });

  it('reports a pruned upstream file (404) with recovery steps, without retrying', async () => {
    behaviour.status = 404;
    const error = await ensureDownloaded(request(), quiet).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SetupError);
    expect((error as SetupError).what).toMatch(/no longer available upstream/);
    expect(requests).toHaveLength(1);
  });

  it('gives up on persistent server errors with a network diagnosis', async () => {
    behaviour.status = 503;
    const error = await ensureDownloaded(request(), quiet).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SetupError);
    expect((error as SetupError).what).toMatch(/failed after 3 attempts/);
    expect(requests).toHaveLength(3);
  });

  it('accepts a SHA-256 prefix pin and returns the full hash', async () => {
    const prefixOnly = request({ sha256Prefix: PAYLOAD_SHA.slice(0, 8) });
    delete prefixOnly.sha256;
    const result = await ensureDownloaded(prefixOnly, quiet);
    expect(result.sha256).toBe(PAYLOAD_SHA);
  });

  it('takes the file from --from without touching the network', async () => {
    const local = await mkdtemp(join(tmpdir(), 'pulseforge-from-'));
    try {
      await writeFile(join(local, 'payload.bin'), PAYLOAD);
      const result = await ensureDownloaded(request({ fromDir: local }), quiet);
      expect(result.source).toBe('local-copy');
      expect(requests).toHaveLength(0);
    } finally {
      await rm(local, { recursive: true, force: true });
    }
  });

  it('refuses to fall back to the network when --from lacks the file', async () => {
    const error = await ensureDownloaded(request({ fromDir: dir }), quiet).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SetupError);
    expect(requests).toHaveLength(0);
  });

  it('refuses to download without a pinned checksum', async () => {
    const unpinned = request();
    delete unpinned.sha256;
    await expect(ensureDownloaded(unpinned, quiet)).rejects.toThrow(/No checksum pinned/);
  });
});
