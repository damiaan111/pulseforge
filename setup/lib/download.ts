import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { SetupError } from './errors.ts';

export interface DownloadReporter {
  info(text: string): void;
  warn(text: string): void;
  detail(text: string): void;
  progress(text: string): void;
  endProgress(): void;
}

export interface DownloadRequest {
  step: string;
  label: string;
  url: string;
  dest: string;
  sha256?: string;
  /** Accept any file whose SHA-256 starts with this (see manifest.ts FileArtefact). */
  sha256Prefix?: string;
  expectedSize?: number;
  /** Take the file from this folder instead of the network (offline install / repair). */
  fromDir?: string;
  retries?: number;
  retryDelaysMs?: readonly number[];
  idleTimeoutMs?: number;
}

export interface DownloadResult {
  sha256: string;
  bytes: number;
  source: 'cached' | 'local-copy' | 'downloaded';
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function sizeOf(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function checksumMatches(actual: string, request: DownloadRequest): boolean {
  if (request.sha256 !== undefined) return actual === request.sha256.toLowerCase();
  return request.sha256Prefix !== undefined && actual.startsWith(request.sha256Prefix.toLowerCase());
}

function expectedChecksum(request: DownloadRequest): string {
  return request.sha256 ?? `${request.sha256Prefix ?? '?'}… (prefix)`;
}

/**
 * Makes sure `dest` exists and matches its pinned checksum.
 * Resumes partial downloads (`dest.part`), retries transient failures, and never
 * leaves a file that failed verification at `dest`.
 */
export async function ensureDownloaded(request: DownloadRequest, reporter: DownloadReporter): Promise<DownloadResult> {
  if (request.sha256 === undefined && request.sha256Prefix === undefined) {
    throw new Error(`No checksum pinned for ${request.label}; refusing to download unverified files`);
  }
  await mkdir(dirname(request.dest), { recursive: true });

  const existing = await sizeOf(request.dest);
  if (existing !== undefined) {
    const actual = await sha256File(request.dest);
    if (checksumMatches(actual, request)) return { sha256: actual, bytes: existing, source: 'cached' };
    reporter.warn(`${basename(request.dest)} is present but does not match its pinned checksum; replacing it.`);
    await rm(request.dest, { force: true });
  }

  const part = `${request.dest}.part`;

  if (request.fromDir !== undefined) {
    const candidate = join(request.fromDir, basename(request.dest));
    if ((await sizeOf(candidate)) === undefined) {
      throw new SetupError({
        step: request.step,
        what: `${request.label}: ${basename(request.dest)} was not found in the --from folder.`,
        likelyCause: `--from was given, so setup will not reach the network for this file. Looked for: ${candidate}`,
        fix: [
          `Put ${basename(request.dest)} in ${request.fromDir} (the exact file name matters).`,
          `It is available from ${request.url}`,
          'Or run without --from to download it.',
        ],
      });
    }
    reporter.info(`Using local copy: ${candidate}`);
    await copyFile(candidate, part);
    return finalise(request, part, 'local-copy');
  }

  await downloadWithRetries(request, part, reporter);
  return finalise(request, part, 'downloaded');
}

async function finalise(request: DownloadRequest, part: string, source: DownloadResult['source']): Promise<DownloadResult> {
  const actual = await sha256File(part);
  if (!checksumMatches(actual, request)) {
    await rm(part, { force: true });
    const fromLocal = source === 'local-copy';
    throw new SetupError({
      step: request.step,
      what: `${request.label}: the ${fromLocal ? 'local copy' : 'downloaded file'} does not match the pinned SHA-256.`,
      likelyCause: fromLocal
        ? `The file in the --from folder is not the pinned build. Expected ${expectedChecksum(request)}, got ${actual}.`
        : `The download was corrupted, or the file was replaced upstream. Expected ${expectedChecksum(request)}, got ${actual}.`,
      fix: fromLocal
        ? ['Replace the file in the --from folder with the exact pinned build, or run without --from.']
        : [
            'Re-run `npm run setup`. The bad file has been deleted, so it downloads fresh.',
            'If it fails the same way twice, the file changed upstream. Do not bypass the check: confirm the new file is legitimate, then update the pin in setup/manifest.ts on purpose.',
          ],
    });
  }
  await rename(part, request.dest);
  const bytes = (await sizeOf(request.dest)) ?? 0;
  return { sha256: actual, bytes, source };
}

async function downloadWithRetries(request: DownloadRequest, part: string, reporter: DownloadReporter): Promise<void> {
  const retries = request.retries ?? 4;
  const delays = request.retryDelaysMs ?? [2_000, 5_000, 15_000, 30_000];
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await downloadOnce(request, part, reporter);
      return;
    } catch (error) {
      reporter.endProgress();
      if (error instanceof SetupError) throw error;
      lastError = error;
      reporter.detail(`${request.label}: attempt ${attempt + 1} failed: ${describeError(error)}`);
      if (attempt < retries) {
        const delay = delays[Math.min(attempt, delays.length - 1)] ?? 5_000;
        reporter.warn(
          `${request.label}: ${describeError(error)}. Retrying in ${Math.round(delay / 1000)} s ` +
            `(attempt ${attempt + 2} of ${retries + 1}); what was already downloaded is kept.`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw new SetupError({
    step: request.step,
    what: `${request.label}: download failed after ${retries + 1} attempts (${describeError(lastError)}).`,
    likelyCause: 'No internet connection, a proxy or firewall blocking the host, or the server being temporarily unavailable.',
    fix: [
      `Check that ${new URL(request.url).host} is reachable from this machine (open the URL below in a browser).`,
      'Re-run `npm run setup`. The partial download is kept and resumes where it stopped.',
      `Or download ${request.url} yourself, put it in a folder, and run \`npm run setup -- --from <that folder>\`.`,
    ],
  });
}

async function downloadOnce(request: DownloadRequest, part: string, reporter: DownloadReporter): Promise<void> {
  let offset = (await sizeOf(part)) ?? 0;
  if (request.expectedSize !== undefined) {
    if (offset > request.expectedSize) {
      await rm(part, { force: true });
      offset = 0;
    } else if (offset === request.expectedSize) {
      return; // complete from an earlier run; the checksum decides
    }
  }

  const idleTimeoutMs = request.idleTimeoutMs ?? 60_000;
  const controller = new AbortController();
  let idleTimer: NodeJS.Timeout | undefined;
  const armIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => controller.abort(new Error(`no data received for ${Math.round(idleTimeoutMs / 1000)} s`)),
      idleTimeoutMs,
    );
  };

  try {
    armIdleTimer();
    const headers: Record<string, string> = { 'User-Agent': 'pulseforge-setup' };
    if (offset > 0) headers['Range'] = `bytes=${offset}-`;
    const response = await fetch(request.url, { headers, signal: controller.signal, redirect: 'follow' });

    if (response.status === 404 || response.status === 410) {
      throw new SetupError({
        step: request.step,
        what: `${request.label}: the pinned file is no longer available upstream (HTTP ${response.status}).`,
        likelyCause: 'The host removed this exact build. BtbN in particular prunes dated FFmpeg autobuilds after some weeks.',
        fix: [
          `If you have the file from an earlier install, copy it into ${dirname(request.dest)} or pass its folder with --from <dir>.`,
          'Otherwise pick a new build, verify its published checksum, and update the pin in setup/manifest.ts. That is a deliberate change: renders may differ.',
        ],
      });
    }
    if (response.status === 416) {
      await rm(part, { force: true });
      throw new Error('server rejected the resume position; restarting from zero');
    }
    if (!response.ok) {
      const permanent = response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429;
      if (permanent) {
        throw new SetupError({
          step: request.step,
          what: `${request.label}: the server refused the download (HTTP ${response.status} ${response.statusText}).`,
          likelyCause: 'Access to the host is blocked (proxy or firewall), or the URL in setup/manifest.ts is wrong.',
          fix: [`Open ${request.url} in a browser on this machine to see what the server says.`],
        });
      }
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    if (response.body === null) throw new Error('empty response body');

    let append = offset > 0 && response.status === 206;
    if (offset > 0 && !append) {
      reporter.detail(`${request.label}: server ignored the Range header; restarting from zero`);
      offset = 0;
      append = false;
    }

    const lengthHeader = response.headers.get('content-length');
    const total = lengthHeader !== null ? offset + Number(lengthHeader) : request.expectedSize;
    const out = createWriteStream(part, { flags: append ? 'a' : 'w' });
    const outError = once(out, 'error').then(([error]) => {
      throw error;
    });
    outError.catch(() => {}); // surfaced through the race below

    let received = offset;
    let windowStart = Date.now();
    let windowBytes = 0;
    let lastReport = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), outError]);
        if (done) break;
        armIdleTimer();
        received += value.byteLength;
        windowBytes += value.byteLength;
        if (!out.write(value)) await Promise.race([once(out, 'drain'), outError]);

        const now = Date.now();
        if (now - lastReport >= 500) {
          const rate = windowBytes / Math.max((now - windowStart) / 1000, 0.001);
          reporter.progress(progressLine(request.label, received, total, rate));
          lastReport = now;
          if (now - windowStart > 5_000) {
            windowStart = now;
            windowBytes = 0;
          }
        }
      }
    } finally {
      out.end();
      await once(out, 'close');
      reporter.endProgress();
    }

    if (total !== undefined && received < total) {
      throw new Error(`connection closed early (${received} of ${total} bytes)`);
    }
  } finally {
    clearTimeout(idleTimer);
  }
}

function progressLine(label: string, received: number, total: number | undefined, bytesPerSecond: number): string {
  const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
  const rate = `${mb(bytesPerSecond)} MB/s`;
  if (total === undefined || total === 0) return `${label}: ${mb(received)} MB  ${rate}`;
  const pct = ((received / total) * 100).toFixed(1);
  return `${label}: ${pct}%  ${mb(received)} / ${mb(total)} MB  ${rate}`;
}

export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause as { code?: string; message?: string } | undefined;
  if (cause?.code !== undefined) return `${error.message} (${cause.code})`;
  if (cause?.message !== undefined) return `${error.message}: ${cause.message}`;
  return error.message;
}
