// "Copy diagnostics" (M34, PROJECT.md §8.15, ui-spec §7 and §11): everything a bug report needs,
// as one block of plain text for the clipboard.
//
// The environment (versions, GPU, the vendored binaries), the settings, the cache at a glance, the
// failed render job when there is one (its error, its report's path), and the log's last lines.
// Plain text rather than JSON, because it is pasted into a message and read by a person; the log
// lines inside it stay JSON, so they can still be filtered.
//
// Paths are included as they are: the text goes to the user's own clipboard, and a path is usually
// what explains a "file not found". Nothing is sent anywhere by this.

import type { LogEntry } from './logger.ts';

export interface DiagnosticsInput {
  readonly generatedAt: string;
  readonly environment: Readonly<Record<string, unknown>>;
  readonly gpu: string;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly cache: { readonly root: string; readonly totalBytes: number; readonly freeBytes: number | null; readonly units: number } | null;
  readonly job?: {
    readonly id: string;
    readonly label: string;
    readonly status: string;
    readonly error: string | null;
    readonly outputPath: string;
    readonly reportPath: string | null;
    readonly startedAt: string | null;
    readonly finishedAt: string | null;
  } | undefined;
  readonly logPath: string;
  readonly log: readonly LogEntry[];
}

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(2)} GB`;

export function buildDiagnostics(input: DiagnosticsInput): string {
  const lines: string[] = [];
  const section = (title: string) => lines.push('', `## ${title}`);
  lines.push(`# Pulseforge diagnostics — ${input.generatedAt}`);

  section('Environment');
  for (const [key, value] of Object.entries(input.environment)) {
    lines.push(`${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`);
  }
  lines.push(`gpu: ${input.gpu}`);

  if (input.job !== undefined) {
    const j = input.job;
    section(`Render job ${j.id}`);
    lines.push(`label: ${j.label}`, `status: ${j.status}`, `output: ${j.outputPath}`);
    if (j.startedAt !== null) lines.push(`started: ${j.startedAt}`);
    if (j.finishedAt !== null) lines.push(`finished: ${j.finishedAt}`);
    lines.push(`report: ${j.reportPath ?? 'none written'}`);
    if (j.error !== null) lines.push('error:', ...j.error.split('\n').map((l) => `  ${l}`));
  }

  section('Settings');
  for (const [key, value] of Object.entries(input.settings)) lines.push(`${key}: ${JSON.stringify(value)}`);

  section('Cache');
  if (input.cache === null) lines.push('could not be read');
  else lines.push(`root: ${input.cache.root}`, `size: ${gb(input.cache.totalBytes)} in ${input.cache.units} items`, `free on drive: ${input.cache.freeBytes === null ? 'unknown' : gb(input.cache.freeBytes)}`);

  section(`Log (last ${input.log.length} lines of ${input.logPath})`);
  for (const entry of input.log) lines.push(JSON.stringify(entry));
  return `${lines.join('\n')}\n`;
}
