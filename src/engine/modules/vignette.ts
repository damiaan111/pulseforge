// core.effect.vignette — darkens toward the edges of the frame.
//
// The shape is measured in canvas-relative units, not pixels, so it is identical at 1080p and
// 4K, and it is computed on the *shorter* axis scaled by aspect so the falloff stays circular
// rather than stretching into an ellipse in vertical (module-spec §6).

import type { ModuleDefinition, ModuleInstance, ModuleManifest } from '../core/module.ts';
import { num } from '../core/params.ts';
import { FULLSCREEN_VERT, createProgram, drawFullscreenTriangle, uniformLocation } from '../render/gl.ts';

export const vignetteManifest: ModuleManifest = {
  id: 'core.effect.vignette',
  version: '0.1.0',
  kind: 'effect',
  name: 'Vignette',
  description: 'Darkens the edges of the frame',
  category: 'grade',
  tags: ['vignette', 'grade', 'cinematic'],
  capabilities: {
    needsAnalysis: false,
    needsInput: true,
    supportsAspect: true,
    stateful: false,
    gpuCost: 'low',
    expandsBounds: false,
  },
  paramsSchemaVersion: 1,
  params: [
    { key: 'amount', label: 'Amount', group: 'Shape', type: 'float', default: 0.5, min: 0, max: 1, unit: '×', description: 'How dark the corners go' },
    { key: 'radius', label: 'Radius', group: 'Shape', type: 'float', default: 0.75, min: 0, max: 1.5, space: 'canvas', description: 'Where the darkening starts, from the centre' },
    { key: 'softness', label: 'Softness', group: 'Shape', type: 'float', default: 0.45, min: 0.01, max: 1, description: 'Width of the falloff' },
    { key: 'roundness', label: 'Roundness', group: 'Shape', type: 'float', default: 1, min: 0, max: 1, description: '1 is a circle; 0 follows the frame’s own shape' },
  ],
};

const FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_input;
uniform float u_amount;
uniform float u_radius;
uniform float u_softness;
uniform float u_aspect;     // width / height
uniform float u_roundness;
out vec4 outColor;
void main() {
  vec4 src = texelFetch(u_input, ivec2(gl_FragCoord.xy), 0);
  vec2 d = v_uv - 0.5;
  // roundness 1: correct for aspect so the falloff is a circle.
  // roundness 0: leave it in frame space, so it follows the frame's own proportions.
  d.x *= mix(1.0, u_aspect, u_roundness);
  float dist = length(d) * 2.0;
  float shade = 1.0 - u_amount * smoothstep(u_radius, u_radius + u_softness, dist);
  // Darkening, not fading: colour scales and alpha stays. (Premultiplied data stays valid: rgb only
  // shrinks.) Scaling alpha too made the edges partly transparent — invisible at the end of the
  // frame's chain, where the output ignores alpha, but an effect after it (a LUT, S11) then graded
  // a see-through corner, and on a layer the edges showed what was beneath instead of going dark.
  outColor = vec4(src.rgb * shade, src.a);
}
`;

function createVignette(gl: WebGL2RenderingContext): ModuleInstance {
  const program = createProgram(gl, vignetteManifest.id, FULLSCREEN_VERT, FRAG);
  const uniforms = {
    input: uniformLocation(gl, program, 'u_input'),
    amount: uniformLocation(gl, program, 'u_amount'),
    radius: uniformLocation(gl, program, 'u_radius'),
    softness: uniformLocation(gl, program, 'u_softness'),
    aspect: uniformLocation(gl, program, 'u_aspect'),
    roundness: uniformLocation(gl, program, 'u_roundness'),
  };
  const vao = gl.createVertexArray();
  return {
    resize() {},
    render(ctx, params) {
      const input = ctx.input;
      if (input === null) {
        ctx.warn(`${vignetteManifest.id}: no input texture; the effect is skipped`);
        return;
      }
      gl.disable(gl.BLEND);
      gl.useProgram(program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, input.texture);
      gl.uniform1i(uniforms.input, 0);
      gl.uniform1f(uniforms.amount, num(params, 'amount'));
      gl.uniform1f(uniforms.radius, num(params, 'radius'));
      gl.uniform1f(uniforms.softness, num(params, 'softness'));
      gl.uniform1f(uniforms.aspect, ctx.canvas.aspect);
      gl.uniform1f(uniforms.roundness, num(params, 'roundness'));
      drawFullscreenTriangle(gl, vao);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.useProgram(null);
    },
    dispose() {
      gl.deleteProgram(program);
      gl.deleteVertexArray(vao);
    },
  };
}

export const vignetteModule: ModuleDefinition = { manifest: vignetteManifest, create: createVignette };
