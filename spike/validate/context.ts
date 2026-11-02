// Shared types for `npm run validate` checks (export-spec §17).

import type { ContextInfo } from '../../src/engine/render/gl.ts';

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface CheckOutcome {
  readonly id: number;
  readonly title: string;
  readonly status: CheckStatus;
  /** Markdown lines for the pasteable report. */
  readonly lines: readonly string[];
  /** Machine-readable measurements for report.json. */
  readonly data: Readonly<Record<string, unknown>>;
  readonly seconds: number;
}

export interface ValidateContext {
  readonly quick: boolean;
  readonly workDir: string;
  readonly log: (line: string) => void;
  /** Filled by the determinism check; read by the environment check. */
  webgl?: { context: ContextInfo | undefined; electronVersion: string; chromeVersion: string };
}

export type Check = (ctx: ValidateContext) => Promise<Omit<CheckOutcome, 'seconds'>>;

export function table(headers: readonly string[], rows: ReadonlyArray<readonly (string | number)[]>): string[] {
  return [
    `| ${headers.join(' | ')} |`,
    `|${headers.map(() => '---').join('|')}|`,
    ...rows.map((row) => `| ${row.map(String).join(' | ')} |`),
  ];
}
