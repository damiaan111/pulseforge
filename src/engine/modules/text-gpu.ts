// GPU plumbing shared by the text layer (text.ts) and the lyrics layer (lyrics.ts): uploading a
// rasterised text block, its word-id map, the per-word visibility pass, and the blur sampling the
// shadow, glow and blur-in effects use. One implementation, so a title and a karaoke line with the
// same style are drawn by the same code and cannot drift apart.
//
// See text.ts for why the masks are mipmapped and why per-word visibility is a separate pass.

import { parseHexColor, srgbToLinear } from '../core/color.ts';
import type { TextRaster } from '../core/text.ts';
import { FULLSCREEN_VERT, createProgram, drawFullscreenTriangle, uniformLocation } from '../render/gl.ts';

/** Words beyond this share id 0 ("not in a word") — the id map is 16-bit and the table one row. */
export const MAX_WORDS = 4096;

export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/**
 * Mask sampling helpers, for insertion into a fragment shader that declares `u_mask` (RG: fill,
 * outline) and `u_bitmap` (bitmap size, px).
 */
export const TEXT_SAMPLING_GLSL = /* glsl */ `
float inside(vec2 uv) {
  return step(0.0, uv.x) * step(0.0, uv.y) * step(uv.x, 1.0) * step(uv.y, 1.0);
}

vec2 maskAt(vec2 uv, float lod) {
  return textureLod(u_mask, uv, lod).rg * inside(uv);
}

// Fill and outline together, softened: a ring of eight taps one mip level finer than asked, plus
// the centre. Smoother than a single coarse mip, which shows its block structure as a halo.
float coverage(vec2 uv, float lod) {
  float level = max(0.0, lod - 1.0);
  vec2 radius = pow(2.0, lod) * 0.8 / u_bitmap;
  vec2 m = maskAt(uv, level);
  float sum = max(m.r, m.g) * 2.0;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.785398;
    vec2 s = maskAt(uv + vec2(cos(a), sin(a)) * radius, level);
    sum += max(s.r, s.g);
  }
  return sum / 10.0;
}

float roundedBox(vec2 p, vec2 half_, float r) {
  vec2 q = abs(p) - half_ + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
`;

/**
 * Pass 1, only while a per-word animation runs: fill (R) and outline (G) multiplied by each word's
 * visibility, into the layer's own mask texture, whose mipmaps are then rebuilt. Blur samples that
 * texture, so a hidden word contributes nothing to its neighbours' glow — sampling the static mask's
 * mipmaps and masking afterwards smeared hidden words into hard-edged streaks.
 */
