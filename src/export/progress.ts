// Render progress and ETA (export-spec §13).
//
// Two rules, both the result of the naive version being actively misleading:
//
//  1. **Count the encoder's frames, not the pump's.** The pump runs several frames ahead, so
//     reporting its position makes a render appear to finish and then hang for the last second.
//  2. **ETA from a moving window, not from the average since the start.** A heavy section early
//     on poisons a cumulative average for the rest of the render, and the estimate then crawls
//     downward long after the render has sped up. A window forgets.
//
// Pure and clock-injected, so the numbers are testable without rendering anything.

/** Samples older than this are dropped from the rate estimate. */
const DEFAULT_WINDOW_MS = 10_000;

export interface ProgressSnapshot {
  readonly frame: number;
  readonly total: number;
  /** 0..1. Exactly 1 only when every frame is encoded. */
  readonly fraction: number;
  /** Frames per second over the window; 0 until two samples exist. */
  readonly fps: number;
  /** Milliseconds remaining, or undefined while there is no rate to extrapolate from. */
  readonly etaMs: number | undefined;
  readonly elapsedMs: number;
}

export interface ProgressTrackerOptions {
  readonly total: number;
  /** Milliseconds, monotonic. Injected so tests are deterministic. */
  readonly now: () => number;
  readonly windowMs?: number;
}

export class ProgressTracker {
  private readonly total: number;
  private readonly now: () => number;
  private readonly windowMs: number;
  private readonly samples: { at: number; frame: number }[] = [];
  private readonly startedAt: number;
  private frame = 0;

  constructor(options: ProgressTrackerOptions) {
    this.total = Math.max(0, options.total);
    this.now = options.now;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.startedAt = options.now();
    this.samples.push({ at: this.startedAt, frame: 0 });
  }

  /**
   * Record the encoder's frame count. Monotonic by construction: a lower number than the last
   * is ignored rather than trusted, because FFmpeg's progress stream can repeat a line and a
   * backwards jump would produce a negative rate and a nonsense ETA.
   */
  update(encodedFrames: number): void {
    const frame = Math.min(this.total, Math.max(this.frame, Math.floor(encodedFrames)));
    this.frame = frame;
    const at = this.now();
    this.samples.push({ at, frame });
    const cutoff = at - this.windowMs;
    // Drop everything before the window, keeping exactly one sample at or before its start as the
    // baseline to measure from. `<=` matters: with `<`, a sample landing exactly on the cutoff
    // survives forever and the "window" silently becomes the whole render — which is the
    // cumulative average this class exists to avoid.
    while (this.samples.length > 2 && (this.samples[1] as { at: number }).at <= cutoff) this.samples.shift();
  }

  get snapshot(): ProgressSnapshot {
    const at = this.now();
    const first = this.samples[0] as { at: number; frame: number };
    const spanMs = at - first.at;
    const framesInWindow = this.frame - first.frame;
    const fps = spanMs > 0 && framesInWindow > 0 ? (framesInWindow * 1000) / spanMs : 0;
    const remaining = this.total - this.frame;
    return {
      frame: this.frame,
      total: this.total,
      fraction: this.total === 0 ? 0 : this.frame / this.total,
      fps,
      etaMs: fps > 0 && remaining > 0 ? (remaining / fps) * 1000 : undefined,
      elapsedMs: at - this.startedAt,
    };
  }
}

/** `1h 04m 12s`, `4m 12s`, `12s` — the shape a progress line wants. */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}
