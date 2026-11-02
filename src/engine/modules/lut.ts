// core.effect.lut — a colour look-up table from a .cube file (S11), on a layer or the whole frame.
//
// LUTs are made for *display* values: a "Kodak 2383" or a teal-and-orange pack expects the
// sRGB/Rec.709-encoded picture a monitor shows, not scene-linear light. The compositor works in
// linear, so by default the effect encodes (sRGB OETF, the output's own curve — D49), looks the
// colour up, and decodes back. "Linear" skips both for LUTs built for linear input. Values above 1
// cannot go through a 0..1 table: they are clamped at the table's domain, as in any grading tool.
//
// Alpha is untouched: un-premultiply, look up, premultiply — the grade does the same.
// A LUT asset that is missing is reported every frame it is asked for, and the layer passes through
// unchanged: a missing grade must look like "no grade", with a note saying why, never like black.

import { EFFECT_GLSL, singlePassEffect } from './effect-base.ts';
import type { ModuleManifest } from '../core/module.ts';
import { num, str } from '../core/params.ts';

export const lutManifest: ModuleManifest = {
  id: 'core.effect.lut',
  version: '0.1.0',
  kind: 'effect',
  name: 'LUT',
  description: 'A colour look-up table from a .cube file — a film emulation, a show look, a camera conversion',
  category: 'grade',
  tags: ['grade', 'colour', 'lut', 'cube', 'film', 'cinematic'],
  capabilities: { needsAnalysis: false, needsInput: true, supportsAspect: true, stateful: false, gpuCost: 'low', expandsBounds: false },
  paramsSchemaVersion: 1,
  params: [
    { key: 'lut', label: 'LUT', group: 'LUT', type: 'asset', accept: 'lut', default: '', description: 'A .cube file (3D or 1D)' },
    { key: 'amount', label: 'Amount', group: 'LUT', type: 'float', default: 1, min: 0, max: 1, description: 'Blend between the original and the LUT' },
    {
      key: 'space', label: 'Made for', group: 'LUT', type: 'enum', default: 'display',
      options: [{ value: 'display', label: 'Display (sRGB / Rec.709) — most LUTs' }, { value: 'linear', label: 'Linear light' }],
      description: 'What the LUT expects as input; almost every LUT is made for display values',
    },
  ],
};

const FRAG = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 v_uv;
uniform sampler2D u_input;
uniform sampler3D u_lut;
uniform float u_size;
uniform vec3 u_domainMin;
uniform vec3 u_domainMax;
uniform float u_amount;
uniform bool u_display;
uniform bool u_active;
out vec4 outColor;
${EFFECT_GLSL}

vec3 st_encode(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(hi, lo, vec3(lessThanEqual(c, vec3(0.0031308))));
}
vec3 st_decode(vec3 c) {
  vec3 lo = c / 12.92;
  vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
  return mix(hi, lo, vec3(lessThanEqual(c, vec3(0.04045))));
}

void main() {
  vec4 src = texelFetch(u_input, ivec2(gl_FragCoord.xy), 0);
  if (!u_active || src.a <= 0.0) {
    outColor = src;
    return;
  }
  vec3 c = max(pf_unpremultiply(src), 0.0);
  vec3 v = u_display ? st_encode(min(c, 1.0)) : c;
  // Into the table's domain, then onto texel centres: point 0 at 0.5/N, point N-1 at 1-0.5/N.
  vec3 t = clamp((v - u_domainMin) / (u_domainMax - u_domainMin), 0.0, 1.0);
  vec3 graded = texture(u_lut, t * ((u_size - 1.0) / u_size) + 0.5 / u_size).rgb;
  vec3 back = u_display ? st_decode(clamp(graded, 0.0, 1.0)) : max(graded, 0.0);
  outColor = pf_premultiply(mix(c, back, u_amount), src.a);
}
`;

export const lutModule = singlePassEffect(lutManifest, FRAG, {
  uniforms: ['u_lut', 'u_size', 'u_domainMin', 'u_domainMax', 'u_amount', 'u_display', 'u_active'],
  set(gl, u, ctx, params) {
    const assetId = str(params, 'lut');
    const found = ctx.lut(assetId);
    const active = 'texture' in found;
    if (!active) ctx.warn(`LUT: ${found.missing}; the layer passes through ungraded`);
    gl.uniform1i(u('u_active'), active ? 1 : 0);
    gl.uniform1f(u('u_amount'), num(params, 'amount'));
    gl.uniform1i(u('u_display'), str(params, 'space') === 'linear' ? 0 : 1);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, active ? found.texture : null);
    gl.uniform1i(u('u_lut'), 1);
    gl.activeTexture(gl.TEXTURE0);
    if (active) {
      gl.uniform1f(u('u_size'), found.size);
      gl.uniform3f(u('u_domainMin'), ...found.domainMin);
      gl.uniform3f(u('u_domainMax'), ...found.domainMax);
    } else {
      gl.uniform1f(u('u_size'), 2);
      gl.uniform3f(u('u_domainMin'), 0, 0, 0);
      gl.uniform3f(u('u_domainMax'), 1, 1, 1);
    }
  },
});
