// Node client for the Python ML sidecar (PROJECT.md §3, M27): spawn, parse JSON lines,
// surface progress, return the single result or a specific error. A crashed sidecar rejects
// its promise; it never takes the caller down.

import { spawn } from 'node:child_process';

export type SidecarEvent =
  | { readonly event: 'progress'; readonly fraction: number; readonly [key: string]: unknown }
  | { readonly event: 'log'; readonly message: string }
  | { readonly event: 'result'; readonly [key: string]: unknown }
  | { readonly event: 'error'; readonly type: string; readonly message: string };

/** Parses one stdout line. Non-JSON output is reported as a log event, never thrown. */
export function parseSidecarLine(line: string): SidecarEvent | undefined {
  const trimmed = line.trim();
  if (trimmed === '') return undefined;
  try {
    const value = JSON.parse(trimmed) as { event?: unknown };
    if (value !== null && typeof value === 'object' && typeof value.event === 'string') {
      if (value.event === 'progress' || value.event === 'result' || value.event === 'error' || value.event === 'log') {
        return value as SidecarEvent;
      }
    }
  } catch {
    // fall through
  }
  return { event: 'log', message: trimmed };
}

export class SidecarError extends Error {
  readonly errorType: string | undefined;
  readonly stderrTail: string;
  constructor(message: string, errorType: string | undefined, stderrTail: string) {
    super(message);
    this.name = 'SidecarError';
    this.errorType = errorType;
    this.stderrTail = stderrTail;
  }
}

export interface SidecarRun {
  readonly pythonExe: string;
  /** Directory containing the `pulseforge_ml` package (the repo's `python/`). */
  readonly packageRoot: string;
  readonly args: readonly string[];
  /** Isolated environment (setup/lib/env.ts pythonEnv()). */
  readonly env: NodeJS.ProcessEnv;
  readonly onEvent?: (event: SidecarEvent) => void;
}

export interface SidecarResult {
  readonly result: Readonly<Record<string, unknown>>;
  readonly wallMs: number;
  readonly stderrTail: string;
}

export function runSidecar(run: SidecarRun): Promise<SidecarResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(run.pythonExe, ['-m', 'pulseforge_ml', ...run.args], {
      cwd: run.packageRoot,
      env: run.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let pending = '';
    let stderr = '';
    let result: Record<string, unknown> | undefined;
    let error: { type: string; message: string } | undefined;

    child.stdout.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8');
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const event = parseSidecarLine(line);
        if (event === undefined) continue;
        if (event.event === 'result') {
          const { event: _tag, ...payload } = event;
          result = payload;
        } else if (event.event === 'error') {
          error = { type: event.type, message: event.message };
        }
        run.onEvent?.(event);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-16_000);
    });
    child.on('error', (spawnError) => reject(new SidecarError(`could not start ${run.pythonExe}: ${spawnError.message}`, undefined, stderr)));
    child.on('close', (code) => {
      const tail = stderr.trim().split(/\r?\n/).slice(-20).join('\n');
      if (error !== undefined) {
        reject(new SidecarError(`${error.type}: ${error.message}`, error.type, tail));
      } else if (code !== 0 || result === undefined) {
        reject(new SidecarError(`sidecar exited with code ${code} without a result`, undefined, tail));
      } else {
        resolve({ result, wallMs: Date.now() - started, stderrTail: tail });
      }
    });
  });
}
