// core.effect.blur — a separable Gaussian.
//
// Two passes, horizontal then vertical, which is what makes a wide blur affordable: an N×N
// kernel costs N² taps per pixel, the same blur as two 1-D passes costs 2N. The horizontal pass
// writes to a scratch target from the pool and the vertical pass reads it back into the target
// the chain already bound (module-spec §8).
//
// Like bloom, the radius is a fraction of `referenceScale` rather than a pixel count, so a
// project blurred to taste at 1080p is blurred the same amount at 4K (module-spec §6). The taps
// are placed *between* texels and read bilinearly, which buys two samples for the price of one.

import type { ModuleDefinition, ModuleInstance, ModuleManifest } from '../core/module.ts';
import { num } from '../core/params.ts';
import { FULLSCREEN_VERT, createProgram, drawFullscreenTriangle, uniformLocation } from '../render/gl.ts';
import type { RenderTarget } from '../render/targets.ts';

export const blurManifest: ModuleManifest = {
  id: 'core.effect.blur',
  version: '0.1.0',
  kind: 'effect',
  name: 'Blur',
  description: 'A separable Gaussian blur, optionally in one direction only',
  category: 'lens',
  tags: ['blur', 'gaussian', 'soft', 'defocus', 'motion'],
  capabilities: { needsAnalysis: false, needsInput: true, supportsAspect: true, stateful: false, gpuCost: 'medium', expandsBounds: true },
  paramsSchemaVersion: 1,
  params: [
    { key: 'radius', label: 'Radius', group: 'Blur', type: 'float', default: 0.01, min: 0, max: 0.2, softMax: 0.05, space: 'canvas', scale: 'log' },
    {
      key: 'axis', label: 'Direction', group: 'Blur', type: 'enum', default: 'both',
      options: [
        { value: 'both', label: 'Both' },
        { value: 'horizontal', label: 'Horizontal only' },
        { value: 'vertical', label: 'Vertical only' },
      ],
    },
    { key: 'angle', label: 'Angle', group: 'Blur', type: 'float', default: 0, min: -90, max: 90, unit: '°', description: 'Tilts a one-directional blur', visibleWhen: { param: 'axis', equals: 'horizontal' } },
    { key: 'mix', label: 'Mix', group: 'Blur', type: 'float', default: 1, min: 0, max: 1, description: 'Blend back towards the sharp image' },
  ],
};

/** Taps either side of centre. Nine samples covers a wide Gaussian without visible banding. */
const TAPS = 4;

const FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_input;
uniform vec2 u_step;          // one tap's offset, in uv
uniform float u_sigma;
out vec4 outColor;

void main() {
  // Gaussian weights computed in the shader rather than baked in, so the kernel narrows
  // smoothly as the radius comes down instead of snapping between fixed shapes.
  float total = 1.0;
  vec4 sum = texture(u_input, v_uv);
  for (int i = 1; i <= ${TAPS}; i++) {
    float offset = float(i);
    float weight = exp(-0.5 * (offset * offset) / max(u_sigma * u_sigma, 1e-6));
    sum += texture(u_input, v_uv + u_step * offset) * weight;
    sum += texture(u_input, v_uv - u_step * offset) * weight;
    total += weight * 2.0;
  }
  // Premultiplied throughout: a weighted sum of premultiplied samples is still premultiplied,
  // which is exactly why the compositor works in that space.
  outColor = sum / total;
}
`;

const PASSTHROUGH = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_input;
uniform sampler2D u_blurred;
uniform float u_mix;
out vec4 outColor;
void main() {
  ivec2 pixel = ivec2(gl_FragCoord.xy);
  outColor = mix(texelFetch(u_input, pixel, 0), texelFetch(u_blurred, pixel, 0), u_mix);
}
`;

