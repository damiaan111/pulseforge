// The supervised ML sidecar (M27, PROJECT.md §3).
//
// One Python process, kept alive, doing one job at a time. Four things it has to get right:
//
//  1. **Survive its own child.** A crashed sidecar fails the request that was in flight and is
//     restarted on the next one — it never takes the app down, and it never leaves a caller
//     waiting on a promise that can no longer settle.
//  2. **Cancel without killing.** Stem separation runs for minutes; cancelling has to mean
//     "stop at the next checkpoint and tidy up", not SIGKILL and a half-written stem file.
//  3. **Yield the GPU.** Torch holds VRAM for as long as it is loaded, and the renderer needs
//     that memory (M28, PROJECT.md §4). An idle sidecar shuts itself down.
//  4. **Say what is wrong.** A sidecar that cannot start is the most likely thing to go wrong on
//     a machine I cannot see, so failures carry the stderr tail and a suggested fix.
//
// `spawn` is injected, so all of the above is tested against a stub process rather than a GPU.

import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import {
  encodeOutbound,
  LineSplitter,
  parseInbound,
  SIDECAR_PROTOCOL_VERSION,
  type InboundMessage,
} from './protocol.ts';

export type SupervisorState = 'stopped' | 'starting' | 'ready' | 'stopping';

export class SidecarUnavailableError extends Error {
  readonly stderrTail: string;
  readonly fixes: readonly string[];
  constructor(message: string, stderrTail: string, fixes: readonly string[] = []) {
    super(message);
    this.name = 'SidecarUnavailableError';
    this.stderrTail = stderrTail;
    this.fixes = fixes;
  }
}

export class SidecarRequestError extends Error {
  readonly errorType: string;
  readonly stderrTail: string;
  constructor(errorType: string, message: string, stderrTail: string) {
    super(message);
    this.name = 'SidecarRequestError';
    this.errorType = errorType;
    this.stderrTail = stderrTail;
  }
}

export class SidecarCancelledError extends Error {
  constructor(id: string) {
    super(`request ${id} was cancelled`);
    this.name = 'SidecarCancelledError';
  }
}

/** The stub in tests and `child_process.spawn` in production implement this. */
export type SpawnSidecar = () => ChildProcessWithoutNullStreams;

export interface SupervisorOptions {
  readonly spawn: SpawnSidecar;
  readonly newId: () => string;
  /** Shut the sidecar down after this long with nothing to do, freeing its VRAM. 0 disables. */
  readonly idleTimeoutMs?: number;
  /** How long to wait for a graceful exit before killing (default 5 s). */
  readonly shutdownGraceMs?: number;
  /** How long to wait for the `ready` line before calling the start a failure (default 60 s). */
  readonly startTimeoutMs?: number;
  readonly onLog?: (message: string) => void;
  readonly onStateChange?: (state: SupervisorState) => void;
}

export interface RequestOptions {
  readonly onProgress?: (progress: { readonly fraction?: number; readonly stage?: string }) => void;
  /** Abort from the caller's side — the UI's cancel button. */
  readonly signal?: AbortSignal;
}

interface Pending {
  readonly id: string;
  readonly resolve: (data: Readonly<Record<string, unknown>>) => void;
  readonly reject: (error: Error) => void;
  readonly onProgress: RequestOptions['onProgress'];
}

/** Everything one Python process owns, so a restart cannot leave half of it behind. */
interface Session {
  readonly child: ChildProcessWithoutNullStreams;
  readonly splitter: LineSplitter;
  stderr: string;
  ready: boolean;
  exited: boolean;
}

export class SidecarSupervisor {
  private readonly options: SupervisorOptions;
  private session: Session | null = null;
  private stateValue: SupervisorState = 'stopped';
  private starting: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private pending: Pending | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(options: SupervisorOptions) {
    this.options = options;
  }

  get state(): SupervisorState {
    return this.stateValue;
  }

  get pid(): number | undefined {
    return this.session?.child.pid;
  }

