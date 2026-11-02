// GPU time per layer (S12, PROJECT.md §8.15): the performance HUD's numbers and the render report's
// per-layer cost.
//
// WebGL2's EXT_disjoint_timer_query_webgl2 gives TIME_ELAPSED queries — no timestamps here (the
// counter has 0 bits on this machine's ANGLE), and no nesting: one query open at a time. So a frame
// is timed as a sequence of spans, one per top-level layer (a group's children run inside it, a
// mask's source inside the layer it masks), then the whole-frame effects and the output pass.
//
// Results arrive frames later; they are read without blocking once available, and a frame is
// dropped whole when the GPU reports a disjoint event (a clock change or preemption), because its
// numbers would be wrong rather than merely late. Profiling observes only — nothing it does changes
// a pixel — so determinism is untouched.

/** One frame's measured spans, in milliseconds, by key (a layer id, `global` or `output`). */
export interface GpuFrameTimings {
  readonly frameIndex: number;
  readonly spans: ReadonlyMap<string, number>;
  readonly totalMs: number;
}

/** Everything measured since the profiler was (re)started: per key, mean and worst frame. */
export interface GpuTimingSummary {
  readonly frames: number;
  readonly spans: readonly { readonly key: string; readonly meanMs: number; readonly maxMs: number }[];
  readonly meanTotalMs: number;
  readonly maxTotalMs: number;
  /** Frames thrown away: a disjoint event on the GPU, or too many still waiting for results. */
  readonly discarded: number;
}

interface PendingFrame {
  readonly frameIndex: number;
  readonly queries: { readonly key: string; readonly query: WebGLQuery }[];
}

/**
 * Frames whose results may still be in flight. WebGL makes query results available only once the
 * page returns to its event loop, so a caller rendering many frames in one synchronous run piles
 * them up; past this many the oldest are dropped (and counted as discarded) rather than growing
 * without bound. The preview and the export pump yield every frame or few, and never get close.
 */
const MAX_PENDING = 600;

export class GpuProfiler {
  private readonly gl: WebGL2RenderingContext;
  private readonly ext: { readonly TIME_ELAPSED_EXT: number; readonly GPU_DISJOINT_EXT: number } | null;
  private pending: PendingFrame[] = [];
  private current: PendingFrame | null = null;
  private open: { key: string; query: WebGLQuery } | null = null;
  private latestFrame: GpuFrameTimings | null = null;
  private sums = new Map<string, { total: number; max: number }>();
  private frameTotals = { frames: 0, total: 0, max: 0, discarded: 0 };

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  }

  /** False where the driver or browser does not expose timer queries; the HUD then says so. */
  get available(): boolean {
    return this.ext !== null;
  }

  beginFrame(frameIndex: number): void {
    if (this.ext === null) return;
    this.current = { frameIndex, queries: [] };
  }

  /** Opens a span; a span already open is closed first (they cannot nest). */
  begin(key: string): void {
    if (this.ext === null || this.current === null) return;
    if (this.open !== null) this.end();
    const query = this.gl.createQuery();
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
    this.open = { key, query };
  }

  end(): void {
    if (this.ext === null || this.open === null || this.current === null) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.current.queries.push(this.open);
    this.open = null;
  }

  endFrame(): void {
    if (this.ext === null || this.current === null) return;
    if (this.open !== null) this.end();
    this.pending.push(this.current);
    this.current = null;
    while (this.pending.length > MAX_PENDING) {
      this.release(this.pending.shift() as PendingFrame);
      this.frameTotals.discarded += 1;
    }
    this.poll();
  }

  /** Reads every frame whose results are in, oldest first, without waiting for any. */
  poll(): void {
    const ext = this.ext;
    if (ext === null) return;
    const gl = this.gl;
    // A disjoint event invalidates everything in flight: drop it all rather than report wrong times.
    if (gl.getParameter(ext.GPU_DISJOINT_EXT) === true) {
      this.frameTotals.discarded += this.pending.length;
      for (const frame of this.pending) this.release(frame);
      this.pending = [];
      return;
    }
    while (this.pending.length > 0) {
      const frame = this.pending[0] as PendingFrame;
      const last = frame.queries[frame.queries.length - 1];
      if (last !== undefined && gl.getQueryParameter(last.query, gl.QUERY_RESULT_AVAILABLE) !== true) return;
      this.pending.shift();
      const spans = new Map<string, number>();
      for (const { key, query } of frame.queries) {
        const ms = (gl.getQueryParameter(query, gl.QUERY_RESULT) as number) / 1e6;
        spans.set(key, (spans.get(key) ?? 0) + ms);
      }
      this.release(frame);
      let totalMs = 0;
      for (const [key, ms] of spans) {
        totalMs += ms;
        const sum = this.sums.get(key) ?? { total: 0, max: 0 };
        this.sums.set(key, { total: sum.total + ms, max: Math.max(sum.max, ms) });
      }
      this.frameTotals.frames += 1;
      this.frameTotals.total += totalMs;
      this.frameTotals.max = Math.max(this.frameTotals.max, totalMs);
      this.latestFrame = { frameIndex: frame.frameIndex, spans, totalMs };
    }
  }

  /** The most recent frame whose results are in; null until one is. */
  latest(): GpuFrameTimings | null {
    return this.latestFrame;
  }

  summary(): GpuTimingSummary {
    const frames = this.frameTotals.frames;
    return {
      frames,
      spans: [...this.sums].map(([key, s]) => ({ key, meanMs: frames > 0 ? s.total / frames : 0, maxMs: s.max }))
        .sort((a, b) => b.meanMs - a.meanMs),
      meanTotalMs: frames > 0 ? this.frameTotals.total / frames : 0,
      maxTotalMs: this.frameTotals.max,
      discarded: this.frameTotals.discarded,
    };
  }

  /** Forgets everything measured (for example when the HUD is opened again). */
  reset(): void {
    for (const frame of this.pending) this.release(frame);
    this.pending = [];
    this.latestFrame = null;
    this.sums = new Map();
    this.frameTotals = { frames: 0, total: 0, max: 0, discarded: 0 };
  }

  dispose(): void {
    if (this.open !== null) {
      if (this.ext !== null) this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
      this.gl.deleteQuery(this.open.query);
      this.open = null;
    }
    this.reset();
  }

  private release(frame: PendingFrame): void {
    for (const { query } of frame.queries) this.gl.deleteQuery(query);
  }
}
