// Asynchronous readback through a ring of pixel buffer objects (export-spec §4.2).
//
// submit() queues a GPU-side copy of the output target into a PBO and drops a fence;
// isReady() polls that fence without blocking; collect() copies the finished PBO to host
// memory. WebGL2 has no mapBufferRange, so collect() is always a copy — but it never waits
// on the GPU, so rendering the next frame proceeds while earlier ones transfer.
//
// No waiting or scheduling lives here (the engine may not touch timers): the export pump
// decides when to yield and poll again.

import { RenderSetupError } from './gl.ts';
import type { RenderTarget } from './targets.ts';

interface Slot {
  readonly buffer: WebGLBuffer;
  sync: WebGLSync | null;
}

export interface ReadbackFormat {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: 8 | 10;
}

/** 4 bytes per pixel at both depths: RGBA8, or packed 2-10-10-10 (little-endian = FFmpeg x2bgr10le). */
export function bytesPerFrame(format: ReadbackFormat): number {
  return format.width * format.height * 4;
}

export class AsyncReadback {
  readonly depth: number;
  readonly format: ReadbackFormat;
  private readonly gl: WebGL2RenderingContext;
  private readonly slots: Slot[];
  /** Slot indices in submission order; the head is the oldest frame. */
  private readonly pending: number[] = [];
  private readonly free: number[] = [];

  constructor(gl: WebGL2RenderingContext, format: ReadbackFormat, depth: number) {
    if (!Number.isInteger(depth) || depth < 1 || depth > 16) throw new RangeError(`readback depth must be 1..16, got ${depth}`);
    this.gl = gl;
    this.format = format;
    this.depth = depth;
    const size = bytesPerFrame(format);
    this.slots = Array.from({ length: depth }, (_, i) => {
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, size, gl.STREAM_READ);
      this.free.push(i);
      return { buffer, sync: null };
    });
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    if (gl.getError() === gl.OUT_OF_MEMORY) {
      this.dispose();
      throw new RenderSetupError(`Out of GPU memory allocating ${depth} readback buffers of ${size} bytes. Lower the readback depth.`);
    }
  }

  hasFreeSlot(): boolean {
    return this.free.length > 0;
  }

  pendingCount(): number {
    return this.pending.length;
  }

  /** Queues a copy of `target` (the just-rendered output). Requires a free slot. */
  submit(target: RenderTarget): void {
    const gl = this.gl;
    const index = this.free.shift();
    const slot = index === undefined ? undefined : this.slots[index];
    if (index === undefined || slot === undefined) throw new Error('AsyncReadback.submit called with no free slot; check hasFreeSlot() first');
    if (target.width !== this.format.width || target.height !== this.format.height) {
      throw new RangeError(`readback is ${this.format.width}×${this.format.height} but the output is ${target.width}×${target.height}`);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.buffer);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    gl.readPixels(0, 0, target.width, target.height, gl.RGBA, readType(gl, this.format.bitDepth), 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    slot.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush(); // start the GPU on it now rather than at the next implicit flush
    this.pending.push(index);
  }

  /** Whether the oldest submitted frame has finished transferring. Never blocks. */
  oldestReady(): boolean {
    const index = this.pending[0];
    const slot = index === undefined ? undefined : this.slots[index];
    if (slot?.sync === null || slot === undefined) return false;
    const status = this.gl.clientWaitSync(slot.sync, 0, 0);
    if (status === this.gl.WAIT_FAILED) throw new RenderSetupError('GPU readback fence failed (context lost?)');
    return status === this.gl.ALREADY_SIGNALED || status === this.gl.CONDITION_SATISFIED;
  }

  /** Copies the oldest finished frame into `into` (bytesPerFrame bytes) and frees its slot. */
  collectOldest(into: Uint8Array): void {
    const gl = this.gl;
    const index = this.pending.shift();
    const slot = index === undefined ? undefined : this.slots[index];
    if (index === undefined || slot === undefined) throw new Error('AsyncReadback.collectOldest called with nothing pending');
    if (into.length !== bytesPerFrame(this.format)) throw new RangeError(`readback buffer is ${into.length} bytes, expected ${bytesPerFrame(this.format)}`);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.buffer);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, into);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    if (slot.sync !== null) gl.deleteSync(slot.sync);
    slot.sync = null;
    this.free.push(index);
  }

  dispose(): void {
    for (const slot of this.slots) {
      if (slot.sync !== null) this.gl.deleteSync(slot.sync);
      this.gl.deleteBuffer(slot.buffer);
    }
    this.pending.length = 0;
    this.free.length = 0;
  }
}

export function readType(gl: WebGL2RenderingContext, bitDepth: 8 | 10): number {
  return bitDepth === 10 ? gl.UNSIGNED_INT_2_10_10_10_REV : gl.UNSIGNED_BYTE;
}

/** Synchronous read of `target` into `into` — the baseline async readback is measured against. */
export function readSync(gl: WebGL2RenderingContext, target: RenderTarget, bitDepth: 8 | 10, into: Uint8Array): void {
  gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
  gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
  if (bitDepth === 10) {
    if (into.byteOffset % 4 !== 0) throw new RangeError('10-bit readback needs a 4-byte-aligned buffer');
    gl.readPixels(0, 0, target.width, target.height, gl.RGBA, gl.UNSIGNED_INT_2_10_10_10_REV, new Uint32Array(into.buffer, into.byteOffset, into.length / 4));
  } else {
    gl.readPixels(0, 0, target.width, target.height, gl.RGBA, gl.UNSIGNED_BYTE, into);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}
