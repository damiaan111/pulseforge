// The long-lived sidecar's wire protocol (M27, PROJECT.md §3).
//
// JSON lines over stdio, one message per line, in both directions. Deliberately separate from
// the one-shot `runSidecar` path: that one is verified on the RTX machine and drives P0's
// validation, so it keeps working exactly as it did.
//
// Why a long-lived process at all: the measured cost of a stem separation includes ~4 s of
// Python start plus model load (STATUS §5). One-shot pays that per track, which is most of the
// time in a batch of short tracks and all of the time for a health check. Holding the process
// open pays it once.
//
// Every message carries a `type`, and requests carry an `id` that the reply echoes — so a late
// progress line from a cancelled request can be recognised and dropped rather than attributed
// to whatever is running now.

export const SIDECAR_PROTOCOL_VERSION = 2;

// --- Node → Python ---------------------------------------------------------

export interface RequestMessage {
  readonly type: 'request';
  readonly id: string;
  readonly command: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface CancelMessage {
  readonly type: 'cancel';
  readonly id: string;
}

export interface ShutdownMessage {
  readonly type: 'shutdown';
}

export type OutboundMessage = RequestMessage | CancelMessage | ShutdownMessage;

// --- Python → Node ---------------------------------------------------------

/** Sent once at startup, before anything is asked of it. */
export interface ReadyMessage {
  readonly type: 'ready';
  readonly protocol: number;
  readonly pid: number;
}

export interface ProgressMessage {
  readonly type: 'progress';
  readonly id: string;
  /** 0..1 where it is known; a stage with no measurable extent omits it. */
  readonly fraction?: number;
  readonly stage?: string;
}

export interface LogMessage {
  readonly type: 'log';
  readonly id?: string;
  readonly message: string;
}

export interface ResultMessage {
  readonly type: 'result';
  readonly id: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface ErrorMessage {
  readonly type: 'error';
  readonly id: string;
  readonly errorType: string;
  readonly message: string;
}

export interface CancelledMessage {
  readonly type: 'cancelled';
  readonly id: string;
}

export type InboundMessage =
  | ReadyMessage
  | ProgressMessage
  | LogMessage
  | ResultMessage
  | ErrorMessage
  | CancelledMessage;

export function encodeOutbound(message: OutboundMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * Parse one line from the sidecar.
 *
 * Anything that is not a recognised message becomes a `log` — torch, CUDA and Demucs all write
 * to stdout uninvited, and a stray banner must never look like a protocol failure. Returning
 * `undefined` only for blank lines keeps every byte the sidecar produced visible somewhere.
 */
export function parseInbound(line: string): InboundMessage | undefined {
  const trimmed = line.trim();
  if (trimmed === '') return undefined;

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return { type: 'log', message: trimmed };
  }
  if (typeof value !== 'object' || value === null) return { type: 'log', message: trimmed };

  const message = value as Record<string, unknown>;
  const id = typeof message['id'] === 'string' ? message['id'] : undefined;

  switch (message['type']) {
    case 'ready':
      return {
        type: 'ready',
        protocol: typeof message['protocol'] === 'number' ? message['protocol'] : 0,
        pid: typeof message['pid'] === 'number' ? message['pid'] : 0,
      };
    case 'progress':
      if (id === undefined) break;
      return {
        type: 'progress',
        id,
        ...(typeof message['fraction'] === 'number' ? { fraction: message['fraction'] } : {}),
        ...(typeof message['stage'] === 'string' ? { stage: message['stage'] } : {}),
      };
    case 'result':
      if (id === undefined) break;
      return {
        type: 'result',
        id,
        data: (typeof message['data'] === 'object' && message['data'] !== null
          ? message['data']
          : {}) as Readonly<Record<string, unknown>>,
      };
    case 'error':
      if (id === undefined) break;
      return {
        type: 'error',
        id,
        errorType: typeof message['errorType'] === 'string' ? message['errorType'] : 'unknown',
        message: typeof message['message'] === 'string' ? message['message'] : trimmed,
      };
    case 'cancelled':
      if (id === undefined) break;
      return { type: 'cancelled', id };
    case 'log':
      return {
        type: 'log',
        ...(id === undefined ? {} : { id }),
        message: typeof message['message'] === 'string' ? message['message'] : trimmed,
      };
    default:
      break;
  }
  return { type: 'log', message: trimmed };
}

/** Splits a stream of chunks into complete lines, holding the partial tail between calls. */
export class LineSplitter {
  private pending = '';

  push(chunk: string): string[] {
    this.pending += chunk;
    const lines = this.pending.split(/\r?\n/);
    this.pending = lines.pop() ?? '';
    return lines;
  }

  /** Whatever is left when the stream ends — a final line with no newline still counts. */
  flush(): string[] {
    const rest = this.pending;
    this.pending = '';
    return rest === '' ? [] : [rest];
  }
}
