// core.visualizer.tunnel — rings receding into the distance, driven by the spectrum.
//
// The only module in the catalogue that reads as *depth*, which is why it is worth a slot even
// though it is the same analysis data as every other one: a flat frame and a receding one cut
// together well, and a video made entirely of flat layers gets monotonous fast.
//
// The perspective is analytic — `depth = 1 / radius` — rather than geometry, so there is no
// camera, no matrices and nothing to keep in sync between preview and export. Motion comes from
// `ctx.time.t` alone.

import { AnalysisTexture, SPECTRUM_GLSL, fillColour } from './analysis-texture.ts';
import type { ModuleDefinition, ModuleInstance, ModuleManifest } from '../core/module.ts';
import { num, str, type Stem } from '../core/params.ts';
import { FULLSCREEN_VERT, createProgram, drawFullscreenTriangle, uniformLocation } from '../render/gl.ts';

export const tunnelManifest: ModuleManifest = {
  id: 'core.visualizer.tunnel',
  version: '0.1.0',
  kind: 'visualizer',
  name: 'Tunnel',
  description: 'Rings receding into the distance, sized by the spectrum',
  category: 'motion',
  tags: ['tunnel', 'depth', 'rings', 'retro', 'motion'],
  capabilities: { needsAnalysis: true, needsInput: false, supportsAspect: true, stateful: false, gpuCost: 'medium' },
  paramsSchemaVersion: 1,
  params: [
    { key: 'source', label: 'Source', group: 'Source', type: 'select:stem', default: 'mix' },
    { key: 'rings', label: 'Rings', group: 'Shape', type: 'float', default: 7, min: 1, max: 40, description: 'Rings per unit of depth' },
    { key: 'segments', label: 'Segments', group: 'Shape', type: 'int', default: 0, min: 0, max: 64, description: 'Radial spokes; 0 for smooth rings' },
    { key: 'twist', label: 'Twist', group: 'Shape', type: 'float', default: 0.35, min: -3, max: 3, description: 'Rotation per unit of depth' },
    { key: 'thickness', label: 'Ring width', group: 'Shape', type: 'float', default: 0.14, min: 0.01, max: 0.5, unit: '×', description: 'Fraction of the gap between rings' },
    { key: 'speed', label: 'Speed', group: 'Motion', type: 'float', default: 0.5, min: -4, max: 4, unit: '/s' },
    { key: 'spin', label: 'Spin', group: 'Motion', type: 'float', default: 6, min: -180, max: 180, unit: '°/s' },
    { key: 'reactivity', label: 'Reactivity', group: 'Motion', type: 'float', default: 0.5, min: 0, max: 2, softMax: 1, description: 'How much the spectrum widens each ring' },
    { key: 'haze', label: 'Distance haze', group: 'Appearance', type: 'float', default: 0.8, min: 0, max: 1, description: 'Fade rings out towards the vanishing point' },
    { key: 'fill', label: 'Colour', group: 'Appearance', type: 'color', default: '#00e5ff', paletteRole: 'secondary' },
  ],
};

const FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
uniform vec2 u_canvas;
uniform float u_reference;
uniform float u_rings;
uniform int u_segments;
uniform float u_twist;
uniform float u_thickness;
uniform float u_travel;      // speed x time, in depth units
uniform float u_spin;        // radians
uniform float u_reactivity;
uniform float u_haze;
uniform vec4 u_fill;
out vec4 outColor;
${SPECTRUM_GLSL}

const float TAU = 6.283185307179586;

void main() {
  vec2 px = (v_uv * u_canvas) - u_canvas * 0.5;
  // Normalised so the tunnel keeps its shape when the canvas does not.
  vec2 p = px / max(u_reference, 1.0);
  float radius = length(p);
  // Right at the centre the perspective divide blows up; clamping is what stops a single
  // white pixel appearing at the vanishing point on some drivers and not others.
  radius = max(radius, 1e-3);

  float depth = 0.25 / radius + u_travel;
  float angle = atan(p.y, p.x) + u_spin + depth * u_twist;

  // Near rings read the low end, far rings the high end: the spectrum is laid along the
  // tunnel rather than around it, which is what makes the depth legible.
  float position = clamp(fract(depth * 0.25), 0.0, 1.0);
  float energy = pf_spectrum(position);

  float band = fract(depth * u_rings);
  float half_ = u_thickness * (0.5 + energy * u_reactivity);
  float edge = abs(band - 0.5);
  // Width in screen terms shrinks with depth, so antialias against the derivative rather
  // than a constant: a far ring is thinner than a pixel and must fade, not alias.
  float aa = max(fwidth(band), 1e-4);
  float ring = 1.0 - smoothstep(half_ - aa, half_ + aa, edge);
  // Past about a ring every two pixels the pattern is beyond what the frame can carry, and
  // widening the antialiasing only turns it into moire. Fading those rings out entirely is
  // the honest answer — it is also what a real tunnel looks like, receding into haze.
  ring *= 1.0 - smoothstep(0.15, 0.4, aa);

  float spokes = 1.0;
  if (u_segments > 0) {
    float turn = fract(angle / TAU + 1.0) * float(u_segments);
    float across = abs(fract(turn) - 0.5);
    float aaTurn = max(fwidth(turn), 1e-4);
    spokes = smoothstep(0.5 - u_thickness - aaTurn, 0.5 - u_thickness + aaTurn, across);
    spokes = mix(1.0, spokes, 1.0 - smoothstep(0.15, 0.4, aaTurn));
  }

  // Haze: rings far down the tunnel dim out instead of crowding into a bright blur.
  float fade = mix(1.0, smoothstep(0.0, 0.35, radius), u_haze);

  outColor = u_fill * (ring * spokes * fade);
}
`;

function createTunnel(gl: WebGL2RenderingContext): ModuleInstance {
  const program = createProgram(gl, tunnelManifest.id, FULLSCREEN_VERT, FRAG);
  const u = {
    canvas: uniformLocation(gl, program, 'u_canvas'),
    reference: uniformLocation(gl, program, 'u_reference'),
    rings: uniformLocation(gl, program, 'u_rings'),
    segments: uniformLocation(gl, program, 'u_segments'),
    twist: uniformLocation(gl, program, 'u_twist'),
    thickness: uniformLocation(gl, program, 'u_thickness'),
    travel: uniformLocation(gl, program, 'u_travel'),
    spin: uniformLocation(gl, program, 'u_spin'),
    reactivity: uniformLocation(gl, program, 'u_reactivity'),
    haze: uniformLocation(gl, program, 'u_haze'),
    fill: uniformLocation(gl, program, 'u_fill'),
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
      gl.uniform1f(u.reference, ctx.canvas.referenceScale);
      gl.uniform1f(u.rings, num(params, 'rings'));
      gl.uniform1i(u.segments, Math.round(num(params, 'segments')));
      gl.uniform1f(u.twist, num(params, 'twist'));
      gl.uniform1f(u.thickness, num(params, 'thickness'));
      // Both derived from absolute time: seeking lands on the same frame as playing does.
      gl.uniform1f(u.travel, ctx.time.t * num(params, 'speed'));
      gl.uniform1f(u.spin, (ctx.time.t * num(params, 'spin') * Math.PI) / 180);
      gl.uniform1f(u.reactivity, num(params, 'reactivity'));
      gl.uniform1f(u.haze, num(params, 'haze'));
      gl.uniform4f(u.fill, colour.r, colour.g, colour.b, colour.a);
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

export const tunnelModule: ModuleDefinition = { manifest: tunnelManifest, create: createTunnel };
