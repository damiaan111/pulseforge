// Structured, rotating logs on disk (M34, PROJECT.md §8.15).
//
// One JSON object per line — `{"t":…,"level":…,"scope":…,"msg":…}` — so a log can be read by a
// person, filtered with a one-liner and diffed between two runs. The file rotates by size
// (`pulseforge.log` → `pulseforge.1.log` … up to `keep` files), so a studio left open for a month
// cannot fill a disk. The level is a setting (error · warn · info · debug) and applies at once.
//
// Writes are synchronous appends: the log exists for the moment something goes wrong, and a
// buffered line lost in a crash is exactly the line that was needed. The volume is small (a few
// lines per user action), so the cost is nothing. Writing a log line can never throw into the
// caller: a log that cannot be written is not a reason to fail the work being logged.
//
// Plain Node: tested directly, used by the main process.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const LOG_LEVEL_ORDER = { error: 0, warn: 1, info: 2, debug: 3 } as const;
export type LogLevel = keyof typeof LOG_LEVEL_ORDER;

export interface LogEntry {
  readonly t: string;
  readonly level: LogLevel;
  readonly scope: string;
  readonly msg: string;
  readonly data?: unknown;
}

export interface LoggerOptions {
  readonly dir: string;
  readonly level?: LogLevel;
  /** Rotate when the current file passes this many bytes. */
  readonly maxBytes?: number;
  /** Files kept, the current one included. */
  readonly keep?: number;
  readonly now?: () => Date;
}

export const LOG_FILE = 'pulseforge.log';

export class Logger {
  readonly dir: string;
  private level: LogLevel;
  private readonly maxBytes: number;
  private readonly keep: number;
  private readonly now: () => Date;

  constructor(options: LoggerOptions) {
    this.dir = options.dir;
    this.level = options.level ?? 'info';
    this.maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
    this.keep = Math.max(1, options.keep ?? 5);
    this.now = options.now ?? (() => new Date());
  }

  get path(): string {
    return join(this.dir, LOG_FILE);
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  enabled(level: LogLevel): boolean {
    return LOG_LEVEL_ORDER[level] <= LOG_LEVEL_ORDER[this.level];
  }

  error(scope: string, msg: string, data?: unknown): void {
    this.write('error', scope, msg, data);
  }

  warn(scope: string, msg: string, data?: unknown): void {
    this.write('warn', scope, msg, data);
  }

  info(scope: string, msg: string, data?: unknown): void {
    this.write('info', scope, msg, data);
  }

  debug(scope: string, msg: string, data?: unknown): void {
    this.write('debug', scope, msg, data);
  }

  write(level: LogLevel, scope: string, msg: string, data?: unknown): void {
    if (!this.enabled(level)) return;
    const entry: LogEntry = { t: this.now().toISOString(), level, scope, msg, ...(data === undefined ? {} : { data: safe(data) }) };
    try {
      mkdirSync(this.dir, { recursive: true });
      this.rotateIfNeeded();
      appendFileSync(this.path, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch {
      // Never into the caller (see the header).
    }
  }

  /** The last `count` entries across the current and previous file, oldest first. */
  tail(count: number): LogEntry[] {
    const out: LogEntry[] = [];
    for (let i = 0; i < this.keep && out.length < count; i += 1) {
      const file = i === 0 ? this.path : join(this.dir, `pulseforge.${i}.log`);
      if (!existsSync(file)) break;
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        break;
      }
      const lines = text.split('\n').filter((l) => l.trim() !== '');
      const entries = lines.map((line): LogEntry => {
        try {
          return JSON.parse(line) as LogEntry;
        } catch {
          // A line from something else (or a torn write) is kept as text, not dropped.
          return { t: '', level: 'info', scope: 'raw', msg: line };
        }
      });
      out.unshift(...entries.slice(-(count - out.length)));
    }
    return out.slice(-count);
  }

  private rotateIfNeeded(): void {
    let size: number;
    try {
      size = statSync(this.path).size;
    } catch {
      return;
    }
    if (size < this.maxBytes) return;
    const oldest = join(this.dir, `pulseforge.${this.keep - 1}.log`);
    if (this.keep === 1) {
      rmSync(this.path, { force: true });
      return;
    }
    rmSync(oldest, { force: true });
    for (let i = this.keep - 2; i >= 1; i -= 1) {
      const from = join(this.dir, `pulseforge.${i}.log`);
      if (existsSync(from)) renameSync(from, join(this.dir, `pulseforge.${i + 1}.log`));
    }
    renameSync(this.path, join(this.dir, 'pulseforge.1.log'));
  }
}

/** Data that is safe to stringify: errors as their message and stack, cycles cut. */
function safe(data: unknown): unknown {
  if (data instanceof Error) return { name: data.name, message: data.message, stack: data.stack };
  try {
    JSON.stringify(data);
    return data;
  } catch {
    return String(data);
  }
}

/** "[render-queue] could not start: …" → scope and message; untagged lines get `fallback`. */
export function splitScope(text: string, fallback: string): { scope: string; msg: string } {
  const m = /^\[([a-z0-9-]+)\]\s*(.*)$/is.exec(text);
  return m === null ? { scope: fallback, msg: text } : { scope: (m[1] as string).toLowerCase(), msg: m[2] as string };
}
