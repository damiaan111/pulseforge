// core.effect.kaleidoscope — mirror the frame into a rosette.
//
// A geometric effect rather than a colour one, and the cheapest way to make a plain visualiser
// layer look designed: take one wedge of the frame and reflect it around the centre. Because it
// only rearranges where a pixel is sampled from, it composes with everything after it.
//
// The mirroring happens in a *screen-circular* polar space, corrected for aspect, or the wedges
// come out as unequal slices in a 9:16 frame — the failure that makes a kaleidoscope look like
// a bug rather than a pattern.
//
// **Rotation chooses which wedge of the source is mirrored**, because it is applied after the
// fold. At 0 the wedge points right; a layer whose content all sits along the bottom of the
// frame needs roughly -90.

import { EFFECT_GLSL, singlePassEffect } from './effect-base.ts';
import type { ModuleManifest } from '../core/module.ts';
import { num } from '../core/params.ts';

export const kaleidoscopeManifest: ModuleManifest = {
  id: 'core.effect.kaleidoscope',
  version: '0.1.0',
  kind: 'effect',
  name: 'Kaleidoscope',
  description: 'Mirrors a wedge of the frame around the centre',
  category: 'geometry',
  tags: ['kaleidoscope', 'mirror', 'symmetry', 'pattern', 'geometry'],
  capabilities: { needsAnalysis: false, needsInput: true, supportsAspect: true, stateful: false, gpuCost: 'low', expandsBounds: false },
  paramsSchemaVersion: 1,
  params: [
    {
      key: 'mode', label: 'Mode', group: 'Symmetry', type: 'enum', default: 'radial',
      options: [
        { value: 'radial', label: 'Radial wedges' },
        { value: 'horizontal', label: 'Mirror left/right' },
        { value: 'vertical', label: 'Mirror top/bottom' },
        { value: 'quad', label: 'Mirror into quarters' },
      ],
    },
    { key: 'segments', label: 'Segments', group: 'Symmetry', type: 'int', default: 6, min: 2, max: 32, visibleWhen: { param: 'mode', equals: 'radial' } },
    { key: 'rotation', label: 'Rotation', group: 'Symmetry', type: 'float', default: 0, min: -180, max: 180, unit: '°', description: 'Which part of the frame the mirrored wedge is taken from' },
    { key: 'spin', label: 'Spin', group: 'Symmetry', type: 'float', default: 0, min: -180, max: 180, unit: '°/s', description: 'Rotation added per second of timeline' },
    { key: 'zoom', label: 'Zoom', group: 'Symmetry', type: 'float', default: 1, min: 0.2, max: 4, softMax: 2, unit: '×', scale: 'log' },
    { key: 'centreX', label: 'Centre X', group: 'Symmetry', type: 'float', default: 0.5, min: -0.5, max: 1.5, advanced: true },
    { key: 'centreY', label: 'Centre Y', group: 'Symmetry', type: 'float', default: 0.5, min: -0.5, max: 1.5, advanced: true },
    { key: 'mix', label: 'Mix', group: 'Symmetry', type: 'float', default: 1, min: 0, max: 1 },
  ],
};

const FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_input;
uniform int u_mode;           // 0 radial, 1 horizontal, 2 vertical, 3 quad
uniform float u_segments;
uniform float u_rotation;     // radians, rotation + spin x t
uniform float u_zoom;
uniform vec2 u_centre;
uniform float u_aspect;
uniform float u_mix;
out vec4 outColor;
${EFFECT_GLSL}

const float TAU = 6.283185307179586;

void main() {
  vec2 uv = v_uv;
  vec2 d = uv - u_centre;

  if (u_mode == 0) {
    // Screen-circular: stretch x by the aspect, fold, then stretch back.
    vec2 p = vec2(d.x * u_aspect, d.y) / u_zoom;
    float radius = length(p);
    float angle = atan(p.y, p.x);

    // Fold into one wedge: take the angle modulo the wedge, then mirror the second half of
    // it. That second reflection is what makes adjacent wedges meet seamlessly instead of
    // repeating with a visible seam.
    float wedge = TAU / u_segments;
    angle = mod(angle, wedge);
    angle = abs(angle - wedge * 0.5);

    // Rotation is applied *after* the fold, not before, and that is the whole difference
    // between a usable control and a decorative one. Folding first pins the sampled wedge to
    // the same slice of the source for ever — point it at a bars layer, whose content is all
    // along the bottom, and the result is a black frame. Rotating afterwards aims the wedge.
    angle += u_rotation;

    p = vec2(cos(angle), sin(angle)) * radius;
    uv = u_centre + vec2(p.x / u_aspect, p.y);
  } else {
    vec2 folded = d / u_zoom;
    if (u_mode == 1 || u_mode == 3) folded.x = abs(folded.x);
    if (u_mode == 2 || u_mode == 3) folded.y = abs(folded.y);
    uv = u_centre + folded;
  }

  // Reflecting at the boundary rather than clamping: a clamp smears the edge pixel into a
  // long streak, which is the usual giveaway of a cheap kaleidoscope.
  uv = abs(mod(uv, 2.0));
  uv = mix(uv, 2.0 - uv, step(1.0, uv));

  vec4 sampled = texture(u_input, uv);
  outColor = mix(texelFetch(u_input, ivec2(gl_FragCoord.xy), 0), sampled, u_mix);
}
`;

export const kaleidoscopeModule = singlePassEffect(kaleidoscopeManifest, FRAG, {
  filter: 'linear',
  uniforms: ['u_mode', 'u_segments', 'u_rotation', 'u_zoom', 'u_centre', 'u_aspect', 'u_mix'],
  set(gl, u, ctx, params) {
    const modes = ['radial', 'horizontal', 'vertical', 'quad'];
    gl.uniform1i(u('u_mode'), Math.max(0, modes.indexOf(String(params['mode']))));
    gl.uniform1f(u('u_segments'), Math.max(2, Math.round(num(params, 'segments'))));
    const degrees = num(params, 'rotation') + ctx.time.t * num(params, 'spin');
    gl.uniform1f(u('u_rotation'), (degrees * Math.PI) / 180);
    gl.uniform1f(u('u_zoom'), num(params, 'zoom'));
    gl.uniform2f(u('u_centre'), num(params, 'centreX'), num(params, 'centreY'));
    gl.uniform1f(u('u_aspect'), ctx.canvas.aspect);
    gl.uniform1f(u('u_mix'), num(params, 'mix'));
  },
});
