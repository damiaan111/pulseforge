// The FFmpeg child process for an export: raw frames in on stdin, encoder progress out on
// stdout, diagnostics on stderr (export-spec §5, §13, §14).

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { PumpSink } from './pump.ts';

export interface EncoderProcess {
  readonly sink: PumpSink;
  /** Encoder-side frame count (export-spec §13: progress comes from the encoder, not the pump). */
  framesEncoded(): number;
  /** Closes stdin and waits for FFmpeg to finish writing the file. */
  finish(): Promise<EncoderExit>;
  /** Kills FFmpeg (cancel / failure). */
  abort(): void;
}

export interface EncoderExit {
  readonly code: number | null;
  readonly stderrTail: string;
  readonly diagnosis: string | undefined;
}

export class EncoderError extends Error {
  readonly exit: EncoderExit;
  constructor(message: string, exit: EncoderExit) {
    super(message);
    this.name = 'EncoderError';
    this.exit = exit;
  }
}

/** Known FFmpeg/NVENC failure signatures → a cause a person can act on (export-spec §14). */
export function diagnoseEncoderFailure(stderr: string): string | undefined {
  const rules: Array<[RegExp, string]> = [
    [/No capable devices found|OpenEncodeSessionEx failed|Cannot load nvcuda|nvEncodeAPI/i, 'NVENC could not start: the NVIDIA driver is missing, too old, or the GPU is unavailable (another app holding all encoder sessions, or remote desktop).'],
    [/Unknown encoder/i, 'This FFmpeg build does not include the requested encoder. Run `npm run setup -- --verify`.'],
    [/No space left on device|ENOSPC/i, 'The output disk is full.'],
    [/Invalid argument.*pix_fmt|Specified pixel format .* is not supported|Incompatible pixel format/i, 'The pixel format is not supported by this encoder/profile combination.'],
    [/Error while opening encoder|Could not open encoder/i, 'The encoder rejected its settings (profile, level or pixel format not supported by this GPU).'],
    [/Permission denied/i, 'The output file could not be written (open in another program, or a protected folder).'],
    [/Invalid data found when processing input/i, 'FFmpeg received malformed input — likely a frame-size mismatch between the pump and the command line.'],
  ];
  return rules.find(([pattern]) => pattern.test(stderr))?.[1];
}

export function startEncoder(ffmpegExe: string, args: readonly string[]): EncoderProcess {
  const child: ChildProcessWithoutNullStreams = spawn(ffmpegExe, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  let encoded = 0;
  let exited = false;
  let spawnError: Error | undefined;
  let progressBuffer = '';

  child.stdout.on('data', (chunk: Buffer) => {
    progressBuffer += chunk.toString('utf8');
    const lines = progressBuffer.split('\n');
    progressBuffer = lines.pop() ?? '';
    for (const line of lines) {
      const match = /^frame=(\d+)/.exec(line.trim());
      if (match?.[1] !== undefined) encoded = Number(match[1]);
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-32_000);
  });
  child.on('error', (error) => {
    spawnError = error;
  });
  const closed = new Promise<EncoderExit>((resolve) => {
    child.on('close', (code) => {
      exited = true;
      const tail = stderr.trim().split(/\r?\n/).slice(-25).join('\n');
      const diagnosis = spawnError !== undefined ? `Could not start ${ffmpegExe}: ${spawnError.message}` : diagnoseEncoderFailure(stderr);
      resolve({ code, stderrTail: tail, diagnosis });
    });
  });
  // EPIPE on stdin surfaces through write callbacks; keep it from becoming an uncaught error.
  child.stdin.on('error', () => {});

  const sink: PumpSink = {
    write(frame) {
      return new Promise((resolve, reject) => {
        if (exited || spawnError !== undefined) {
          reject(new EncoderError('FFmpeg exited before all frames were written', { code: child.exitCode, stderrTail: stderr.slice(-4000), diagnosis: diagnoseEncoderFailure(stderr) }));
          return;
        }
        // The callback fires once the bytes are handed to the OS pipe, so the pump only
        // reuses a buffer after FFmpeg has taken it: that is the backpressure.
        child.stdin.write(frame, (error) => {
          if (error === null || error === undefined) resolve();
          else reject(new EncoderError(`writing to FFmpeg failed: ${error.message}`, { code: child.exitCode, stderrTail: stderr.slice(-4000), diagnosis: diagnoseEncoderFailure(stderr) }));
        });
      });
    },
  };

  return {
    sink,
    framesEncoded: () => encoded,
    async finish() {
      child.stdin.end();
      const exit = await closed;
      if (exit.code !== 0) {
        throw new EncoderError(`FFmpeg failed (exit ${exit.code}): ${exit.diagnosis ?? exit.stderrTail.split('\n').pop() ?? 'no output'}`, exit);
      }
      return exit;
    },
    abort() {
      if (!exited) child.kill();
    },
  };
}