function createBlur(gl: WebGL2RenderingContext): ModuleInstance {
  const blur = createProgram(gl, `${blurManifest.id}.blur`, FULLSCREEN_VERT, FRAG);
  const combine = createProgram(gl, `${blurManifest.id}.combine`, FULLSCREEN_VERT, PASSTHROUGH);
  const u = {
    blurInput: uniformLocation(gl, blur, 'u_input'),
    step: uniformLocation(gl, blur, 'u_step'),
    sigma: uniformLocation(gl, blur, 'u_sigma'),
    combineInput: uniformLocation(gl, combine, 'u_input'),
    combineBlurred: uniformLocation(gl, combine, 'u_blurred'),
    mix: uniformLocation(gl, combine, 'u_mix'),
  };
  const vao = gl.createVertexArray();

  function bind(unit: number, texture: WebGLTexture, filter: number): void {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  return {
    resize() {},
    render(ctx, params) {
      const input = ctx.input;
      if (input === null) {
        ctx.warn(`${blurManifest.id}: no input texture; the effect is skipped`);
        return;
      }
      const radius = num(params, 'radius') * ctx.canvas.referenceScale;
      const axis = String(params['axis']);
      const mix = num(params, 'mix');
      if (!(radius > 0.5) || !(mix > 0)) {
        // Below half a pixel the kernel collapses to the centre tap; drawing it anyway would
        // still cost two passes and a resample. Copy through instead.
        gl.disable(gl.BLEND);
        gl.useProgram(combine);
        bind(0, input.texture, gl.NEAREST);
        bind(1, input.texture, gl.NEAREST);
        gl.uniform1i(u.combineInput, 0);
        gl.uniform1i(u.combineBlurred, 1);
        gl.uniform1f(u.mix, 0);
        drawFullscreenTriangle(gl, vao);
        gl.useProgram(null);
        return;
      }

      // Sigma is a third of the radius, so the visible extent of the blur matches what the
      // parameter says; the tap spacing then covers it in TAPS steps.
      const sigma = TAPS / 3;
      const spacing = radius / TAPS;
      const radians = (num(params, 'angle') * Math.PI) / 180;

      const first = ctx.targets.acquire(input.width, input.height, input.format);
      const second = ctx.targets.acquire(input.width, input.height, input.format);
      gl.disable(gl.BLEND);
      gl.useProgram(blur);
      gl.uniform1i(u.blurInput, 0);
      gl.uniform1f(u.sigma, sigma);

      const drawInto = (target: RenderTarget): void => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
        gl.viewport(0, 0, target.width, target.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        drawFullscreenTriangle(gl, vao);
      };

      // Pass 1 — along the first axis, or along the tilted direction for a one-way blur.
      const horizontal = axis !== 'vertical';
      bind(0, input.texture, gl.LINEAR);
      if (axis === 'both') {
        gl.uniform2f(u.step, spacing / input.width, 0);
      } else if (horizontal) {
        gl.uniform2f(u.step, (spacing * Math.cos(radians)) / input.width, (spacing * Math.sin(radians)) / input.height);
      } else {
        gl.uniform2f(u.step, 0, spacing / input.height);
      }
      drawInto(first);

      // Pass 2 — the second axis, or a no-op second pass for a one-way blur. Running it
      // anyway would double the spread along the same axis, which is not what "horizontal
      // only" means.
      let result = first;
      if (axis === 'both') {
        bind(0, first.texture, gl.LINEAR);
        gl.uniform2f(u.step, 0, spacing / input.height);
        drawInto(second);
        result = second;
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, ctx.outputTarget.framebuffer);
      gl.viewport(0, 0, ctx.outputTarget.width, ctx.outputTarget.height);
      gl.useProgram(combine);
      bind(0, input.texture, gl.NEAREST);
      bind(1, result.texture, gl.NEAREST);
      gl.uniform1i(u.combineInput, 0);
      gl.uniform1i(u.combineBlurred, 1);
      gl.uniform1f(u.mix, mix);
      drawFullscreenTriangle(gl, vao);

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.useProgram(null);

      // Straight back to the pool: two full-resolution RGBA16F targets held across layers is
      // what makes a 4K render run out of memory.
      ctx.targets.release(first);
      ctx.targets.release(second);
    },
    dispose() {
      gl.deleteProgram(blur);
      gl.deleteProgram(combine);
      gl.deleteVertexArray(vao);
    },
  };
}

export const blurModule: ModuleDefinition = { manifest: blurManifest, create: createBlur };
