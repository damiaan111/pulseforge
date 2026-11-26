// LUTs on the GPU (S11): each parsed table as a 3D texture, keyed by the file's content hash — the
// same keying as images, so a project that references a LUT twice uploads it once.
//
// RGB16F with linear filtering: trilinear interpolation between table points is what every grading
// application does, half floats are filterable in core WebGL2 (32-bit floats would need an
// extension), and 11 bits of mantissa is far finer than an 8- or 10-bit output can show.

import type { Lut3D } from '../core/lut.ts';

export interface LutTexture {
  readonly texture: WebGLTexture;
  readonly size: number;
  readonly domainMin: readonly [number, number, number];
  readonly domainMax: readonly [number, number, number];
  readonly title: string;
}

export class LutStore {
  private readonly gl: WebGL2RenderingContext;
  private readonly luts = new Map<string, LutTexture>();

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
  }

  set(hash: string, lut: Lut3D): void {
    const gl = this.gl;
    this.delete(hash);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, texture);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    // Width is red, height green, depth blue: exactly the .cube order (red fastest).
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, lut.size, lut.size, lut.size, 0, gl.RGB, gl.FLOAT, lut.data);
    gl.bindTexture(gl.TEXTURE_3D, null);
    this.luts.set(hash, { texture, size: lut.size, domainMin: lut.domainMin, domainMax: lut.domainMax, title: lut.title });
  }

  has(hash: string): boolean {
    return this.luts.has(hash);
  }

  get(hash: string): LutTexture | undefined {
    return this.luts.get(hash);
  }

  dispose(): void {
    for (const hash of [...this.luts.keys()]) this.delete(hash);
  }

  private delete(hash: string): void {
    const found = this.luts.get(hash);
    if (found === undefined) return;
    this.gl.deleteTexture(found.texture);
    this.luts.delete(hash);
  }
}
