// core.effect.grain — film grain.
//
// The odd one out in the catalogue, because its whole job is to be different on every frame —
// and it still has to be *deterministic*. The noise is a hash of the pixel coordinate and the
// **frame index**, so frame 300 has the grain frame 300 always had, whether you played to it or
// scrubbed to it (CLAUDE.md constraint 1). A `Math.random` grain would look identical and make
// every export a different file.
//
// Grain is applied in linear light, scaled by a luminance response: real film grains least in
// the highlights and most in the midtones, and grain of constant amplitude over a dark frame
// reads as digital noise instead.

import { EFFECT_GLSL, frameSeed, singlePassEffect } from './effect-base.ts';
import type { ModuleManifest } from '../core/module.ts';
import { num } from '../core/params.ts';

export const grainManifest: ModuleManifest = {
  id: 'core.effect.grain',
  version: '0.1.0',
  kind: 'effect',
  name: 'Film grain',
  description: 'Deterministic per-frame grain, weighted towards the midtones',
  category: 'texture',
  tags: ['grain', 'noise', 'film', 'analogue', 'texture'],
  capabilities: { needsAnalysis: false, needsInput: true, supportsAspect: true, stateful: false, gpuCost: 'low', expandsBounds: false },
  paramsSchemaVersion: 1,
  params: [
    { key: 'amount', label: 'Amount', group: 'Grain', type: 'float', default: 0.06, min: 0, max: 0.5, softMax: 0.15 },
    { key: 'size', label: 'Size', group: 'Grain', type: 'float', default: 1.5, min: 1, max: 16, unit: ' px', description: 'Grain cell size, in output pixels' },
    { key: 'response', label: 'Midtone bias', group: 'Grain', type: 'float', default: 0.8, min: 0, max: 1, description: 'Concentrate grain in the midtones rather than everywhere' },
    { key: 'colour', label: 'Colour grain', group: 'Grain', type: 'float', default: 0.2, min: 0, max: 1, description: 'Independent noise per channel, rather than one shared value' },
    { key: 'still', label: 'Still', group: 'Grain', type: 'bool', default: false, description: 'Freeze the pattern, so it does not shimmer between frames' },
  ],
};

const FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_input;
uniform float u_amount;
uniform float u_size;
uniform float u_response;
uniform float u_colour;
uniform uint u_seed;
out vec4 outColor;
${EFFECT_GLSL}

void main() {
  ivec2 pixel = ivec2(gl_FragCoord.xy);
  vec4 src = texelFetch(u_input, pixel, 0);
  vec3 c = pf_unpremultiply(src);

  // Quantising the coordinate is what gives grain a size; sampling per pixel gives the
  // finest possible noise, which video compression then eats alive.
  ivec2 cell = ivec2(floor(gl_FragCoord.xy / max(u_size, 1.0)));
  float shared_ = pf_noise(cell, u_seed) - 0.5;
  vec3 perChannel = vec3(
    pf_noise(cell, u_seed + 1u) - 0.5,
    pf_noise(cell, u_seed + 2u) - 0.5,
    pf_noise(cell, u_seed + 3u) - 0.5
  );
  vec3 noise = mix(vec3(shared_), perChannel, u_colour);

  // Midtone weighting: 4·L·(1−L) peaks at mid grey and falls to zero at black and white.
  float luma = clamp(pf_luma(c), 0.0, 1.0);
  float weight = mix(1.0, 4.0 * luma * (1.0 - luma), u_response);

  c += noise * u_amount * weight;
  outColor = pf_premultiply(max(c, 0.0), src.a);
}
`;

export const grainModule = singlePassEffect(grainManifest, FRAG, {
  uniforms: ['u_amount', 'u_size', 'u_response', 'u_colour', 'u_seed'],
  set(gl, u, ctx, params) {
    gl.uniform1f(u('u_amount'), num(params, 'amount'));
    gl.uniform1f(u('u_size'), num(params, 'size'));
    gl.uniform1f(u('u_response'), num(params, 'response'));
    gl.uniform1f(u('u_colour'), num(params, 'colour'));
    // "Still" is a fixed seed, not a skipped update: the pattern is the same every frame,
    // which is what a texture overlay wants and a grain does not.
    gl.uniform1ui(u('u_seed'), params['still'] === true ? 1 : frameSeed(ctx, 7));
  },
});
