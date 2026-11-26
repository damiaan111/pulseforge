// core.visualizer.waves — stacked travelling sine lines, each driven by a different part of the
// spectrum.
//
// Where `curve` draws the spectrum *as a shape*, this draws it as *motion*: the lines are always
// smooth, and it is their amplitude that carries the music. That makes it the calmest module in
// the catalogue and the one that survives being a background, because there is nothing in it
// that flickers on a single frame.
//
// Phase comes from `ctx.time.t` only — never an accumulator — so seeking to a frame gives the
// same wave as playing to it (module-spec §7 rule 3).

import { AnalysisTexture, SPECTRUM_GLSL, fillColour } from './analysis-texture.ts';
import type { ModuleDefinition, ModuleInstance, ModuleManifest } from '../core/module.ts';
import { num, str, type Stem } from '../core/params.ts';
import { FULLSCREEN_VERT, createProgram, drawFullscreenTriangle, uniformLocation } from '../render/gl.ts';

/** Matches the loop bound in the shader; GLSL ES 3.00 needs a constant there. */
const MAX_LINES = 32;

export const wavesManifest: ModuleManifest = {
  id: 'core.visualizer.waves',
  version: '0.1.0',
  kind: 'visualizer',
  name: 'Waves',
  description: 'Stacked travelling lines, each driven by a band of the spectrum',
  category: 'ambient',
  tags: ['waves', 'lines', 'calm', 'background', 'ambient'],
  capabilities: { needsAnalysis: true, needsInput: false, supportsAspect: true, stateful: false, gpuCost: 'low' },
  paramsSchemaVersion: 1,
  params: [
    { key: 'source', label: 'Source', group: 'Source', type: 'select:stem', default: 'mix' },
    { key: 'lines', label: 'Lines', group: 'Shape', type: 'int', default: 9, min: 1, max: MAX_LINES },
    { key: 'spacing', label: 'Spacing', group: 'Shape', type: 'float', default: 0.5, min: 0.02, max: 1, space: 'fraction', description: 'Vertical extent the stack fills' },
    { key: 'amplitude', label: 'Amplitude', group: 'Shape', type: 'float', default: 0.07, min: 0, max: 0.4, space: 'fraction' },
    { key: 'wavelength', label: 'Wavelength', group: 'Shape', type: 'float', default: 0.45, min: 0.05, max: 2, space: 'fraction', scale: 'log' },
    { key: 'speed', label: 'Speed', group: 'Motion', type: 'float', default: 0.18, min: -2, max: 2, unit: '/s', description: 'Wavelengths travelled per second' },
    { key: 'stagger', label: 'Stagger', group: 'Motion', type: 'float', default: 0.35, min: -2, max: 2, description: 'How much each line lags the one below it' },
    { key: 'thickness', label: 'Line width', group: 'Appearance', type: 'float', default: 0.003, min: 0.0005, max: 0.03, space: 'canvas', scale: 'log' },
    { key: 'fade', label: 'Fade with depth', group: 'Appearance', type: 'float', default: 0.5, min: 0, max: 1, description: 'Dim the upper lines' },
    { key: 'fill', label: 'Colour', group: 'Appearance', type: 'color', default: '#00e5ff', paletteRole: 'secondary' },
  ],
};

const FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
uniform vec2 u_canvas;
uniform float u_reference;
uniform int u_lines;
uniform float u_spacing;
uniform float u_amplitude;
uniform float u_wavelength;
uniform float u_phase;        // speed x time, in wavelengths
uniform float u_stagger;
uniform float u_thickness;
uniform float u_fade;
uniform vec4 u_fill;
out vec4 outColor;
${SPECTRUM_GLSL}

const float TAU = 6.283185307179586;

void main() {
  vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y);
  float thicknessPx = max(1.0, u_thickness * u_reference);
  float total = 0.0;

  for (int i = 0; i < ${MAX_LINES}; i++) {
    if (i >= u_lines) break;
    float depth = float(i) / float(max(u_lines - 1, 1));

    // Each line reads its own slice of the spectrum, low at the bottom.
    float amplitude = pf_spectrum(depth) * u_amplitude;

    float centre = 0.5 + (depth - 0.5) * u_spacing;
    float phase = (uv.x / max(u_wavelength, 1e-3) + u_phase + depth * u_stagger) * TAU;
    // A second, slower harmonic keeps the line from reading as a pure sine, which at these
    // amplitudes looks mechanical.
    float offset = amplitude * (sin(phase) * 0.75 + sin(phase * 0.5 + depth * 3.0) * 0.25);
    float y = centre + offset;

    // Distance to a sine is measured perpendicular to it, using the analytic slope; without
    // this the lines visibly thin out wherever they are steep.
    float slope = amplitude * TAU / max(u_wavelength, 1e-3) * cos(phase) * u_canvas.y / u_canvas.x;
    float distancePx = abs(uv.y - y) * u_canvas.y / sqrt(1.0 + slope * slope);
    float line = 1.0 - smoothstep(thicknessPx * 0.5 - 0.5, thicknessPx * 0.5 + 0.5, distancePx);

    total = max(total, line * mix(1.0, 1.0 - depth * 0.85, u_fade));
  }

  outColor = u_fill * total;
}
`;

function createWaves(gl: WebGL2RenderingContext): ModuleInstance {
  const program = createProgram(gl, wavesManifest.id, FULLSCREEN_VERT, FRAG);
  const u = {
    canvas: uniformLocation(gl, program, 'u_canvas'),
    reference: uniformLocation(gl, program, 'u_reference'),
    lines: uniformLocation(gl, program, 'u_lines'),
    spacing: uniformLocation(gl, program, 'u_spacing'),
    amplitude: uniformLocation(gl, program, 'u_amplitude'),
    wavelength: uniformLocation(gl, program, 'u_wavelength'),
    phase: uniformLocation(gl, program, 'u_phase'),
    stagger: uniformLocation(gl, program, 'u_stagger'),
    thickness: uniformLocation(gl, program, 'u_thickness'),
    fade: uniformLocation(gl, program, 'u_fade'),
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
      gl.uniform1i(u.lines, Math.round(num(params, 'lines')));
      gl.uniform1f(u.spacing, num(params, 'spacing'));
      gl.uniform1f(u.amplitude, num(params, 'amplitude'));
      gl.uniform1f(u.wavelength, num(params, 'wavelength'));
      // Phase from absolute time, not accumulated between frames.
      gl.uniform1f(u.phase, ctx.time.t * num(params, 'speed'));
      gl.uniform1f(u.stagger, num(params, 'stagger'));
      gl.uniform1f(u.thickness, num(params, 'thickness'));
      gl.uniform1f(u.fade, num(params, 'fade'));
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

export const wavesModule: ModuleDefinition = { manifest: wavesManifest, create: createWaves };
