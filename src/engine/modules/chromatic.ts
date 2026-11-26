// core.effect.chromatic — red and blue pulled apart, more so towards the edges.
//
// A lens defect turned into a look. The separation grows with distance from the centre because
// that is what a real lens does, and a uniform shift instead reads as a printing error rather
// than as glass.
//
// Sampling is bilinear and the offset is a fraction of `referenceScale`, so the same project
// looks the same at 1080p and 4K (module-spec §6). Each channel is fetched separately, which is
// three taps — the reason this is its own effect and not a switch inside the blur.

import { EFFECT_GLSL, singlePassEffect } from './effect-base.ts';
import type { ModuleManifest } from '../core/module.ts';
import { num } from '../core/params.ts';

export const chromaticManifest: ModuleManifest = {
  id: 'core.effect.chromatic',
  version: '0.1.0',
  kind: 'effect',
  name: 'Chromatic aberration',
  description: 'Separates the colour channels towards the edges of the frame',
  category: 'lens',
  tags: ['chromatic', 'aberration', 'lens', 'glitch', 'rgb'],
  capabilities: { needsAnalysis: false, needsInput: true, supportsAspect: true, stateful: false, gpuCost: 'low', expandsBounds: false },
  paramsSchemaVersion: 1,
  params: [
    { key: 'amount', label: 'Amount', group: 'Lens', type: 'float', default: 0.004, min: 0, max: 0.05, softMax: 0.015, space: 'canvas', scale: 'log' },
    { key: 'falloff', label: 'Falloff', group: 'Lens', type: 'float', default: 2, min: 0, max: 4, description: '0 shifts the whole frame evenly; higher keeps the centre clean' },
    {
      key: 'axis', label: 'Direction', group: 'Lens', type: 'enum', default: 'radial',
      options: [
        { value: 'radial', label: 'Radial (lens)' },
        { value: 'horizontal', label: 'Horizontal' },
        { value: 'vertical', label: 'Vertical' },
      ],
    },
    { key: 'mix', label: 'Mix', group: 'Lens', type: 'float', default: 1, min: 0, max: 1, description: 'Blend back towards the original' },
  ],
};

const FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_input;
uniform vec2 u_texel;         // 1 / size, so an offset in pixels becomes uv
uniform float u_amount;       // pixels
uniform float u_falloff;
uniform int u_axis;           // 0 radial, 1 horizontal, 2 vertical
uniform float u_mix;
uniform float u_aspect;
out vec4 outColor;
${EFFECT_GLSL}

void main() {
  vec2 d = v_uv - 0.5;
  vec2 direction;
  if (u_axis == 1) direction = vec2(1.0, 0.0);
  else if (u_axis == 2) direction = vec2(0.0, 1.0);
  else {
    // Corrected for aspect so the separation is radial on screen, not in uv space.
    vec2 scaled = vec2(d.x * u_aspect, d.y);
    float len = length(scaled);
    direction = len > 1e-5 ? scaled / len : vec2(0.0);
  }

  // Strength grows towards the edges, measured on the circle rather than in uv.
  float radius = length(vec2(d.x * u_aspect, d.y)) * 2.0;
  float strength = u_amount * pow(clamp(radius, 0.0, 1.5), u_falloff);
  vec2 shift = direction * strength * u_texel;

  vec4 src = texture(u_input, v_uv);
  vec4 r = texture(u_input, v_uv + shift);
  vec4 b = texture(u_input, v_uv - shift);
  // Alpha comes from the unshifted tap: taking it from a shifted one makes the layer's edge
  // creep outwards every time the effect is applied.
  vec4 split = vec4(r.r, src.g, b.b, src.a);

  outColor = mix(src, split, u_mix);
}
`;

export const chromaticModule = singlePassEffect(chromaticManifest, FRAG, {
  filter: 'linear',
  uniforms: ['u_texel', 'u_amount', 'u_falloff', 'u_axis', 'u_mix', 'u_aspect'],
  set(gl, u, ctx, params) {
    const axes = ['radial', 'horizontal', 'vertical'];
    gl.uniform2f(u('u_texel'), 1 / ctx.canvas.width, 1 / ctx.canvas.height);
    gl.uniform1f(u('u_amount'), num(params, 'amount') * ctx.canvas.referenceScale);
    gl.uniform1f(u('u_falloff'), num(params, 'falloff'));
    gl.uniform1i(u('u_axis'), Math.max(0, axes.indexOf(String(params['axis']))));
    gl.uniform1f(u('u_mix'), num(params, 'mix'));
    gl.uniform1f(u('u_aspect'), ctx.canvas.aspect);
  },
});
