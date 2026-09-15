// core.visualizer.radial — frequency bars around a circle (module-spec §14, PROJECT.md §8.3).
//
// The shape people picture when they think "music visualiser", and the centre of the neon
// target look. Drawn analytically in polar coordinates rather than as geometry: the edges stay
// clean at any resolution, and bar count becomes a uniform instead of a buffer upload.

import { AnalysisTexture, SPECTRUM_GLSL, fillColour } from './analysis-texture.ts';
import { referenceLength } from '../core/layout.ts';
import type { ModuleDefinition, ModuleInstance, ModuleManifest } from '../core/module.ts';
import { num, str, type Stem } from '../core/params.ts';
import { FULLSCREEN_VERT, createProgram, drawFullscreenTriangle, uniformLocation } from '../render/gl.ts';

export const radialManifest: ModuleManifest = {
  id: 'core.visualizer.radial',
  version: '0.1.0',
  kind: 'visualizer',
  name: 'Radial bars',
  description: 'Frequency bars arranged around a circle',
  category: 'spectrum',
  tags: ['radial', 'circular', 'spectrum', 'neon'],
  capabilities: { needsAnalysis: true, needsInput: false, supportsAspect: true, stateful: false, gpuCost: 'low' },
  paramsSchemaVersion: 1,
  params: [
    { key: 'source', label: 'Source', group: 'Source', type: 'select:stem', default: 'mix' },
    { key: 'barCount', label: 'Bars', group: 'Shape', type: 'int', default: 96, min: 8, max: 512, aspectOverridable: true },
    { key: 'radius', label: 'Radius', group: 'Shape', type: 'float', default: 0.22, min: 0.02, max: 0.5, space: 'canvas' },
    { key: 'length', label: 'Length', group: 'Shape', type: 'float', default: 0.16, min: 0.01, max: 0.5, space: 'canvas', aspectOverridable: true },
    { key: 'thickness', label: 'Thickness', group: 'Shape', type: 'float', default: 0.6, min: 0.05, max: 1, unit: '×', description: 'Fraction of each bar’s slot' },
    { key: 'rotation', label: 'Rotation', group: 'Shape', type: 'float', default: 0, min: -180, max: 180, unit: '°' },
    // Mirroring is what makes a radial visualiser read as symmetrical rather than as a spiral.
    { key: 'mirror', label: 'Mirror', group: 'Shape', type: 'bool', default: true, description: 'Reflect the spectrum across the vertical axis' },
    { key: 'fill', label: 'Fill', group: 'Appearance', type: 'color', default: '#ff2d95', paletteRole: 'primary' },
    { key: 'innerGlow', label: 'Inner glow', group: 'Appearance', type: 'float', default: 0.25, min: 0, max: 1, description: 'Soft disc inside the ring' },
  ],
};

const FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
uniform vec2 u_canvas;
uniform float u_reference;   // pixels per canvas-space unit
uniform int u_barCount;
uniform float u_radius;
uniform float u_length;
uniform float u_thickness;
uniform float u_rotation;    // radians
uniform bool u_mirror;
uniform vec4 u_fill;         // linear, premultiplied
uniform float u_innerGlow;
out vec4 outColor;
${SPECTRUM_GLSL}

const float TAU = 6.283185307179586;

