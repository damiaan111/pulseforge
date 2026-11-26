// RGB → NV12 on the GPU (export-spec §4.4 option b, D39 — chosen from P0 measurements).
//
// NV12 is 12 bits per pixel against RGBA's 32, which shrinks both the GPU readback and the
// pipe into FFmpeg by ~2.7× and removes the CPU colour conversion.
//
// Packing trick: both planes are rendered into ordinary RGBA8 targets so readback only ever
// uses RGBA/UNSIGNED_BYTE, the one read format every WebGL2 implementation must support.
//   Y  plane: target (w/4) × h,     each texel holds 4 consecutive luma samples.
//   UV plane: target (w/4) × (h/2), each texel holds U,V,U,V for 2 chroma columns.
// Read back row by row, the bytes are exactly NV12's layout. Requires w % 4 == 0, h % 2 == 0.
//
// Matrix: BT.709, limited range (Y 16–235, Cb/Cr 16–240), applied to the sRGB-encoded 8-bit
// output — the same input swscale would receive. Chroma is a 2×2 box average (centre siting).

import { FULLSCREEN_VERT, RenderSetupError, createProgram, drawFullscreenTriangle, uniformLocation } from './gl.ts';
import type { RenderTarget, TargetPool } from './targets.ts';

export function nv12Supported(width: number, height: number): boolean {
  return width % 4 === 0 && height % 2 === 0;
}

export function nv12Bytes(width: number, height: number): number {
  return width * height + (width / 2) * (height / 2) * 2;
}

const MATRIX_GLSL = /* glsl */ `
const vec3 PF_709_Y = vec3(0.2126, 0.7152, 0.0722);
float pf_y(vec3 c) { return (16.0 + 219.0 * dot(PF_709_Y, c)) / 255.0; }
vec2 pf_uv(vec3 c) {
  float y = dot(PF_709_Y, c);
  float u = (c.b - y) / 1.8556;
  float v = (c.r - y) / 1.5748;
  return (128.0 + 224.0 * vec2(u, v)) / 255.0;
}
`;

const Y_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_rgb;
out vec4 outColor;
${MATRIX_GLSL}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int x = p.x * 4;
  outColor = vec4(
    pf_y(texelFetch(u_rgb, ivec2(x, p.y), 0).rgb),
    pf_y(texelFetch(u_rgb, ivec2(x + 1, p.y), 0).rgb),
    pf_y(texelFetch(u_rgb, ivec2(x + 2, p.y), 0).rgb),
    pf_y(texelFetch(u_rgb, ivec2(x + 3, p.y), 0).rgb));
}
`;

const UV_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_rgb;
out vec4 outColor;
${MATRIX_GLSL}
vec2 chroma(int cx, int cy) {
  ivec2 s = ivec2(cx * 2, cy * 2);
  vec3 avg = (texelFetch(u_rgb, s, 0).rgb + texelFetch(u_rgb, s + ivec2(1, 0), 0).rgb
            + texelFetch(u_rgb, s + ivec2(0, 1), 0).rgb + texelFetch(u_rgb, s + ivec2(1, 1), 0).rgb) * 0.25;
  return pf_uv(avg);
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  outColor = vec4(chroma(p.x * 2, p.y), chroma(p.x * 2 + 1, p.y));
}
`;

export class Nv12Converter {
  private readonly gl: WebGL2RenderingContext;
  private readonly pool: TargetPool;
  private readonly vao: WebGLVertexArrayObject;
  private readonly yProgram: WebGLProgram;
  private readonly uvProgram: WebGLProgram;
  private readonly yInput: WebGLUniformLocation;
  private readonly uvInput: WebGLUniformLocation;
  private planes: { y: RenderTarget; uv: RenderTarget } | undefined;

  constructor(gl: WebGL2RenderingContext, pool: TargetPool) {
    this.gl = gl;
    this.pool = pool;
    this.vao = gl.createVertexArray();
    this.yProgram = createProgram(gl, 'nv12.y', FULLSCREEN_VERT, Y_FRAG);
    this.uvProgram = createProgram(gl, 'nv12.uv', FULLSCREEN_VERT, UV_FRAG);
    this.yInput = uniformLocation(gl, this.yProgram, 'u_rgb');
    this.uvInput = uniformLocation(gl, this.uvProgram, 'u_rgb');
  }

  /** Converts `rgb` (8-bit, top-down output) into the NV12 plane targets. */
  convert(rgb: RenderTarget): void {
    const gl = this.gl;
    const { width, height } = rgb;
    if (rgb.format !== 'rgba8') throw new RenderSetupError('NV12 conversion needs the 8-bit output target');
    if (!nv12Supported(width, height)) throw new RenderSetupError(`NV12 packing needs width divisible by 4 and even height, got ${width}×${height}`);
    if (this.planes === undefined || this.planes.y.height !== height || this.planes.y.width !== width / 4) {
      this.releasePlanes();
      this.planes = { y: this.pool.acquire(width / 4, height, 'rgba8'), uv: this.pool.acquire(width / 4, height / 2, 'rgba8') };
    }
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, rgb.texture);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.planes.y.framebuffer);
    gl.viewport(0, 0, width / 4, height);
    gl.useProgram(this.yProgram);
    gl.uniform1i(this.yInput, 0);
    drawFullscreenTriangle(gl, this.vao);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.planes.uv.framebuffer);
    gl.viewport(0, 0, width / 4, height / 2);
    gl.useProgram(this.uvProgram);
    gl.uniform1i(this.uvInput, 0);
    drawFullscreenTriangle(gl, this.vao);

    gl.useProgram(null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Reads both planes into `into` (nv12Bytes long), blocking on the GPU. */
  readSync(into: Uint8Array): void {
    const gl = this.gl;
    const planes = this.planes;
    if (planes === undefined) throw new Error('Nv12Converter.readSync called before convert');
    const ySize = planes.y.width * 4 * planes.y.height;
    if (into.length !== ySize + planes.uv.width * 4 * planes.uv.height) throw new RangeError(`NV12 buffer is ${into.length} bytes, expected ${ySize + planes.uv.width * 4 * planes.uv.height}`);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    gl.bindFramebuffer(gl.FRAMEBUFFER, planes.y.framebuffer);
    gl.readPixels(0, 0, planes.y.width, planes.y.height, gl.RGBA, gl.UNSIGNED_BYTE, into.subarray(0, ySize));
    gl.bindFramebuffer(gl.FRAMEBUFFER, planes.uv.framebuffer);
    gl.readPixels(0, 0, planes.uv.width, planes.uv.height, gl.RGBA, gl.UNSIGNED_BYTE, into.subarray(ySize));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  dispose(): void {
    this.releasePlanes();
    this.gl.deleteProgram(this.yProgram);
    this.gl.deleteProgram(this.uvProgram);
    this.gl.deleteVertexArray(this.vao);
  }

  private releasePlanes(): void {
    if (this.planes === undefined) return;
    this.pool.release(this.planes.y);
    this.pool.release(this.planes.uv);
    this.planes = undefined;
  }
}
