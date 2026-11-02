// Shared plumbing for the spike orchestrators: bundle the Electron side, run it, collect results.

import { STALL_TIMEOUT_MS, stallWatch } from '../src/export/stall.ts';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, type BuildOptions } from 'esbuild';
import electronPath from 'electron';
import { ROOT } from '../setup/lib/paths.ts';
import type { SpikeConfig } from './electron/protocol.ts';

export const SPIKE_OUT = join(ROOT, 'out', 'spike');

export function fail(what: string, fix: readonly string[]): never {
  console.error(`\n✖ ${what}\n\n  What to do:\n${fix.map((f, i) => `    ${i + 1}. ${f}`).join('\n')}\n`);
  process.exit(1);
}

/**
 * Puts `text` at `path` so that a reader sees the old file or the new one, never part of either.
 * Every test file bundles, while renders from other test files are loading these: a half-written
 * script is a page that dies without a word, and a render that waits for the watchdog. Renaming
 * over a file another process has open can fail for a moment on Windows, hence the retries.
 */
async function replaceFile(path: string, text: string): Promise<void> {
  if (await readFile(path, 'utf8').then((old) => old === text, () => false)) return;
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, text);
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(temporary, path);
      return;
    } catch (error) {
      if (attempt === 20) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

export async function bundleElectron(): Promise<void> {
  await mkdir(SPIKE_OUT, { recursive: true });
  const common: BuildOptions = { bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], sourcemap: 'linked', logLevel: 'error', write: false };
  const built = await Promise.all([
    build({ ...common, entryPoints: [join(ROOT, 'spike', 'electron', 'main.ts')], outfile: join(SPIKE_OUT, 'main.cjs') }),
    build({ ...common, entryPoints: [join(ROOT, 'spike', 'electron', 'renderer.ts')], outfile: join(SPIKE_OUT, 'renderer.js') }),
  ]);
  for (const { outputFiles } of built) for (const file of outputFiles ?? []) await replaceFile(file.path, file.text);
  await replaceFile(join(SPIKE_OUT, 'index.html'), '<!doctype html><meta charset="utf-8"><title>pulseforge spike</title><script src="renderer.js"></script>\n');
}

/**
 * Runs one Electron process for `config`; progress lines from the renderer are passed to
 * onProgress. An aborted `signal` kills the child: a cancelled export has to stop the render
 * that is actually burning the GPU, not merely stop waiting for it.
 */
export function runElectron<T>(
  config: SpikeConfig,
  onProgress?: (line: string) => void,
  signal?: AbortSignal,
): Promise<{ result: T; log: string }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new ElectronCancelled());
      return;
    }
    // A result file left by an earlier run would be read as this run's result if the child died
    // before writing one — a crash reported as success. Remove it first.
    try {
      rmSync(config.resultFile, { force: true });
    } catch {
      // unwritable directory: the spawn below fails with a clearer message
    }
    // A profile of its own. Electron's default is one folder per app name, so renders running side
    // by side, or beside the studio, fought over one set of caches: runs logged a corrupt cache
    // index and some of them stopped responding.
    const profile = mkdtempSync(join(tmpdir(), 'pulseforge-render-'));
    const removeProfile = () => rm(profile, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
    const child = spawn(electronBinary(), [join(SPIKE_OUT, 'main.cjs')], {
      env: { ...process.env, PULSEFORGE_SPIKE_CONFIG: JSON.stringify(config), PULSEFORGE_SPIKE_PROFILE: profile, ELECTRON_ENABLE_LOGGING: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const onAbort = () => child.kill();
    signal?.addEventListener('abort', onAbort, { once: true });
    let log = '';
    let pending = '';
    let stalled = false;
    // A hung child neither fails nor finishes, and a queue would wait behind it for ever.
    const watch = stallWatch(STALL_TIMEOUT_MS, () => {
      stalled = true;
      child.kill();
    });
    child.stdout.on('data', (chunk: Buffer) => {
      watch.alive();
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('PROGRESS ')) onProgress?.(line.slice('PROGRESS '.length));
        else log = (log + line + '\n').slice(-20_000);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      watch.alive();
      log = (log + chunk.toString()).slice(-20_000);
    });
    child.on('error', (error) => {
      watch.stop();
      void removeProfile();
      reject(error);
    });
    child.on('close', async () => {
      watch.stop();
      signal?.removeEventListener('abort', onAbort);
      await removeProfile();
      if (stalled) {
        reject(new Error(`The render stopped responding: nothing from it for ${STALL_TIMEOUT_MS / 1000} s, so it was stopped.\n${log.trim().split('\n').slice(-15).join('\n')}`));
        return;
      }
      // Killing Electron closes FFmpeg's stdin, so the encoder sees end-of-input and exits on its
      // own; the partial output is the caller's to delete.
      if (signal?.aborted === true) {
        reject(new ElectronCancelled());
        return;
      }
      try {
        resolve({ result: JSON.parse(await readFile(config.resultFile, 'utf8')) as T, log });
      } catch {
        reject(new Error(`Electron exited without writing a result.\n${log.trim().split('\n').slice(-15).join('\n')}`));
      }
    });
  });
}

/**
 * The Electron executable to spawn. From plain Node, the `electron` package's default export is
 * the binary's path. From inside Electron's own main process — the studio's render queue — the
 * same import is the Electron API object, and the running binary is `process.execPath`.
 * Spawning the object would fail with an unhelpful "argument must be of type string".
 */
export function electronBinary(): string {
  return typeof electronPath === 'string' ? electronPath : process.execPath;
}

/** Thrown when the caller aborted; distinct from a failure, because it is not one. */
export class ElectronCancelled extends Error {
  constructor() {
    super('The render was cancelled');
    this.name = 'ElectronCancelled';
  }
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}