void main() {
  // Work in pixels about the centre so the ring stays circular whatever the canvas shape.
  vec2 px = (v_uv * u_canvas) - u_canvas * 0.5;
  float dist = length(px);

  float radius = u_radius * u_reference;
  float maxLength = u_length * u_reference;

  float angle = atan(px.y, px.x) + u_rotation;
  float turn = fract(angle / TAU + 1.0);            // 0..1 around the circle
  // Mirrored: the first half of the spectrum sweeps out and back, so the two sides match.
  float position = u_mirror ? abs(turn * 2.0 - 1.0) : turn;

  float slot = 1.0 / float(u_barCount);
  float index = floor(turn / slot);
  float centreTurn = (index + 0.5) * slot;
  float barPosition = u_mirror ? abs(centreTurn * 2.0 - 1.0) : centreTurn;
  float amplitude = pf_spectrum(barPosition);

  // Angular coverage of this bar, in pixels at this radius — so the gap between bars stays
  // visually constant instead of fanning out.
  float halfWidthTurns = slot * 0.5 * u_thickness;
  float deltaTurn = abs(fract(turn - centreTurn + 0.5) - 0.5);
  float acrossPx = (deltaTurn - halfWidthTurns) * TAU * max(dist, 1.0);
  float across = 1.0 - smoothstep(-0.5, 0.5, acrossPx);

  float outer = radius + amplitude * maxLength;
  float along = smoothstep(radius - 0.75, radius + 0.75, dist) * (1.0 - smoothstep(outer - 0.75, outer + 0.75, dist));

  vec4 colour = u_fill * (across * along);

  if (u_innerGlow > 0.0) {
    float glow = 1.0 - smoothstep(0.0, radius, dist);
    colour += u_fill * (glow * glow * u_innerGlow * 0.6);
  }
  outColor = colour;
  // The unused interpolation helper must still be referenced or some drivers optimise the
  // uniform away and uniformLocation throws at startup.
  if (position < -1.0) outColor += vec4(0.0);
}
`;

function createRadial(gl: WebGL2RenderingContext): ModuleInstance {
  const program = createProgram(gl, radialManifest.id, FULLSCREEN_VERT, FRAG);
  const u = {
    canvas: uniformLocation(gl, program, 'u_canvas'),
    reference: uniformLocation(gl, program, 'u_reference'),
    barCount: uniformLocation(gl, program, 'u_barCount'),
    radius: uniformLocation(gl, program, 'u_radius'),
    length: uniformLocation(gl, program, 'u_length'),
    thickness: uniformLocation(gl, program, 'u_thickness'),
    rotation: uniformLocation(gl, program, 'u_rotation'),
    mirror: uniformLocation(gl, program, 'u_mirror'),
    fill: uniformLocation(gl, program, 'u_fill'),
    innerGlow: uniformLocation(gl, program, 'u_innerGlow'),
    spectrum: uniformLocation(gl, program, 'u_spectrum'),
    bins: uniformLocation(gl, program, 'u_bins'),
  };
  const vao = gl.createVertexArray();
  const analysis = new AnalysisTexture(gl);

  return {
    resize() {},
    render(ctx, params) {
      const { bins } = analysis.update(ctx, str(params, 'source') as Stem);
      const colour = fillColour(str(params, 'fill'));

      gl.useProgram(program);
      analysis.bindTo(0);
      gl.uniform1i(u.spectrum, 0);
      gl.uniform1i(u.bins, bins);
      gl.uniform2f(u.canvas, ctx.canvas.width, ctx.canvas.height);
      // Sizes follow the layer's declared scale reference, so a ring keeps its physical size
      // when the canvas changes shape (module-spec §6).
      gl.uniform1f(u.reference, ctx.canvas.referenceScale);
      gl.uniform1i(u.barCount, Math.round(num(params, 'barCount')));
      gl.uniform1f(u.radius, num(params, 'radius'));
      gl.uniform1f(u.length, num(params, 'length'));
      gl.uniform1f(u.thickness, num(params, 'thickness'));
      gl.uniform1f(u.rotation, (num(params, 'rotation') * Math.PI) / 180);
      gl.uniform1i(u.mirror, params['mirror'] === true ? 1 : 0);
      gl.uniform4f(u.fill, colour.r, colour.g, colour.b, colour.a);
      gl.uniform1f(u.innerGlow, num(params, 'innerGlow'));
      drawFullscreenTriangle(gl, vao);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.useProgram(null);
    },
    dispose() {
      analysis.dispose();
      gl.deleteProgram(program);
      gl.deleteVertexArray(vao);
    },
  };
}

export const radialModule: ModuleDefinition = { manifest: radialManifest, create: createRadial };

/** Re-exported so modules built on the same helper share one import site. */
export { referenceLength };