const MASK_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_base;    // RG8: fill, outline
uniform sampler2D u_ids;     // RG8: 1-based word id, little-endian
uniform sampler2D u_wordVis; // R8: visibility per id, [0] = not in a word
uniform float u_wordCount;
out vec4 outColor;
void main() {
  ivec2 texel = ivec2(gl_FragCoord.xy);
  vec2 rg = texelFetch(u_ids, texel, 0).rg;
  float id = floor(rg.r * 255.0 + 0.5) + 256.0 * floor(rg.g * 255.0 + 0.5);
  float vis = texelFetch(u_wordVis, ivec2(int(min(id, u_wordCount)), 0), 0).r;
  outColor = vec4(texelFetch(u_base, texel, 0).rg * vis, 0.0, 1.0);
}
`;

export interface UploadedText {
  readonly key: string;
  readonly raster: TextRaster;
  /** RG8 fill + outline as rasterised; sampled directly when no per-word animation runs. */
  readonly base: WebGLTexture;
  /** RG8 word ids. */
  readonly ids: WebGLTexture;
  /** RG8 base × word visibility, rebuilt per frame during per-word animation. */
  readonly masked: WebGLTexture;
  readonly maskedFramebuffer: WebGLFramebuffer;
  /** sRGB colour of the raster's colour glyphs, or null when it has none. */
  readonly color: WebGLTexture | null;
}

export function rg8Texture(gl: WebGL2RenderingContext, width: number, height: number, data: Uint8Array | null, mipmaps: boolean): WebGLTexture {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, width, height, 0, gl.RG, gl.UNSIGNED_BYTE, data);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  if (mipmaps) {
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  } else {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  }
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

/**
 * Uploads a raster: the fill/outline masks, and the word-id map over each word's box grown by the
 * outline (so the outline belongs to its word) plus `liftPx` upward (room for a word that rises,
 * the karaoke pop). Vertically a box stops halfway into the gap to the neighbouring line: with tight
 * line height boxes overlap, and a later line's box used to overwrite the descenders above it.
 */
export function uploadTextRaster(gl: WebGL2RenderingContext, key: string, raster: TextRaster, strokePx: number, liftPx = 0): UploadedText {
  const { width, height } = raster;
  const base = new Uint8Array(width * height * 2);
  for (let i = 0; i < width * height; i += 1) {
    base[i * 2] = raster.fill[i] ?? 0;
    base[i * 2 + 1] = raster.stroke?.[i] ?? 0;
  }
  const ids = new Uint8Array(width * height * 2);
  const grow = Math.ceil(strokePx) + 1;
  const lineTop = (line: number) => raster.words.find((w) => w.line === line)?.y;
  const lineBottom = (line: number) => {
    const word = raster.words.find((w) => w.line === line);
    return word === undefined ? undefined : word.y + word.height;
  };
  raster.words.slice(0, MAX_WORDS).forEach((word, index) => {
    const id = index + 1;
    const wordBottom = word.y + word.height;
    // Vertical columns stand side by side, so a neighbouring column is no limit on height.
    const above = raster.vertical === true ? undefined : lineBottom(word.line - 1);
    const below = raster.vertical === true ? undefined : lineTop(word.line + 1);
    const top = Math.max(word.y - grow - Math.ceil(liftPx), above === undefined ? -Infinity : (above + word.y) / 2);
    const bottom = Math.min(wordBottom + grow, below === undefined ? Infinity : (wordBottom + below) / 2);
    const x0 = Math.max(0, Math.floor(word.x) - grow);
    const y0 = Math.max(0, Math.floor(top));
    const x1 = Math.min(width, Math.ceil(word.x + word.width) + grow);
    const y1 = Math.min(height, Math.ceil(bottom));
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const o = (y * width + x) * 2;
        ids[o] = id & 0xff;
        ids[o + 1] = id >> 8;
      }
    }
  });
  const masked = rg8Texture(gl, width, height, null, true);
  const maskedFramebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, maskedFramebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, masked, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const color = raster.color === undefined ? null : colorTexture(gl, width, height, raster.color);
  return { key, raster, base: rg8Texture(gl, width, height, base, true), ids: rg8Texture(gl, width, height, ids, false), masked, maskedFramebuffer, color };
}

/** Nearest: the masks shape the glyph, and blending these straight-alpha edges would bring in black. */
function colorTexture(gl: WebGL2RenderingContext, width: number, height: number, data: Uint8Array): WebGLTexture {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

export function releaseTextRaster(gl: WebGL2RenderingContext, uploaded: UploadedText): void {
  gl.deleteTexture(uploaded.base);
  gl.deleteTexture(uploaded.ids);
  gl.deleteTexture(uploaded.masked);
  gl.deleteFramebuffer(uploaded.maskedFramebuffer);
  gl.deleteTexture(uploaded.color);
}

export function bindTexture(gl: WebGL2RenderingContext, unit: number, tex: WebGLTexture, location: WebGLUniformLocation): void {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.uniform1i(location, unit);
}

export function unbindTextures(gl: WebGL2RenderingContext, units: number): void {
  for (let unit = units - 1; unit >= 0; unit -= 1) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
}

/** sRGB hex → linear RGB, with a fallback for a value that does not parse. */
export function linearHex(hex: string, fallback: string): [number, number, number] {
  const c = parseHexColor(hex) ?? parseHexColor(fallback) ?? { r: 1, g: 1, b: 1, a: 1 };
  return [srgbToLinear(c.r), srgbToLinear(c.g), srgbToLinear(c.b)];
}

export interface WordMaskPass {
  /**
   * Writes `uploaded.base × visibility` into `uploaded.masked` and rebuilds its mipmaps. Leaves the
   * framebuffer unbound: the caller must rebind its output target afterwards.
   */
  apply(uploaded: UploadedText, visibility: Float32Array): WebGLTexture;
  dispose(): void;
}

export function createWordMaskPass(gl: WebGL2RenderingContext, label: string): WordMaskPass {
  const program = createProgram(gl, `${label}.mask`, FULLSCREEN_VERT, MASK_FRAG);
  const u = {
    base: uniformLocation(gl, program, 'u_base'),
    ids: uniformLocation(gl, program, 'u_ids'),
    wordVis: uniformLocation(gl, program, 'u_wordVis'),
    wordCount: uniformLocation(gl, program, 'u_wordCount'),
  };
  const vao = gl.createVertexArray();
  const wordVis = gl.createTexture();
  let wordVisWidth = 0;

  const writeVisibility = (visibility: Float32Array, wordCount: number) => {
    const width = wordCount + 1;
    const data = new Uint8Array(width);
    data[0] = 255;
    for (let i = 0; i < wordCount; i += 1) data[i + 1] = Math.round(clamp01(visibility[i] ?? 1) * 255);
    gl.bindTexture(gl.TEXTURE_2D, wordVis);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (wordVisWidth !== width) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, 1, 0, gl.RED, gl.UNSIGNED_BYTE, data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      wordVisWidth = width;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, 1, gl.RED, gl.UNSIGNED_BYTE, data);
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.bindTexture(gl.TEXTURE_2D, null);
  };

  return {
    apply(uploaded, visibility) {
      const { raster } = uploaded;
      const wordCount = Math.min(MAX_WORDS, raster.words.length);
      writeVisibility(visibility, wordCount);
      gl.bindFramebuffer(gl.FRAMEBUFFER, uploaded.maskedFramebuffer);
      gl.viewport(0, 0, raster.width, raster.height);
      gl.disable(gl.BLEND);
      // A caller drawing several blocks scissors each one; a scissor left on from the previous
      // block would update only part of this mask, leaving an earlier frame's words in the rest —
      // found by the lyrics determinism test, where render order changed the pixels.
      gl.disable(gl.SCISSOR_TEST);
      gl.useProgram(program);
      bindTexture(gl, 0, uploaded.base, u.base);
      bindTexture(gl, 1, uploaded.ids, u.ids);
      bindTexture(gl, 2, wordVis, u.wordVis);
      gl.uniform1f(u.wordCount, wordCount);
      drawFullscreenTriangle(gl, vao);
      unbindTextures(gl, 3);
      gl.bindTexture(gl.TEXTURE_2D, uploaded.masked);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.bindTexture(gl.TEXTURE_2D, null);
      return uploaded.masked;
    },
    dispose() {
      gl.deleteTexture(wordVis);
      gl.deleteProgram(program);
      gl.deleteVertexArray(vao);
    },
  };
}
