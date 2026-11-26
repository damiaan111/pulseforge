// The compositor (compositor-spec §1–3): a stack of layers with effects and groups; masks are
// still to come (S7).
//
//   per layer: acquire RGBA16F target → module draws (linear, premultiplied) → effect chain →
//              transform + opacity + blend into the composite target → release
//   → output pass: tone map → OETF → dither → quantise to RGBA8, flipped top-down
//
// A **group** (M38) is the same thing one level down: its children composite into its own target,
// and the group's transform, opacity, blend and effects then apply to that result exactly as they
// would to a module's. That is why `drawInto` exists as a public entry point — the engine hands a
// group a `draw` that calls back into the compositor with the group's children.
//
// The two decisions that change every project's appearance are fixed here: linear-light
// compositing and premultiplied alpha throughout.

import { COLOR_GLSL, type RGBA } from '../core/color.ts';
import { IDENTITY_MAT3, type Mat3 } from '../core/layout.ts';
import type { LayerDepth } from '../core/module.ts';
import type { BlendMode } from '../core/project.ts';
import { HASH_GLSL } from '../core/prng.ts';
import { runEffectChain, type EffectPass } from './effects.ts';
import { FULLSCREEN_VERT, createProgram, drawFullscreenTriangle, uniformLocation } from './gl.ts';
import type { GpuProfiler } from './gpu-profiler.ts';
import type { RenderTarget, TargetPool } from './targets.ts';

export type OutputTransfer = 'srgb' | 'bt709';

export interface OutputOptions {
  /** sRGB for preview and export (D49); BT.709 kept for comparison measurements. */
  readonly transfer: OutputTransfer;
  readonly dither: boolean;
  /** 8 → RGBA8 output; 10 → RGB10_A2 for the 10-bit HEVC master (export-spec §4.3). */
  readonly bitDepth: 8 | 10;
  /** Write rows top-down, as video expects (export-spec §4.3). */
  readonly flipY: boolean;
}

export interface CompositeLayer {
  /** What the performance HUD calls this layer's GPU time (S12): its id. Top-level layers only are timed. */
  readonly profileKey?: string;
  readonly opacity: number;
  readonly blend: BlendMode;
  /**
   * Draws into `target`, which is bound, cleared and transparent RGBA16F. A 3D scene layer
   * returns its depth, which its effect chain then reads (compositor-spec §7.3).
   */
  readonly draw: (target: RenderTarget) => LayerDepth | null | void;
  /** This layer's effect chain, bottom of the list first (module-spec §8). */
  readonly effects?: readonly EffectPass[];
  /**
   * Canvas pixels → layer pixels (`layerMatrix().inverse`). Omit for an untransformed layer,
   * which takes the exact 1:1 path. A degenerate transform is skipped by the caller, never
   * passed here as null.
   */
  readonly inverseTransform?: Mat3;
  /**
   * Masking (S7, compositor-spec §5): `layer` is drawn into a frame-sized target (its own module,
   * effects, transform and opacity) and multiplies this layer where it is composited. A null
   * layer is an empty mask — the source is not on screen at this moment.
   */
  readonly mask?: {
    readonly layer: CompositeLayer | null;
    readonly channel: 'alpha' | 'luma';
    readonly invert: boolean;
    /** Blur radius as a fraction of the frame's short side. */
    readonly feather: number;
  };
}

