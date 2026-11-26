// Pooled render targets (compositor-spec §4): keyed by size and format, recycled,
// never allocated per frame. Intermediates are RGBA16F (compositor-spec §1).

import { RenderSetupError } from './gl.ts';

/**
 * rgb10a2 is the 10-bit output target for the HEVC master (export-spec §4.3). rgba32f holds the
 * motion-blur accumulator (export-spec §9), where half floats would round on every subframe.
 */
export type TargetFormat = 'rgba16f' | 'rgba32f' | 'rgba8' | 'rgb10a2';

function internalFormat(gl: WebGL2RenderingContext, format: TargetFormat): number {
  switch (format) {
    case 'rgba16f':
      return gl.RGBA16F;
    case 'rgba32f':
      return gl.RGBA32F;
    case 'rgba8':
      return gl.RGBA8;
    case 'rgb10a2':
      return gl.RGB10_A2;
  }
}

export interface RenderTarget {
  readonly width: number;
  readonly height: number;
  readonly format: TargetFormat;
  readonly texture: WebGLTexture;
  readonly framebuffer: WebGLFramebuffer;
}

function allocate(gl: WebGL2RenderingContext, width: number, height: number, format: TargetFormat): RenderTarget {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, internalFormat(gl, format), width, height);
  // Nearest: the compositor samples 1:1; filtering choices belong to effects that scale.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);

  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
    throw new RenderSetupError(`Could not create a ${width}×${height} ${format} render target (framebuffer status 0x${status.toString(16)}). Out of VRAM?`);
  }
  return { width, height, format, texture, framebuffer };
}

export class TargetPool {
  private readonly gl: WebGL2RenderingContext;
  private readonly free = new Map<string, RenderTarget[]>();
  private readonly all = new Set<RenderTarget>();
  private inUse = 0;
  private highWater = 0;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
  }

  acquire(width: number, height: number, format: TargetFormat): RenderTarget {
    const key = `${width}x${height}:${format}`;
    const target = this.free.get(key)?.pop() ?? this.create(width, height, format);
    this.inUse++;
    this.highWater = Math.max(this.highWater, this.inUse);
    return target;
  }

  release(target: RenderTarget): void {
    const key = `${target.width}x${target.height}:${target.format}`;
    const list = this.free.get(key) ?? [];
    list.push(target);
    this.free.set(key, list);
    this.inUse--;
  }

  /** Peak simultaneous targets, for the render report (compositor-spec §4). */
  get highWaterMark(): number {
    return this.highWater;
  }

  dispose(): void {
    for (const target of this.all) {
      this.gl.deleteFramebuffer(target.framebuffer);
      this.gl.deleteTexture(target.texture);
    }
    this.all.clear();
    this.free.clear();
  }

  private create(width: number, height: number, format: TargetFormat): RenderTarget {
    const target = allocate(this.gl, width, height, format);
    this.all.add(target);
    return target;
  }
}