  /**
   * Start the process and wait for its `ready` line. Safe to call repeatedly; concurrent callers
   * share one start rather than spawning a second Python.
   */
  async start(): Promise<void> {
    if (this.stateValue === 'ready') return;
    if (this.starting !== null) return this.starting;
    this.starting = this.spawnSession().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /**
   * Send one request and wait for its result.
   *
   * Requests are serialised: the sidecar does one GPU job at a time (M28), and interleaving two
   * would also interleave their progress. The queue is a promise chain, so a caller that awaits
   * `request` gets its own result and nothing else.
   */
  async request(
    command: string,
    params: Readonly<Record<string, unknown>> = {},
    options: RequestOptions = {},
  ): Promise<Readonly<Record<string, unknown>>> {
    const run = this.queue.then(
      () => this.send(command, params, options),
      () => this.send(command, params, options),
    );
    // The chain must not reject, or one failed request poisons every later one.
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Stop the sidecar. Asks first, kills only if it does not go. */
  async stop(): Promise<void> {
    const session = this.session;
    if (session === null) {
      this.setState('stopped');
      return;
    }
    this.setState('stopping');
    this.clearIdleTimer();
    const grace = this.options.shutdownGraceMs ?? 5_000;

    const exited = new Promise<void>((resolve) => {
      if (session.exited) resolve();
      else session.child.once('close', () => resolve());
    });
    try {
      session.child.stdin.write(encodeOutbound({ type: 'shutdown' }));
      session.child.stdin.end();
    } catch {
      // Already gone; the close handler settles it.
    }
    const timer = setTimeout(() => session.child.kill(), grace);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
    this.session = null;
    this.setState('stopped');
  }

  private async send(
    command: string,
    params: Readonly<Record<string, unknown>>,
    options: RequestOptions,
  ): Promise<Readonly<Record<string, unknown>>> {
    await this.start();
    const session = this.session;
    if (session === null) throw new SidecarUnavailableError('the sidecar is not running', '', ['Run `npm run setup -- --verify`']);

    this.clearIdleTimer();
    const id = this.options.newId();

    return new Promise<Readonly<Record<string, unknown>>>((resolve, reject) => {
      const settle = () => {
        this.pending = null;
        options.signal?.removeEventListener('abort', onAbort);
        this.armIdleTimer();
      };
      const onAbort = () => {
        // Ask the sidecar to stop at its next checkpoint. The process stays alive and usable:
        // killing it here would throw away a loaded model and any partial cleanup it owes.
        this.write({ type: 'cancel', id });
      };

      this.pending = {
        id,
        onProgress: options.onProgress,
        resolve: (data) => {
          settle();
          resolve(data);
        },
        reject: (error) => {
          settle();
          reject(error);
        },
      };

      if (options.signal?.aborted === true) {
        this.pending.reject(new SidecarCancelledError(id));
        return;
      }
      options.signal?.addEventListener('abort', onAbort, { once: true });
      this.write({ type: 'request', id, command, params });
    });
  }

  private write(message: Parameters<typeof encodeOutbound>[0]): void {
    const session = this.session;
    if (session === null || session.exited) return;
    try {
      session.child.stdin.write(encodeOutbound(message));
    } catch {
      // The close handler will fail the pending request with the stderr tail.
    }
  }

  private spawnSession(): Promise<void> {
    this.setState('starting');
    const child = this.options.spawn();
    const session: Session = { child, splitter: new LineSplitter(), stderr: '', ready: false, exited: false };
    this.session = session;

    return new Promise<void>((resolve, reject) => {
      const startTimeout = this.options.startTimeoutMs ?? 60_000;
      const timer = setTimeout(() => {
        if (session.ready) return;
        child.kill();
        reject(
          new SidecarUnavailableError(
            `the sidecar did not report ready within ${Math.round(startTimeout / 1000)}s`,
            tailOf(session.stderr),
            ['Run `npm run setup -- --verify` to check the Python environment'],
          ),
        );
      }, startTimeout);

      const fail = (error: Error) => {
        clearTimeout(timer);
        this.session = null;
        this.setState('stopped');
        reject(error);
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        for (const line of session.splitter.push(chunk)) {
          const message = parseInbound(line);
          if (message === undefined) continue;
          if (message.type === 'ready') {
            if (message.protocol !== SIDECAR_PROTOCOL_VERSION) {
              child.kill();
              fail(
                new SidecarUnavailableError(
                  `the sidecar speaks protocol ${message.protocol}; this build speaks ${SIDECAR_PROTOCOL_VERSION}`,
                  tailOf(session.stderr),
                  ['Re-run `npm run setup` so the Python package matches this build'],
                ),
              );
              return;
            }
            clearTimeout(timer);
            session.ready = true;
            this.setState('ready');
            this.armIdleTimer();
            resolve();
            continue;
          }
          this.dispatch(message);
        }
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        session.stderr = (session.stderr + chunk).slice(-16_000);
      });

      child.on('error', (error) => {
        session.exited = true;
        this.failPending(
          new SidecarUnavailableError(`could not start the sidecar: ${error.message}`, tailOf(session.stderr), [
            'Run `npm run setup` to provision the Python environment',
          ]),
        );
        if (!session.ready) fail(new SidecarUnavailableError(`could not start the sidecar: ${error.message}`, tailOf(session.stderr)));
      });

      child.on('close', (code) => {
        session.exited = true;
        for (const line of session.splitter.flush()) {
          const message = parseInbound(line);
          if (message !== undefined && message.type !== 'ready') this.dispatch(message);
        }
        // A request still waiting when the process goes is a crash, and it must reject now
        // rather than hang — the caller is a progress bar somebody is watching.
        this.failPending(
          new SidecarUnavailableError(
            `the sidecar exited with code ${code} while a request was in flight`,
            tailOf(session.stderr),
            ['Check the stderr tail below', 'Run `npm run setup -- --verify`'],
          ),
        );
        if (this.session === session) {
          this.session = null;
          if (this.stateValue !== 'stopping') this.setState('stopped');
        }
        if (!session.ready) fail(new SidecarUnavailableError(`the sidecar exited with code ${code} before reporting ready`, tailOf(session.stderr)));
      });
    });
  }

  /** Route a message to the request it belongs to. Anything unattributable becomes a log. */
  private dispatch(message: InboundMessage): void {
    if (message.type === 'log') {
      this.options.onLog?.(message.message);
      return;
    }
    // A second `ready` means the sidecar restarted itself underneath us — nothing to attribute
    // it to, and the start path has already handled the first one.
    if (message.type === 'ready') return;
    const pending = this.pending;
    // A late line from a cancelled or already-settled request: dropped, not misattributed to
    // whatever is running now, which is why every message carries its request id.
    if (pending === null || pending.id !== message.id) return;

    switch (message.type) {
      case 'progress':
        pending.onProgress?.({
          ...(message.fraction === undefined ? {} : { fraction: message.fraction }),
          ...(message.stage === undefined ? {} : { stage: message.stage }),
        });
        break;
      case 'result':
        pending.resolve(message.data);
        break;
      case 'error':
        pending.reject(new SidecarRequestError(message.errorType, message.message, tailOf(this.session?.stderr ?? '')));
        break;
      case 'cancelled':
        pending.reject(new SidecarCancelledError(message.id));
        break;
      default:
        break;
    }
  }

  private failPending(error: Error): void {
    this.pending?.reject(error);
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    const idle = this.options.idleTimeoutMs ?? 0;
    if (idle <= 0 || this.stateValue !== 'ready') return;
    // Torch holds VRAM for as long as it is loaded, and the renderer wants that memory back
    // (M28). Unref'd so an idle sidecar never keeps the process alive on its own.
    this.idleTimer = setTimeout(() => {
      if (this.pending === null) void this.stop();
    }, idle);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private setState(state: SupervisorState): void {
    if (this.stateValue === state) return;
    this.stateValue = state;
    this.options.onStateChange?.(state);
  }
}

function tailOf(stderr: string): string {
  return stderr.trim().split(/\r?\n/).slice(-20).join('\n');
}

/** The production spawn: the vendored interpreter, by absolute path, in an isolated env. */
export function spawnPythonSidecar(pythonExe: string, packageRoot: string, env: NodeJS.ProcessEnv): SpawnSidecar {
  return () =>
    nodeSpawn(pythonExe, ['-m', 'pulseforge_ml', 'serve'], {
      cwd: packageRoot,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
}