const LAYER_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_layer;
uniform float u_opacity;
uniform bool u_transformed;
uniform mat3 u_inverse;   // canvas pixels -> layer pixels
out vec4 outColor;
uniform bool u_masked;
uniform sampler2D u_mask;
uniform int u_maskChannel;   // 0 alpha, 1 luma
uniform bool u_maskInvert;
// Canvas-space mask (compositor-spec §5): the source layer as drawn into the frame, so a shape
// masks what is under it on screen, after both layers' transforms. Luma reads the premultiplied
// colour, which is already weighted by the source's alpha.
float maskValue() {
  if (!u_masked) return 1.0;
  vec4 m = texelFetch(u_mask, ivec2(gl_FragCoord.xy), 0);
  float v = u_maskChannel == 1 ? clamp(dot(m.rgb, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0) : clamp(m.a, 0.0, 1.0);
  return u_maskInvert ? 1.0 - v : v;
}
void main() {
  vec4 src;
  if (u_transformed) {
    vec2 size = vec2(textureSize(u_layer, 0));
    vec2 p = (u_inverse * vec3(gl_FragCoord.xy, 1.0)).xy;
    // Outside the layer's own bounds there is nothing to draw. CLAMP_TO_EDGE would smear the
    // border texels across the rest of the canvas, which is the classic "streaky background"
    // artefact when a layer is scaled down.
    src = any(lessThan(p, vec2(0.0))) || any(greaterThan(p, size))
      ? vec4(0.0)
      : texture(u_layer, p / size);
  } else {
    src = texelFetch(u_layer, ivec2(gl_FragCoord.xy), 0);
  }
  // Premultiplied: opacity and the mask scale colour and alpha together.
  outColor = src * (u_opacity * maskValue());
}
`;

/**
 * The separable blend modes (compositor-spec §3), which need the backdrop and so cannot be GL blend
 * state. The W3C compositing formula in premultiplied form, with cs/cb the un-premultiplied
 * colours:
 *
 *   result.rgb = (1 − αb)·Cs + (1 − αs)·Cb + αs·αb·B(cs, cb)
 *   result.a   = αs + αb − αs·αb
 *
 * so where the layer is transparent the backdrop comes through untouched, and on a transparent
 * backdrop (inside a group) the layer draws as itself. The composite is linear light and can exceed
 * 1; the modes defined on 0..1 (overlay, the lights, dodge, burn) see their inputs clamped to it,
 * while multiply, darken, lighten, difference and exclusion take them as they are.
 */
const BLEND_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_layer;
uniform sampler2D u_backdrop;
uniform float u_opacity;
uniform bool u_transformed;
uniform mat3 u_inverse;
uniform int u_mode;
out vec4 outColor;
uniform bool u_masked;
uniform sampler2D u_mask;
uniform int u_maskChannel;   // 0 alpha, 1 luma
uniform bool u_maskInvert;
// Canvas-space mask (compositor-spec §5): the source layer as drawn into the frame, so a shape
// masks what is under it on screen, after both layers' transforms. Luma reads the premultiplied
// colour, which is already weighted by the source's alpha.
float maskValue() {
  if (!u_masked) return 1.0;
  vec4 m = texelFetch(u_mask, ivec2(gl_FragCoord.xy), 0);
  float v = u_maskChannel == 1 ? clamp(dot(m.rgb, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0) : clamp(m.a, 0.0, 1.0);
  return u_maskInvert ? 1.0 - v : v;
}

vec3 softLight(vec3 s, vec3 b) {
  vec3 d = mix(sqrt(b), ((16.0 * b - 12.0) * b + 4.0) * b, step(b, vec3(0.25)));
  return mix(b + (2.0 * s - 1.0) * (d - b), b - (1.0 - 2.0 * s) * b * (1.0 - b), step(s, vec3(0.5)));
}
vec3 hardLight(vec3 s, vec3 b) {
  return mix(1.0 - (1.0 - b) * (1.0 - (2.0 * s - 1.0)), b * 2.0 * s, step(s, vec3(0.5)));
}
vec3 dodge(vec3 s, vec3 b) {
  vec3 r = min(vec3(1.0), b / max(vec3(1e-6), 1.0 - s));
  return mix(r, vec3(0.0), step(b, vec3(0.0)));
}
vec3 burn(vec3 s, vec3 b) {
  vec3 r = 1.0 - min(vec3(1.0), (1.0 - b) / max(vec3(1e-6), s));
  return mix(r, vec3(1.0), step(vec3(1.0), b));
}

vec3 blendMode(vec3 s, vec3 b) {
  vec3 s1 = clamp(s, 0.0, 1.0);
  vec3 b1 = clamp(b, 0.0, 1.0);
  if (u_mode == 0) return s * b;                  // multiply
  if (u_mode == 1) return hardLight(b1, s1);      // overlay: hard light with the roles swapped
  if (u_mode == 2) return softLight(s1, b1);      // soft-light
  if (u_mode == 3) return hardLight(s1, b1);      // hard-light
  if (u_mode == 4) return min(s, b);              // darken
  if (u_mode == 5) return max(s, b);              // lighten
  if (u_mode == 6) return abs(s - b);             // difference
  if (u_mode == 7) return s + b - 2.0 * s * b;    // exclusion
  if (u_mode == 8) return dodge(s1, b1);          // color-dodge
  return burn(s1, b1);                            // color-burn
}

void main() {
  vec4 src;
  if (u_transformed) {
    vec2 size = vec2(textureSize(u_layer, 0));
    vec2 p = (u_inverse * vec3(gl_FragCoord.xy, 1.0)).xy;
    src = any(lessThan(p, vec2(0.0))) || any(greaterThan(p, size)) ? vec4(0.0) : texture(u_layer, p / size);
  } else {
    src = texelFetch(u_layer, ivec2(gl_FragCoord.xy), 0);
  }
  src *= u_opacity * maskValue();
  vec4 dst = texelFetch(u_backdrop, ivec2(gl_FragCoord.xy), 0);
  vec3 cs = src.a > 0.0 ? src.rgb / src.a : vec3(0.0);
  vec3 cb = dst.a > 0.0 ? dst.rgb / dst.a : vec3(0.0);
  vec3 rgb = (1.0 - dst.a) * src.rgb + (1.0 - src.a) * dst.rgb + src.a * dst.a * blendMode(cs, cb);
  outColor = vec4(rgb, src.a + dst.a - src.a * dst.a);
}
`;

/**
 * The mask's feather (compositor-spec §5): a separable Gaussian, 17 taps per pass, the step scaled
 * to the radius. Fixed taps, so it costs the same at every radius and is deterministic.
 */
const FEATHER_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform vec2 u_step;   // pixels between taps, along one axis
out vec4 outColor;
void main() {
  vec2 size = vec2(textureSize(u_src, 0));
  vec2 uv = gl_FragCoord.xy / size;
  vec4 acc = vec4(0.0);
  float total = 0.0;
  for (int i = -8; i <= 8; i++) {
    float w = exp(-float(i * i) / 32.0);
    acc += texture(u_src, uv + u_step * float(i) / size) * w;
    total += w;
  }
  outColor = acc / total;
}
`;

/**
 * One step of the motion-blur sum (export-spec §9): the running total plus this subframe times its
 * weight. Ping-ponged between two RGBA32F targets rather than blended, because float32 blending is
 * an extension and a half-float running sum rounds on every step.
 */
const ACCUMULATE_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_sum;
uniform sampler2D u_src;
uniform float u_weight;
out vec4 outColor;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  outColor = texelFetch(u_sum, px, 0) + texelFetch(u_src, px, 0) * u_weight;
}
`;

/** One subframe of a motion-blurred frame: built only when its turn comes, so its layers are current. */
export interface Subframe {
  readonly weight: number;
  readonly build: () => { readonly layers: readonly CompositeLayer[]; readonly globalEffects: readonly EffectPass[] };
}

/** The shader-blended modes, in the order `BLEND_FRAG` numbers them in `u_mode`. */
const SHADER_BLENDS: readonly BlendMode[] = [
  'multiply', 'overlay', 'soft-light', 'hard-light', 'darken', 'lighten',
  'difference', 'exclusion', 'color-dodge', 'color-burn',
];

/** Every 2×2 block of a frame rendered at twice the size, by texel (export-spec §9). */
const DOWNSAMPLE_FRAG = `#version 300 es
precision highp float;
uniform highp sampler2D u_src;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) * 2;
  outColor = 0.25 * (texelFetch(u_src, p, 0) + texelFetch(u_src, p + ivec2(1, 0), 0)
    + texelFetch(u_src, p + ivec2(0, 1), 0) + texelFetch(u_src, p + ivec2(1, 1), 0));
}
`;

const OUTPUT_FRAG = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_composite;
uniform int u_transfer;
uniform bool u_dither;
uniform bool u_flipY;
uniform uint u_noiseSeed;
uniform uint u_frame;
uniform float u_levels; // 255 for 8-bit output, 1023 for 10-bit
out vec4 outColor;
${HASH_GLSL}
${COLOR_GLSL}
void main() {
  ivec2 size = textureSize(u_composite, 0);
  ivec2 px = ivec2(gl_FragCoord.xy);
  ivec2 src = ivec2(px.x, u_flipY ? size.y - 1 - px.y : px.y);
  // The composite sits over an opaque background, so its colour is already final.
  vec3 rgb = pf_tonemap(texelFetch(u_composite, src, 0).rgb);
  rgb = u_transfer == 1 ? pf_linear_to_bt709(rgb) : pf_linear_to_srgb(rgb);
  if (u_dither) {
    // Triangular-PDF dither keyed on (seed, frame, pixel): deterministic, and it
    // decorrelates between frames so it reads as grain rather than a fixed pattern.
    uint h = pf_combine32(pf_combine32(pf_combine32(u_noiseSeed, u_frame), uint(src.x)), uint(src.y));
    float n1 = float(h >> 8u) / 16777216.0;
    float n2 = float(pf_mix32(h ^ 0x68e31da4u) >> 8u) / 16777216.0;
    rgb += (n1 + n2 - 1.0) / u_levels;
  }
  outColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}
`;

export class Compositor {
  /** Set while profiling (S12): each top-level layer, the global chain and the output pass are timed. */
  profiler: GpuProfiler | null = null;
  private readonly gl: WebGL2RenderingContext;
  private readonly pool: TargetPool;
  private readonly vao: WebGLVertexArrayObject;
  private readonly layerProgram: WebGLProgram;
  private readonly layerUniforms: {
    layer: WebGLUniformLocation;
    opacity: WebGLUniformLocation;
    transformed: WebGLUniformLocation;
    inverse: WebGLUniformLocation;
    masked: WebGLUniformLocation;
    mask: WebGLUniformLocation;
    maskChannel: WebGLUniformLocation;
    maskInvert: WebGLUniformLocation;
  };
  private readonly blendProgram: WebGLProgram;
  private readonly blendUniforms: {
    layer: WebGLUniformLocation;
    backdrop: WebGLUniformLocation;
    opacity: WebGLUniformLocation;
    transformed: WebGLUniformLocation;
    inverse: WebGLUniformLocation;
    mode: WebGLUniformLocation;
    masked: WebGLUniformLocation;
    mask: WebGLUniformLocation;
    maskChannel: WebGLUniformLocation;
    maskInvert: WebGLUniformLocation;
  };
  private readonly featherProgram: WebGLProgram;
  private readonly featherUniforms: { src: WebGLUniformLocation; step: WebGLUniformLocation };
  private readonly accumulateProgram: WebGLProgram;
  private readonly accumulateUniforms: { sum: WebGLUniformLocation; src: WebGLUniformLocation; weight: WebGLUniformLocation };
  private readonly downsampleProgram: WebGLProgram;
  private readonly outputProgram: WebGLProgram;
  private readonly outputUniforms: {
    composite: WebGLUniformLocation;
    transfer: WebGLUniformLocation;
    dither: WebGLUniformLocation;
    flipY: WebGLUniformLocation;
    noiseSeed: WebGLUniformLocation;
    frame: WebGLUniformLocation;
    levels: WebGLUniformLocation;
  };

  /** Spatial supersampling (export-spec §9): the frame is composited this many times larger per side. */
  private readonly scale: number;

  constructor(gl: WebGL2RenderingContext, pool: TargetPool, supersample = 1) {
    this.gl = gl;
    this.pool = pool;
    this.scale = supersample;
    this.vao = gl.createVertexArray();
    this.layerProgram = createProgram(gl, 'compositor.layer', FULLSCREEN_VERT, LAYER_FRAG);
    this.layerUniforms = {
      layer: uniformLocation(gl, this.layerProgram, 'u_layer'),
      opacity: uniformLocation(gl, this.layerProgram, 'u_opacity'),
      transformed: uniformLocation(gl, this.layerProgram, 'u_transformed'),
      inverse: uniformLocation(gl, this.layerProgram, 'u_inverse'),
      masked: uniformLocation(gl, this.layerProgram, 'u_masked'),
      mask: uniformLocation(gl, this.layerProgram, 'u_mask'),
      maskChannel: uniformLocation(gl, this.layerProgram, 'u_maskChannel'),
      maskInvert: uniformLocation(gl, this.layerProgram, 'u_maskInvert'),
    };
    this.blendProgram = createProgram(gl, 'compositor.blend', FULLSCREEN_VERT, BLEND_FRAG);
    this.blendUniforms = {
      layer: uniformLocation(gl, this.blendProgram, 'u_layer'),
      backdrop: uniformLocation(gl, this.blendProgram, 'u_backdrop'),
      opacity: uniformLocation(gl, this.blendProgram, 'u_opacity'),
      transformed: uniformLocation(gl, this.blendProgram, 'u_transformed'),
      inverse: uniformLocation(gl, this.blendProgram, 'u_inverse'),
      mode: uniformLocation(gl, this.blendProgram, 'u_mode'),
      masked: uniformLocation(gl, this.blendProgram, 'u_masked'),
      mask: uniformLocation(gl, this.blendProgram, 'u_mask'),
      maskChannel: uniformLocation(gl, this.blendProgram, 'u_maskChannel'),
      maskInvert: uniformLocation(gl, this.blendProgram, 'u_maskInvert'),
    };
    this.featherProgram = createProgram(gl, 'compositor.feather', FULLSCREEN_VERT, FEATHER_FRAG);
    this.featherUniforms = {
      src: uniformLocation(gl, this.featherProgram, 'u_src'),
      step: uniformLocation(gl, this.featherProgram, 'u_step'),
    };
    this.accumulateProgram = createProgram(gl, 'compositor.accumulate', FULLSCREEN_VERT, ACCUMULATE_FRAG);
    this.accumulateUniforms = {
      sum: uniformLocation(gl, this.accumulateProgram, 'u_sum'),
      src: uniformLocation(gl, this.accumulateProgram, 'u_src'),
      weight: uniformLocation(gl, this.accumulateProgram, 'u_weight'),
    };
    this.downsampleProgram = createProgram(gl, 'compositor.downsample', FULLSCREEN_VERT, DOWNSAMPLE_FRAG);
    this.outputProgram = createProgram(gl, 'compositor.output', FULLSCREEN_VERT, OUTPUT_FRAG);
    this.outputUniforms = {
      composite: uniformLocation(gl, this.outputProgram, 'u_composite'),
      transfer: uniformLocation(gl, this.outputProgram, 'u_transfer'),
      dither: uniformLocation(gl, this.outputProgram, 'u_dither'),
      flipY: uniformLocation(gl, this.outputProgram, 'u_flipY'),
      noiseSeed: uniformLocation(gl, this.outputProgram, 'u_noiseSeed'),
      frame: uniformLocation(gl, this.outputProgram, 'u_frame'),
      levels: uniformLocation(gl, this.outputProgram, 'u_levels'),
    };
  }

  /**
   * Builds one frame into `output` (RGBA8 or RGB10_A2, canvas-sized).
   * `background` is linear premultiplied and opaque.
   */
  composite(
    output: RenderTarget,
    background: RGBA,
    layers: readonly CompositeLayer[],
    options: OutputOptions,
    frame: { readonly frameIndex: number; readonly noiseSeed: number },
    globalEffects: readonly EffectPass[] = [],
  ): void {
    const composite = this.downsampled(this.linear(output.width * this.scale, output.height * this.scale, background, layers, globalEffects), 'rgba16f');
    this.writeOutput(composite, output, options, frame);
    this.pool.release(composite);
  }

  /**
   * The average of every 2×2 block, in linear light: before the tone curve, so a thin bright line
   * softens as light does. By texel, not filtering, because the motion-blur sum is RGBA32F, which
   * WebGL2 cannot filter. Releases what it is given. At 1× it is the identity, and costs nothing.
   */
  private downsampled(source: RenderTarget, format: 'rgba16f' | 'rgba32f'): RenderTarget {
    if (this.scale === 1) return source;
    const gl = this.gl;
    const width = source.width / this.scale;
    const height = source.height / this.scale;
    const target = this.pool.acquire(width, height, format);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    resetState(gl, width, height);
    gl.useProgram(this.downsampleProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, source.texture);
    drawFullscreenTriangle(gl, this.vao);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.useProgram(null);
    this.pool.release(source);
    return target;
  }

  /**
   * Motion blur (S10, export-spec §9): each subframe is composited in linear light exactly as a
   * frame is, the weighted sum is kept in RGBA32F, and the sum goes through the one output pass —
   * so tone mapping, the transfer curve and dither apply once, to the blurred picture.
   */
  compositeAccumulated(
    output: RenderTarget,
    background: RGBA,
    subframes: readonly Subframe[],
    options: OutputOptions,
    frame: { readonly frameIndex: number; readonly noiseSeed: number },
  ): void {
    const gl = this.gl;
    const width = output.width * this.scale;
    const height = output.height * this.scale;
    let sum = this.pool.acquire(width, height, 'rgba32f');
    let next = this.pool.acquire(width, height, 'rgba32f');
    gl.bindFramebuffer(gl.FRAMEBUFFER, sum.framebuffer);
    resetState(gl, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    for (const subframe of subframes) {
      const { layers, globalEffects } = subframe.build();
      const composite = this.linear(width, height, background, layers, globalEffects);
      gl.bindFramebuffer(gl.FRAMEBUFFER, next.framebuffer);
      resetState(gl, width, height);
      gl.useProgram(this.accumulateProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, sum.texture);
      gl.uniform1i(this.accumulateUniforms.sum, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, composite.texture);
      gl.uniform1i(this.accumulateUniforms.src, 1);
      gl.uniform1f(this.accumulateUniforms.weight, subframe.weight);
      drawFullscreenTriangle(gl, this.vao);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.useProgram(null);
      this.pool.release(composite);
      [sum, next] = [next, sum];
    }
    const finished = this.downsampled(sum, 'rgba32f');
    this.writeOutput(finished, output, options, frame);
    this.pool.release(finished);
    this.pool.release(next);
  }

  /** The frame in linear premultiplied light, over its opaque background: RGBA16F, canvas-sized. */
  private linear(
    width: number,
    height: number,
    background: RGBA,
    layers: readonly CompositeLayer[],
    globalEffects: readonly EffectPass[],
  ): RenderTarget {
    const gl = this.gl;
    resetState(gl, width, height);
    let composite = this.pool.acquire(width, height, 'rgba16f');
    gl.bindFramebuffer(gl.FRAMEBUFFER, composite.framebuffer);
    gl.clearColor(background.r, background.g, background.b, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    this.drawInto(composite, layers, true);

    if (globalEffects.length > 0) {
      this.profiler?.begin('global');
      composite = runEffectChain(gl, this.pool, composite, globalEffects);
      this.profiler?.end();
    }
    return composite;
  }

  /** Tone map, transfer curve, dither and row order: linear light → the output target's bytes. */
  private writeOutput(
    composite: RenderTarget,
    output: RenderTarget,
    options: OutputOptions,
    frame: { readonly frameIndex: number; readonly noiseSeed: number },
  ): void {
    const gl = this.gl;
    const { width, height } = output;
    this.profiler?.begin('output');
    gl.bindFramebuffer(gl.FRAMEBUFFER, output.framebuffer);
    resetState(gl, width, height);
    gl.useProgram(this.outputProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, composite.texture);
    gl.uniform1i(this.outputUniforms.composite, 0);
    gl.uniform1i(this.outputUniforms.transfer, options.transfer === 'bt709' ? 1 : 0);
    gl.uniform1i(this.outputUniforms.dither, options.dither ? 1 : 0);
    gl.uniform1i(this.outputUniforms.flipY, options.flipY ? 1 : 0);
    gl.uniform1ui(this.outputUniforms.noiseSeed, frame.noiseSeed >>> 0);
    gl.uniform1ui(this.outputUniforms.frame, frame.frameIndex >>> 0);
    gl.uniform1f(this.outputUniforms.levels, options.bitDepth === 10 ? 1023 : 255);
    drawFullscreenTriangle(gl, this.vao);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.useProgram(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.profiler?.end();
  }

  /**
   * Composites `layers` into `into`, which must already hold what they draw over (the background,
   * or nothing for a group). Used for the frame itself and, recursively, for each group.
   */
  drawInto(into: RenderTarget, layers: readonly CompositeLayer[], timed = false): void {
    const gl = this.gl;
    const { width, height } = into;

    for (const layer of layers) {
      if (!(layer.opacity > 0)) continue;
      // Only the frame's own layers are timed: queries cannot nest, and a group's time is its children's.
      const span = timed && this.profiler !== null && layer.profileKey !== undefined;
      if (span) this.profiler?.begin(layer.profileKey as string);
      let target = this.pool.acquire(width, height, 'rgba16f');
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      resetState(gl, width, height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      // Modules draw premultiplied "over" by default; they may change blend state themselves.
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      const depth = layer.draw(target) ?? null;

      // Effects run on the layer alone, before its transform and blend (compositor-spec §1).
      // runEffectChain consumes `target` and hands back one to release.
      if (layer.effects !== undefined && layer.effects.length > 0) {
        target = runEffectChain(gl, this.pool, target, layer.effects, depth);
      }

      // The mask: its source drawn into a frame-sized target, feathered, bound on unit 2.
      const maskTarget = layer.mask === undefined ? null : this.renderMask(layer.mask, width, height);

      const transformed = layer.inverseTransform !== undefined;
      const shaderMode = SHADER_BLENDS.indexOf(layer.blend);
      // A shader-blended mode reads the backdrop, and a pass may not read the target it writes
      // (compositor-spec §3: ping-pong). So the backdrop is copied first and read from the copy.
      const backdrop = shaderMode < 0 ? null : this.pool.acquire(width, height, into.format);
      if (backdrop !== null) {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, into.framebuffer);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, backdrop.framebuffer);
        gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, into.framebuffer);
      resetState(gl, width, height);
      if (backdrop === null) {
        gl.enable(gl.BLEND);
        setBlend(gl, layer.blend);
      }
      const u = backdrop === null ? this.layerUniforms : this.blendUniforms;
      gl.useProgram(backdrop === null ? this.layerProgram : this.blendProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, target.texture);
      // Pooled targets default to NEAREST (targets.ts); a resampled layer needs bilinear,
      // and the filter is set every time because the pool hands the same texture around.
      const filter = transformed ? gl.LINEAR : gl.NEAREST;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.uniform1i(u.layer, 0);
      gl.uniform1f(u.opacity, Math.min(1, layer.opacity));
      gl.uniform1i(u.transformed, transformed ? 1 : 0);
      gl.uniformMatrix3fv(u.inverse, false, layer.inverseTransform ?? IDENTITY_MAT3);
      if (backdrop !== null) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, backdrop.texture);
        gl.uniform1i(this.blendUniforms.backdrop, 1);
        gl.uniform1i(this.blendUniforms.mode, shaderMode);
      }
      gl.uniform1i(u.masked, maskTarget === null ? 0 : 1);
      if (maskTarget !== null && layer.mask !== undefined) {
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, maskTarget.texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.uniform1i(u.mask, 2);
        gl.uniform1i(u.maskChannel, layer.mask.channel === 'luma' ? 1 : 0);
        gl.uniform1i(u.maskInvert, layer.mask.invert ? 1 : 0);
        gl.activeTexture(gl.TEXTURE0);
      } else {
        // Sampled only when masked, but a sampler must still name a unit that has no conflict.
        gl.uniform1i(u.mask, 2);
      }
      drawFullscreenTriangle(gl, this.vao);
      if (maskTarget !== null) {
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.activeTexture(gl.TEXTURE0);
        this.pool.release(maskTarget);
      }
      if (backdrop !== null) {
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.activeTexture(gl.TEXTURE0);
        this.pool.release(backdrop);
      }
      gl.bindTexture(gl.TEXTURE_2D, null);
      this.pool.release(target);
      if (span) this.profiler?.end();
    }
  }

  /** Draws a mask's source into a transparent frame-sized target and feathers it. */
  private renderMask(mask: NonNullable<CompositeLayer['mask']>, width: number, height: number): RenderTarget {
    const gl = this.gl;
    let target = this.pool.acquire(width, height, 'rgba16f');
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    resetState(gl, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (mask.layer !== null) this.drawInto(target, [mask.layer]);
    const radius = Math.max(0, mask.feather) * Math.min(width, height);
    if (radius >= 0.5) {
      // Sigma is 4 taps; taps are radius/8 apart, so the blur reaches about the radius.
      for (const [dx, dy] of [[radius / 8, 0], [0, radius / 8]] as const) {
        const next = this.pool.acquire(width, height, 'rgba16f');
        gl.bindFramebuffer(gl.FRAMEBUFFER, next.framebuffer);
        resetState(gl, width, height);
        gl.useProgram(this.featherProgram);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, target.texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.uniform1i(this.featherUniforms.src, 0);
        gl.uniform2f(this.featherUniforms.step, dx, dy);
        drawFullscreenTriangle(gl, this.vao);
        gl.bindTexture(gl.TEXTURE_2D, null);
        this.pool.release(target);
        target = next;
      }
    }
    return target;
  }

  dispose(): void {
    this.gl.deleteProgram(this.featherProgram);
    this.gl.deleteProgram(this.layerProgram);
    this.gl.deleteProgram(this.blendProgram);
    this.gl.deleteProgram(this.accumulateProgram);
    this.gl.deleteProgram(this.outputProgram);
    this.gl.deleteProgram(this.downsampleProgram);
    this.gl.deleteVertexArray(this.vao);
  }
}

/** Known GL state before every pass, so no module or earlier layer leaks state into the next. */
function resetState(gl: WebGL2RenderingContext, width: number, height: number): void {
  gl.viewport(0, 0, width, height);
  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.STENCIL_TEST);
  gl.disable(gl.SCISSOR_TEST);
  gl.disable(gl.CULL_FACE);
  gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
  gl.colorMask(true, true, true, true);
  gl.depthMask(true);
  gl.bindVertexArray(null);
}

/**
 * The fixed-function modes in premultiplied form (compositor-spec §3). Every other mode is a shader
 * pass (`BLEND_FRAG`) and never reaches here; `normal` is the safe answer if one ever does.
 */
function setBlend(gl: WebGL2RenderingContext, mode: BlendMode): void {
  gl.blendEquation(gl.FUNC_ADD);
  switch (mode) {
    case 'add':
      gl.blendFunc(gl.ONE, gl.ONE);
      break;
    case 'screen':
      gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_COLOR, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      break;
    default:
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      break;
  }
}
