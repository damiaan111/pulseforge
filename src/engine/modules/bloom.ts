// core.effect.bloom — the glow the neon look is built on (PROJECT.md §1 "visual direction").
//
// Four passes: bright-pass at half resolution, then separable Gaussian blurs ping-ponged at
// widening steps, then an additive composite over the original.
//
// Two things here are not incidental:
//
//  - **It works in linear light on RGBA16F.** Bloom done in sRGB is the classic reason glows
//    look grey and muddy (compositor-spec §2), and 8-bit intermediates clip exactly the
//    overdriven highlights this effect exists to spread.
//  - **The blur step is a fraction of `referenceScale`, never a pixel count.** A pixel-constant
//    radius makes 4K exports look thin and weak next to the 1080p preview, which module-spec §6
//    calls out as the single most common way resolution independence goes wrong.

import type { ModuleDefinition, ModuleInstance, ModuleManifest, RenderContext } from '../core/module.ts';
import { num } from '../core/params.ts';
import { FULLSCREEN_VERT, createProgram, drawFullscreenTriangle, uniformLocation } from '../render/gl.ts';
import type { RenderTarget } from '../render/targets.ts';

export const bloomManifest: ModuleManifest = {
  id: 'core.effect.bloom',
  version: '0.1.0',
  kind: 'effect',
  name: 'Bloom',
  description: 'Spreads a soft glow out of the brightest parts of the image',
  category: 'glow',
  tags: ['bloom', 'glow', 'neon', 'light'],
  capabilities: {
    needsAnalysis: false,
    needsInput: true,
    supportsAspect: true,
    stateful: false,
    gpuCost: 'medium',
    expandsBounds: true,
  },
  paramsSchemaVersion: 1,
  params: [
    // Above 1.0 only genuinely overdriven pixels glow, which is usually what looks right;
    // the range goes past that so a whole layer can be made to bloom deliberately.
    { key: 'threshold', label: 'Threshold', group: 'Bloom', type: 'float', default: 0.8, min: 0, max: 4, softMax: 1.5, description: 'Brightness above which a pixel glows' },
    { key: 'knee', label: 'Knee', group: 'Bloom', type: 'float', default: 0.5, min: 0, max: 1, description: 'Softness of the threshold, so the glow fades in rather than switching on' },
    // Hard max well above softMax leaves headroom for a modulation to push it on a drop
    // without making the everyday range a sliver of the slider (module-spec §3.3).
    { key: 'intensity', label: 'Intensity', group: 'Bloom', type: 'float', default: 0.7, min: 0, max: 4, softMax: 1.5, scale: 'log', description: 'How much glow is added back' },
    { key: 'radius', label: 'Radius', group: 'Bloom', type: 'float', default: 0.02, min: 0.001, max: 0.15, softMax: 0.06, scale: 'log', space: 'canvas', description: 'Spread, as a fraction of the canvas reference size' },
    { key: 'passes', label: 'Passes', group: 'Bloom', type: 'int', default: 3, min: 1, max: 5, advanced: true, description: 'Blur iterations; more is wider and softer, and costs more' },
  ],
};

const BRIGHT_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_input;
uniform float u_threshold;
uniform float u_knee;
out vec4 outColor;
void main() {
  vec4 src = texture(u_input, v_uv);
  // Rec. 709 luma, in linear light.
  float luma = dot(src.rgb, vec3(0.2126, 0.7152, 0.0722));
  // Soft knee: a hard step makes the glow pop on and off as a value crosses the threshold,
  // which reads as flicker on anything that is modulated.
  float knee = max(u_knee, 1e-4);
  float weight = smoothstep(u_threshold - knee, u_threshold + knee, luma);
  outColor = vec4(src.rgb * weight, src.a * weight);
}
`;

const BLUR_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_input;
uniform vec2 u_step;    // one tap, in uv
out vec4 outColor;
void main() {
  // Nine-tap Gaussian (sigma ≈ 2), separable: run once horizontally, once vertically.
  const float w0 = 0.2270270270;
  const float w1 = 0.1945945946;
  const float w2 = 0.1216216216;
  const float w3 = 0.0540540541;
  const float w4 = 0.0162162162;
  vec4 sum = texture(u_input, v_uv) * w0;
  sum += (texture(u_input, v_uv + u_step) + texture(u_input, v_uv - u_step)) * w1;
  sum += (texture(u_input, v_uv + u_step * 2.0) + texture(u_input, v_uv - u_step * 2.0)) * w2;
  sum += (texture(u_input, v_uv + u_step * 3.0) + texture(u_input, v_uv - u_step * 3.0)) * w3;
  sum += (texture(u_input, v_uv + u_step * 4.0) + texture(u_input, v_uv - u_step * 4.0)) * w4;
  outColor = sum;
}
`;

