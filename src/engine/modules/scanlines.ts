// core.effect.scanlines — a CRT: scanlines, a phosphor mask, and a little bloom of the beam.
//
// The scanline count is fixed in *frame* terms, not pixels: a CRT had a number of lines, and it
// did not gain more of them because you exported at 4K. That is the whole reason this is
// parameterised as "lines" rather than "every other pixel" — the latter disappears entirely
// when the export resolution goes up.
//
// The phosphor mask is the triad of red, green and blue stripes an aperture-grille tube used.
// It is *not* scaled with resolution: it is a physical feature of the glass, so it stays a fixed
// number of output pixels wide and simply gets finer relative to the picture at 4K, which is
// exactly what looking at a real tube through a better camera does.

import { EFFECT_GLSL, singlePassEffect } from './effect-base.ts';
import type { ModuleManifest } from '../core/module.ts';
import { num } from '../core/params.ts';

export const scanlinesManifest: ModuleManifest = {
  id: 'core.effect.scanlines',
  version: '0.1.0',
  kind: 'effect',
  name: 'Scanlines',
  description: 'CRT scanlines with an optional phosphor mask',
  category: 'texture',
  tags: ['scanlines', 'crt', 'retro', 'vhs', 'phosphor'],
  capabilities: { needsAnalysis: false, needsInput: true, supportsAspect: true, stateful: false, gpuCost: 'low', expandsBounds: false },
  paramsSchemaVersion: 1,
  params: [
    { key: 'lines', label: 'Lines', group: 'Tube', type: 'int', default: 240, min: 20, max: 2000, description: 'Scanlines across the frame height, whatever the resolution' },
    { key: 'depth', label: 'Depth', group: 'Tube', type: 'float', default: 0.45, min: 0, max: 1, description: 'How dark the gaps between lines go' },
    { key: 'thickness', label: 'Beam width', group: 'Tube', type: 'float', default: 0.55, min: 0.05, max: 1, unit: '×', description: 'Fraction of each line the beam fills' },
    { key: 'mask', label: 'Phosphor mask', group: 'Tube', type: 'float', default: 0.25, min: 0, max: 1, description: 'Red/green/blue stripes, as on an aperture grille' },
    { key: 'maskPitch', label: 'Mask pitch', group: 'Tube', type: 'float', default: 3, min: 1, max: 24, unit: ' px', advanced: true },
    { key: 'bleed', label: 'Beam bleed', group: 'Tube', type: 'float', default: 0.35, min: 0, max: 1, description: 'Bright areas spill into the gaps, as a real beam does' },
  ],
};

const FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_input;
uniform float u_lines;
uniform float u_depth;
uniform float u_thickness;
uniform float u_mask;
uniform float u_maskPitch;
uniform float u_bleed;
out vec4 outColor;
${EFFECT_GLSL}

void main() {
  ivec2 pixel = ivec2(gl_FragCoord.xy);
  vec4 src = texelFetch(u_input, pixel, 0);
  vec3 c = pf_unpremultiply(src);

  // Position within the current scanline, 0..1.
  float within = fract(v_uv.y * u_lines);
  float edge = abs(within - 0.5) * 2.0;
  // Antialiased against the derivative, so at a resolution where lines are sub-pixel the
  // effect fades out rather than turning into a moire pattern.
  float aa = max(fwidth(within) * 2.0, 1e-4);
  float beam = 1.0 - smoothstep(u_thickness - aa, u_thickness + aa, edge);

  // A bright part of the picture spills across the gap; a dark one does not. This is what
  // stops the effect from reading as a flat stripe overlay.
  float spill = pf_luma(c) * u_bleed;
  float line = mix(1.0 - u_depth, 1.0, clamp(beam + spill, 0.0, 1.0));

  vec3 tint = vec3(1.0);
  if (u_mask > 0.0) {
    int stripe = int(mod(gl_FragCoord.x / max(u_maskPitch, 1.0), 3.0));
    vec3 phosphor = stripe == 0 ? vec3(1.0, 0.55, 0.55)
                  : stripe == 1 ? vec3(0.55, 1.0, 0.55)
                                : vec3(0.55, 0.55, 1.0);
    tint = mix(vec3(1.0), phosphor, u_mask);
  }

  outColor = pf_premultiply(c * line * tint, src.a);
}
`;

export const scanlinesModule = singlePassEffect(scanlinesManifest, FRAG, {
  uniforms: ['u_lines', 'u_depth', 'u_thickness', 'u_mask', 'u_maskPitch', 'u_bleed'],
  set(gl, u, _ctx, params) {
    gl.uniform1f(u('u_lines'), num(params, 'lines'));
    gl.uniform1f(u('u_depth'), num(params, 'depth'));
    gl.uniform1f(u('u_thickness'), num(params, 'thickness'));
    gl.uniform1f(u('u_mask'), num(params, 'mask'));
    gl.uniform1f(u('u_maskPitch'), num(params, 'maskPitch'));
    gl.uniform1f(u('u_bleed'), num(params, 'bleed'));
  },
});
