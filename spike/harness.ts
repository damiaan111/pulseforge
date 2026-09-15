// Shared plumbing for the spike orchestrators: bundle the Electron side, run it, collect results.

import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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

export async function bundleElectron(): Promise<void> {
  await mkdir(SPIKE_OUT, { recursive: true });
  const common: BuildOptions = { bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], sourcemap: 'linked', logLevel: 'error' };
  await build({ ...common, entryPoints: [join(ROOT, 'spike', 'electron', 'main.ts')], outfile: join(SPIKE_OUT, 'main.cjs') });
  await build({ ...common, entryPoints: [join(ROOT, 'spike', 'electron', 'renderer.ts')], outfile: join(SPIKE_OUT, 'renderer.js') });
  await writeFile(join(SPIKE_OUT, 'index.html'), '<!doctype html><meta charset="utf-8"><title>pulseforge spike</title><script src="renderer.js"></script>\n');
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
    const child = spawn(electronPath as unknown as string, [join(SPIKE_OUT, 'main.cjs')], {
      env: { ...process.env, PULSEFORGE_SPIKE_CONFIG: JSON.stringify(config), ELECTRON_ENABLE_LOGGING: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const onAbort = () => child.kill();
    signal?.addEventListener('abort', onAbort, { once: true });
    let log = '';
    let pending = '';
    child.stdout.on('data', (chunk: Buffer) => {
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('PROGRESS ')) onProgress?.(line.slice('PROGRESS '.length));
        else log = (log + line + '\n').slice(-20_000);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => (log = (log + chunk.toString()).slice(-20_000)));
    child.on('error', reject);
    child.on('close', async () => {
      signal?.removeEventListener('abort', onAbort);
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
