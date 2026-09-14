import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Logger {
  readonly file: string;
  heading(text: string): void;
  info(text: string): void;
  ok(text: string): void;
  warn(text: string): void;
  /** Log file only — diagnostics nobody needs on screen. */
  detail(text: string): void;
  /** A transient status line (download progress). Not written to the log. */
  progress(text: string): void;
  endProgress(): void;
  /** Output from a child process: always logged, echoed to the console on request. */
  childOutput(chunk: string, echo: boolean): void;
}

export function createLogger(file: string, stream: NodeJS.WriteStream = process.stdout): Logger {
  mkdirSync(dirname(file), { recursive: true });
  const tty = stream.isTTY === true;
  let progressVisible = false;
  let lastNonTtyProgress = 0;

  const toFile = (text: string) => {
    const stamp = new Date().toISOString();
    appendFileSync(file, text.split(/\r?\n/).map((l) => `${stamp} ${l}`).join('\n') + '\n');
  };
  const clearProgress = () => {
    if (progressVisible && tty) stream.write('\r\x1b[2K');
    progressVisible = false;
  };
  const say = (text: string) => {
    clearProgress();
    stream.write(text + '\n');
    toFile(text);
  };

  toFile(`===== setup run started (pid ${process.pid}, node ${process.version}) =====`);

  return {
    file,
    heading: (text) => say(`\n▶ ${text}`),
    info: (text) => say(`  ${text}`),
    ok: (text) => say(`  ✔ ${text}`),
    warn: (text) => say(`  ⚠ ${text}`),
    detail: (text) => toFile(text),
    progress(text) {
      if (tty) {
        stream.write(`\r\x1b[2K  ${text}`);
        progressVisible = true;
      } else if (Date.now() - lastNonTtyProgress > 15_000) {
        stream.write(`  ${text}\n`);
        lastNonTtyProgress = Date.now();
      }
    },
    endProgress: clearProgress,
    childOutput(chunk, echo) {
      appendFileSync(file, chunk);
      if (echo) {
        clearProgress();
        stream.write(chunk);
      }
    },
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}