const COMPOSITE_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_input;
uniform sampler2D u_bloom;
uniform float u_intensity;
out vec4 outColor;
void main() {
  vec4 src = texelFetch(u_input, ivec2(gl_FragCoord.xy), 0);
  vec4 glow = texture(u_bloom, v_uv) * u_intensity;
  // Additive, premultiplied: glow brightens what is there and extends the layer's coverage
  // past its own edges, which is what makes a halo read as light rather than as a sticker.
  outColor = src + glow;
}
`;

/** Half resolution for the blur chain: four times fewer pixels, and the blur hides it. */
const DOWNSCALE = 2;

function createBloom(gl: WebGL2RenderingContext): ModuleInstance {
  const bright = createProgram(gl, `${bloomManifest.id}.bright`, FULLSCREEN_VERT, BRIGHT_FRAG);
  const blur = createProgram(gl, `${bloomManifest.id}.blur`, FULLSCREEN_VERT, BLUR_FRAG);
  const composite = createProgram(gl, `${bloomManifest.id}.composite`, FULLSCREEN_VERT, COMPOSITE_FRAG);
  const u = {
    brightInput: uniformLocation(gl, bright, 'u_input'),
    threshold: uniformLocation(gl, bright, 'u_threshold'),
    knee: uniformLocation(gl, bright, 'u_knee'),
    blurInput: uniformLocation(gl, blur, 'u_input'),
    blurStep: uniformLocation(gl, blur, 'u_step'),
    compositeInput: uniformLocation(gl, composite, 'u_input'),
    compositeBloom: uniformLocation(gl, composite, 'u_bloom'),
    intensity: uniformLocation(gl, composite, 'u_intensity'),
  };
  const vao = gl.createVertexArray();

  /** Binds `texture` to unit 0 with bilinear filtering — the blur taps between texels. */
  function bindLinear(texture: WebGLTexture): void {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }

  function drawInto(target: RenderTarget): void {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    drawFullscreenTriangle(gl, vao);
  }

  return {
    resize() {},

    render(ctx: RenderContext, params) {
      const input = ctx.input;
      if (input === null) {
        ctx.warn(`${bloomManifest.id}: no input texture; the effect is skipped`);
        return;
      }
      // Never below 2×2: a 1-pixel target makes every blur tap read the same texel, and on
      // 4:2:0 output FFmpeg rejects the frame anyway.
      const smallWidth = Math.max(2, Math.floor(input.width / DOWNSCALE));
      const smallHeight = Math.max(2, Math.floor(input.height / DOWNSCALE));

      let a = ctx.targets.acquire(smallWidth, smallHeight, 'rgba16f');
      let b = ctx.targets.acquire(smallWidth, smallHeight, 'rgba16f');
      gl.disable(gl.BLEND);

      // 1. Bright pass, downsampled.
      gl.useProgram(bright);
      bindLinear(input.texture);
      gl.uniform1i(u.brightInput, 0);
      gl.uniform1f(u.threshold, num(params, 'threshold'));
      gl.uniform1f(u.knee, num(params, 'knee'));
      drawInto(a);

      // 2. Separable blur, ping-ponged. The step widens each iteration, so `passes` buys
      //    spread cheaply instead of needing a kernel with more taps.
      const radiusPixels = num(params, 'radius') * ctx.canvas.referenceScale / DOWNSCALE;
      const passes = Math.round(num(params, 'passes'));
      gl.useProgram(blur);
      gl.uniform1i(u.blurInput, 0);
      for (let pass = 0; pass < passes; pass += 1) {
        const spread = (radiusPixels * Math.pow(2, pass)) / (1 << Math.max(0, passes - 1));
        for (const axis of [0, 1]) {
          const stepX = axis === 0 ? spread / smallWidth : 0;
          const stepY = axis === 0 ? 0 : spread / smallHeight;
          gl.uniform2f(u.blurStep, stepX, stepY);
          bindLinear(a.texture);
          drawInto(b);
          const swap = a;
          a = b;
          b = swap;
        }
      }

      // 3. Add the glow back over the original, at full resolution.
      gl.useProgram(composite);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, input.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.uniform1i(u.compositeInput, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, a.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.uniform1i(u.compositeBloom, 1);
      gl.uniform1f(u.intensity, num(params, 'intensity'));

      // Back to the target the chain bound and cleared before calling us.
      gl.bindFramebuffer(gl.FRAMEBUFFER, ctx.outputTarget.framebuffer);
      gl.viewport(0, 0, ctx.outputTarget.width, ctx.outputTarget.height);
      drawFullscreenTriangle(gl, vao);

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.useProgram(null);

      // Scratch goes straight back: holding a 4K RGBA16F pair starves the next layer.
      ctx.targets.release(a);
      ctx.targets.release(b);
    },

    dispose() {
      gl.deleteProgram(bright);
      gl.deleteProgram(blur);
      gl.deleteProgram(composite);
      gl.deleteVertexArray(vao);
    },
  };
}

export const bloomModule: ModuleDefinition = { manifest: bloomManifest, create: createBloom };
