// Setup runs on a machine nobody is watching over the user's shoulder (PROJECT.md §14):
// every failure we can anticipate must say what broke, why, and exactly what to do.
// A raw stack trace reaching the user is a bug in this script, not a diagnosis.

export interface SetupErrorDetails {
  /** Which step failed, as shown in the progress output. */
  step: string;
  /** One sentence: what went wrong. */
  what: string;
  /** Most likely reason, in plain language. */
  likelyCause?: string;
  /** Concrete actions, most likely to help first. */
  fix: readonly string[];
  /** Last lines of a child process's output, when one was involved. */
  outputTail?: string;
}

export class SetupError extends Error {
  readonly step: string;
  readonly what: string;
  readonly likelyCause: string | undefined;
  readonly fix: readonly string[];
  readonly outputTail: string | undefined;

  constructor(details: SetupErrorDetails) {
    super(details.what);
    this.name = 'SetupError';
    this.step = details.step;
    this.what = details.what;
    this.likelyCause = details.likelyCause;
    this.fix = details.fix;
    this.outputTail = details.outputTail;
  }
}

function indent(text: string, prefix: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => prefix + line)
    .join('\n');
}

export function formatSetupError(error: SetupError, logFile: string): string {
  const lines = ['', `✖ Setup failed at step: ${error.step}`, '', `  What happened: ${error.what}`];
  if (error.likelyCause !== undefined) lines.push(`  Likely cause:  ${error.likelyCause}`);
  if (error.outputTail !== undefined && error.outputTail.trim() !== '') {
    lines.push('', '  Last output:', indent(error.outputTail.trimEnd(), '    │ '));
  }
  lines.push('', '  What to do:');
  error.fix.forEach((step, i) => lines.push(`    ${i + 1}. ${step}`));
  lines.push('', `  Full log: ${logFile}`, '  Re-running `npm run setup` is always safe: finished work is kept and downloads resume.', '');
  return lines.join('\n');
}

export function formatUnexpectedError(step: string, error: unknown, logFile: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return [
    '',
    `✖ Setup hit an unexpected error during step: ${step}`,
    '',
    `  Error: ${message}`,
    '',
    '  This is a bug in the setup script, not something you did — it should have',
    '  produced a specific explanation instead.',
    '',
    '  What to do:',
    '    1. Re-run `npm run setup`; finished work is kept, so a transient failure costs nothing.',
    `    2. If it happens again, share the end of the log (the stack trace is there): ${logFile}`,
    '',
  ].join('\n');
}
