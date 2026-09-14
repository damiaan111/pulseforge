// Shared plumbing for the spike orchestrators: bundle the Electron side, run it, collect results.

import { spawn } from 'node:child_process';
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

/** Runs one Electron process for `config`; progress lines from the renderer are passed to onProgress. */
export function runElectron<T>(config: SpikeConfig, onProgress?: (line: string) => void): Promise<{ result: T; log: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(electronPath as unknown as string, [join(SPIKE_OUT, 'main.cjs')], {
      env: { ...process.env, PULSEFORGE_SPIKE_CONFIG: JSON.stringify(config), ELECTRON_ENABLE_LOGGING: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
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
      try {
        resolve({ result: JSON.parse(await readFile(config.resultFile, 'utf8')) as T, log });
      } catch {
        reject(new Error(`Electron exited without writing a result.\n${log.trim().split('\n').slice(-15).join('\n')}`));
      }
    });
  });
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}
