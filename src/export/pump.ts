// The offline frame pump (export-spec §1 steps 3–6, §4.2).
//
// Render, readback and encode overlap: while frame n transfers, n+1 renders and n−2 is being
// written. Everything is bounded: at most `readback.depth` frames on the GPU side and
// `maxQueuedWrites` frames waiting on FFmpeg's stdin. When FFmpeg falls behind, the buffer
// pool runs dry and the pump stops rendering, so memory stays flat.
//
// Frames reach the sink strictly in index order: the readback ring is FIFO.
// No GL, Node or Electron types here — the pump is unit-tested with fakes.

export interface PumpSource {
  /**
   * Awaited before `renderFrame`, for inputs the host must fetch rather than compute — a video
   * layer's frame comes off disk and is decoded (M39). Rendering stays synchronous and
   * deterministic; only the fetching is asynchronous.
   */
  prepareFrame?(frameIndex: number): Promise<void>;
  renderFrame(frameIndex: number): void;
  readback: {
    readonly depth: number;
    readonly bytesPerFrame: number;
    hasFreeSlot(): boolean;
    pendingCount(): number;
    submit(): void;
    oldestReady(): boolean;
    collectOldest(into: Uint8Array): void;
  };
}

export interface PumpSink {
  /** Resolves once the sink no longer needs `frame`'s bytes (so the buffer can be reused). */
  write(frame: Uint8Array): Promise<void>;
}

export interface PumpOptions {
  readonly frameCount: number;
  readonly source: PumpSource;
  readonly sink: PumpSink;
  readonly maxQueuedWrites: number;
  readonly now: () => number;
  /** Lets GPU and I/O callbacks run while the pump waits. */
  readonly yieldToEventLoop: () => Promise<void>;
  /** Called with each frame's bytes, in order, before they are written (hashing, thumbnails). */
  readonly onFrame?: (frameIndex: number, bytes: Uint8Array) => void;
  readonly onProgress?: (framesSubmitted: number, framesCollected: number) => void;
  readonly isCancelled?: () => boolean;
}

export interface PumpStats {
  frames: number;
  wallMs: number;
  /** CPU time issuing render commands (GL is async: GPU work shows up as waitGpuMs). */
  renderMs: number;
  /** Waiting for readback fences, i.e. for the GPU. */
  waitGpuMs: number;
  /** Copying finished PBOs to host memory. */
  collectMs: number;
  /** onFrame callbacks (hashing). */
  onFrameMs: number;
  /** Waiting for FFmpeg to accept earlier frames. */
  waitEncoderMs: number;
  maxPendingReadbacks: number;
  maxQueuedWrites: number;
  cancelled: boolean;
}

export class PumpCancelled extends Error {
  constructor() {
    super('export cancelled');
    this.name = 'PumpCancelled';
  }
}

class BufferPool {
  private readonly free: Uint8Array[];
  private readonly waiters: Array<(buffer: Uint8Array) => void> = [];
  inUse = 0;

  constructor(bytes: number, count: number) {
    this.free = Array.from({ length: count }, () => new Uint8Array(new ArrayBuffer(bytes)));
  }

  acquire(): Promise<Uint8Array> {
    const buffer = this.free.pop();
    if (buffer !== undefined) {
      this.inUse++;
      return Promise.resolve(buffer);
    }
    return new Promise((resolve) => this.waiters.push((b) => {
      this.inUse++;
      resolve(b);
    }));
  }

  release(buffer: Uint8Array): void {
    this.inUse--;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter(buffer);
    else this.free.push(buffer);
  }
}

export async function pumpFrames(options: PumpOptions): Promise<PumpStats> {
  const { source, sink, now } = options;
  const { readback } = source;
  const pool = new BufferPool(readback.bytesPerFrame, readback.depth + options.maxQueuedWrites);
  const inFlightWrites = new Set<Promise<void>>();
  let writeError: unknown;
  let collected = 0;
  const stats: PumpStats = {
    frames: options.frameCount,
    wallMs: 0,
    renderMs: 0,
    waitGpuMs: 0,
    collectMs: 0,
    onFrameMs: 0,
    waitEncoderMs: 0,
    maxPendingReadbacks: 0,
    maxQueuedWrites: 0,
    cancelled: false,
  };
  const start = now();

  const throwIfFailed = () => {
    if (writeError !== undefined) throw writeError;
  };

  const collectOne = async () => {
    const waitStart = now();
    const buffer = await pool.acquire();
    stats.waitEncoderMs += now() - waitStart;
    throwIfFailed();

    const collectStart = now();
    readback.collectOldest(buffer);
    stats.collectMs += now() - collectStart;

    if (options.onFrame !== undefined) {
      const hookStart = now();
      options.onFrame(collected, buffer);
      stats.onFrameMs += now() - hookStart;
    }
    collected++;

    const write = sink.write(buffer).then(
      () => pool.release(buffer),
      (error: unknown) => {
        writeError ??= error;
        pool.release(buffer);
      },
    );
    inFlightWrites.add(write);
    void write.finally(() => inFlightWrites.delete(write));
    stats.maxQueuedWrites = Math.max(stats.maxQueuedWrites, pool.inUse);
    options.onProgress?.(-1, collected);
  };

  /** Collects frames that are already finished, without waiting. */
  const collectReady = async () => {
    while (readback.pendingCount() > 0 && readback.oldestReady()) await collectOne();
  };

  /** Waits for the oldest frame, then collects it. */
  const collectOldestBlocking = async () => {
    const waitStart = now();
    while (!readback.oldestReady()) {
      throwIfFailed();
      await options.yieldToEventLoop();
    }
    stats.waitGpuMs += now() - waitStart;
    await collectOne();
  };

  for (let frameIndex = 0; frameIndex < options.frameCount; frameIndex++) {
    if (options.isCancelled?.() === true) {
      stats.cancelled = true;
      break;
    }
    throwIfFailed();
    while (!readback.hasFreeSlot()) await collectOldestBlocking();

    const renderStart = now();
    if (source.prepareFrame !== undefined) await source.prepareFrame(frameIndex);
    source.renderFrame(frameIndex);
    readback.submit();
    stats.renderMs += now() - renderStart;
    stats.maxPendingReadbacks = Math.max(stats.maxPendingReadbacks, readback.pendingCount());
    options.onProgress?.(frameIndex + 1, collected);

    await collectReady();
  }

  if (!stats.cancelled) {
    while (readback.pendingCount() > 0) await collectOldestBlocking();
  }
  await Promise.all([...inFlightWrites]);
  throwIfFailed();
  stats.wallMs = now() - start;
  if (stats.cancelled) throw new PumpCancelled();
  return stats;
}
