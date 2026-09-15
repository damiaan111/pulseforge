// Shared plumbing for single-pass effects (module-spec §8).
//
// Every effect in the catalogue does the same four things: refuse politely when there is no
// input, bind that input to unit 0, set its own uniforms, and draw one triangle. Written out
// per module that is forty lines of identical code and one chance per module to get the
// premultiplied-alpha or the blend state subtly wrong. So it lives here, and an effect becomes
// a fragment shader plus a schema.
//
// What an effect shader is handed, and owes back:
//  - `u_input` is **linear light, premultiplied alpha**, RGBA16F (compositor-spec §2). Any
//    operation that is not a plain multiply — contrast, saturation, a curve — has to
//    un-premultiply first or it darkens the edges of everything, so `pf_unpremultiply` and
//    `pf_premultiply` are provided rather than left as an exercise.
//  - The output must be premultiplied too, and must not write to the input texture.
//  - Blending is off: an effect composites its own result (render/effects.ts).

import type { ModuleDefinition, ModuleInstance, ModuleManifest, RenderContext } from '../core/module.ts';
import type { ParamValues } from '../core/params.ts';
import { FULLSCREEN_VERT, RenderSetupError, createProgram, drawFullscreenTriangle, uniformLocation } from '../render/gl.ts';

/** Helpers every effect shader may use. Prefixed `pf_` so they cannot collide with a built-in. */
export const EFFECT_GLSL = /* glsl */ `
vec3 pf_unpremultiply(vec4 c) {
  return c.a > 0.0 ? c.rgb / c.a : c.rgb;
}

vec4 pf_premultiply(vec3 rgb, float a) {
  return vec4(rgb * a, a);
}

float pf_luma(vec3 linearRgb) {
  // Rec. 709, in linear light — the space the compositor works in.
  return dot(linearRgb, vec3(0.2126, 0.7152, 0.0722));
}

uint pf_hash(uint x) {
  // Wang's 32-bit integer hash. Exactly specified in GLSL ES 3.00, unlike fract(sin(..))
  // noise, which differs between drivers and would break "same pixels everywhere".
  x = (x ^ 61u) ^ (x >> 16u);
  x *= 9u;
  x = x ^ (x >> 4u);
  x *= 0x27d4eb2du;
  x = x ^ (x >> 15u);
  return x;
}

/** Deterministic 0..1 noise from an integer pixel coordinate and a seed. */
float pf_noise(ivec2 pixel, uint seed) {
  uint h = pf_hash(uint(pixel.x) * 73856093u ^ uint(pixel.y) * 19349663u ^ seed * 83492791u);
  return float(pf_hash(h)) / 4294967296.0;
}
`;

export interface SinglePassOptions {
  /** Uniform names beyond `u_input`, looked up once and handed to `set` through `u`. */
  readonly uniforms: readonly string[];
  /**
   * Sets this effect's uniforms for the frame. The input is already bound to unit 0. `u` looks
   * a name up and throws if it was not declared, so a typo fails at the first frame rather
   * than silently writing to location null.
   */
  readonly set: (
    gl: WebGL2RenderingContext,
    u: (name: string) => WebGLUniformLocation,
    ctx: RenderContext,
    params: ParamValues,
  ) => void;
  /**
   * Bilinear filtering on the input. Off by default: pooled targets are handed around and an
   * effect that samples off-grid must ask for it explicitly (targets.ts leaves them NEAREST).
   */
  readonly filter?: 'nearest' | 'linear';
}

export function singlePassEffect(
  manifest: ModuleManifest,
  frag: string,
  options: SinglePassOptions,
): ModuleDefinition {
  return {
    manifest,
    create(gl: WebGL2RenderingContext): ModuleInstance {
      const program = createProgram(gl, manifest.id, FULLSCREEN_VERT, frag);
      const inputUniform = uniformLocation(gl, program, 'u_input');
      const locations = new Map<string, WebGLUniformLocation>();
      for (const name of options.uniforms) locations.set(name, uniformLocation(gl, program, name));
      const u = (name: string): WebGLUniformLocation => {
        const found = locations.get(name);
        if (found === undefined) throw new RenderSetupError(`${manifest.id}: uniform "${name}" was not declared by the module`);
        return found;
      };
      const vao = gl.createVertexArray();
      const filter = options.filter === 'linear' ? gl.LINEAR : gl.NEAREST;

      return {
        resize() {},
        render(ctx, params) {
          const input = ctx.input;
          if (input === null) {
            ctx.warn(`${manifest.id}: no input texture; the effect is skipped`);
            return;
          }
          gl.disable(gl.BLEND);
          gl.useProgram(program);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, input.texture);
          // Set every time: the pool hands the same texture to modules with different needs.
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          gl.uniform1i(inputUniform, 0);
          options.set(gl, u, ctx, params);
          drawFullscreenTriangle(gl, vao);
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.useProgram(null);
        },
        dispose() {
          gl.deleteProgram(program);
          gl.deleteVertexArray(vao);
        },
      };
    },
  };
}

/**
 * A per-frame seed for effects with a noise component. Derived from the frame index alone,
 * never from a clock or a counter: frame 300 looks the same however you arrived at it
 * (CLAUDE.md constraint 1). `salt` separates effects that would otherwise share a grain
 * pattern. `>>> 0` keeps it in the unsigned range `gl.uniform1ui` wants.
 */
export function frameSeed(ctx: RenderContext, salt: number): number {
  return (Math.imul(ctx.time.frameIndex + 1, 2654435761) ^ Math.imul(salt + 1, 40503)) >>> 0;
}
