import { spawn } from 'node:child_process';
import { SetupError } from './errors.ts';
import type { Logger } from './log.ts';

export interface RunOptions {
  step: string;
  log: Logger;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Show the child's output live (long installs); it is always written to the log. */
  echo?: boolean;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Last ~40 lines of combined output, for error messages. */
  tail: string;
}

const MAX_CAPTURE = 4 * 1024 * 1024;
const TAIL_LINES = 40;

export function run(exe: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
  options.log.detail(`$ "${exe}" ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let combined = '';
    const capture = (which: 'out' | 'err') => (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      options.log.childOutput(text, options.echo === true);
      if (which === 'out' && stdout.length < MAX_CAPTURE) stdout += text;
      if (which === 'err' && stderr.length < MAX_CAPTURE) stderr += text;
      combined = (combined + text).slice(-64_000);
    };
    child.stdout.on('data', capture('out'));
    child.stderr.on('data', capture('err'));
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        reject(
          new SetupError({
            step: options.step,
            what: `Could not start ${exe}: the file does not exist.`,
            likelyCause: 'An earlier step did not finish, or the file was deleted from vendor/.',
            fix: ['Re-run `npm run setup`; it re-verifies and repairs installed artefacts.'],
          }),
        );
      } else {
        reject(error);
      }
    });
    child.on('close', (code) => {
      const tail = combined.split(/\r?\n/).slice(-TAIL_LINES).join('\n');
      resolve({ code: code ?? -1, stdout, stderr, tail });
    });
  });
}

export interface FailureExplanation {
  what: string;
  likelyCause?: string;
  fix: readonly string[];
}

/** Runs and throws a SetupError with the output tail if the exit code is non-zero. */
export async function runChecked(
  exe: string,
  args: readonly string[],
  options: RunOptions,
  onFailure: (result: RunResult) => FailureExplanation,
): Promise<RunResult> {
  const result = await run(exe, args, options);
  if (result.code !== 0) {
    const explanation = onFailure(result);
    throw new SetupError({
      step: options.step,
      what: `${explanation.what} (exit code ${result.code})`,
      ...(explanation.likelyCause !== undefined ? { likelyCause: explanation.likelyCause } : {}),
      fix: explanation.fix,
      outputTail: result.tail,
    });
  }
  return result;
}
