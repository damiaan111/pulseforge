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
}

const LAYER_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_layer;
uniform float u_opacity;
uniform bool u_transformed;
uniform mat3 u_inverse;   // canvas pixels -> layer pixels
out vec4 outColor;
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
  // Premultiplied: opacity scales colour and alpha together.
  outColor = src * u_opacity;
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
  private readonly gl: WebGL2RenderingContext;
  private readonly pool: TargetPool;
  private readonly vao: WebGLVertexArrayObject;
  private readonly layerProgram: WebGLProgram;
  private readonly layerUniforms: {
    layer: WebGLUniformLocation;
    opacity: WebGLUniformLocation;
    transformed: WebGLUniformLocation;
    inverse: WebGLUniformLocation;
  };
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

  constructor(gl: WebGL2RenderingContext, pool: TargetPool) {
    this.gl = gl;
    this.pool = pool;
    this.vao = gl.createVertexArray();
    this.layerProgram = createProgram(gl, 'compositor.layer', FULLSCREEN_VERT, LAYER_FRAG);
    this.layerUniforms = {
      layer: uniformLocation(gl, this.layerProgram, 'u_layer'),
      opacity: uniformLocation(gl, this.layerProgram, 'u_opacity'),
      transformed: uniformLocation(gl, this.layerProgram, 'u_transformed'),
      inverse: uniformLocation(gl, this.layerProgram, 'u_inverse'),
    };
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
    const gl = this.gl;
    const { width, height } = output;
    resetState(gl, width, height);

    let composite = this.pool.acquire(width, height, 'rgba16f');
    gl.bindFramebuffer(gl.FRAMEBUFFER, composite.framebuffer);
    gl.clearColor(background.r, background.g, background.b, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    this.drawInto(composite, layers);

    if (globalEffects.length > 0) {
      composite = runEffectChain(gl, this.pool, composite, globalEffects);
    }

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
    this.pool.release(composite);
  }

  /**
   * Composites `layers` into `into`, which must already hold what they draw over (the background,
   * or nothing for a group). Used for the frame itself and, recursively, for each group.
   */
  drawInto(into: RenderTarget, layers: readonly CompositeLayer[]): void {
    const gl = this.gl;
    const { width, height } = into;

    for (const layer of layers) {
      if (!(layer.opacity > 0)) continue;
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

      gl.bindFramebuffer(gl.FRAMEBUFFER, into.framebuffer);
      resetState(gl, width, height);
      gl.enable(gl.BLEND);
      setBlend(gl, layer.blend);
      gl.useProgram(this.layerProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, target.texture);
      const transformed = layer.inverseTransform !== undefined;
      // Pooled targets default to NEAREST (targets.ts); a resampled layer needs bilinear,
      // and the filter is set every time because the pool hands the same texture around.
      const filter = transformed ? gl.LINEAR : gl.NEAREST;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.uniform1i(this.layerUniforms.layer, 0);
      gl.uniform1f(this.layerUniforms.opacity, Math.min(1, layer.opacity));
      gl.uniform1i(this.layerUniforms.transformed, transformed ? 1 : 0);
      gl.uniformMatrix3fv(this.layerUniforms.inverse, false, layer.inverseTransform ?? IDENTITY_MAT3);
      drawFullscreenTriangle(gl, this.vao);
      gl.bindTexture(gl.TEXTURE_2D, null);
      this.pool.release(target);
    }
  }

  dispose(): void {
    this.gl.deleteProgram(this.layerProgram);
    this.gl.deleteProgram(this.outputProgram);
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

/** Blend modes in premultiplied form (compositor-spec §3). P0 has the separable workhorses. */
function setBlend(gl: WebGL2RenderingContext, mode: BlendMode): void {
  gl.blendEquation(gl.FUNC_ADD);
  switch (mode) {
    case 'normal':
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      break;
    case 'add':
      gl.blendFunc(gl.ONE, gl.ONE);
      break;
    case 'screen':
      gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_COLOR, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      break;
  }
}
