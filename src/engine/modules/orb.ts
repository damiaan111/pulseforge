// core.visualizer.orb — a soft pulsing disc with a rippled edge.
//
// The quiet one in the catalogue, and the reason it earns a slot: not every layer should be a
// spectrum readout. This reads *level*, not detail — it swells with loudness and flickers on
// hits — so it sits underneath a bars or radial layer without competing with it.
//
// The edge ripple is the spectrum read around the circle, which keeps it tied to the music
// rather than being decorative noise.

import { AnalysisTexture, SPECTRUM_GLSL, fillColour } from './analysis-texture.ts';
import type { ModuleDefinition, ModuleInstance, ModuleManifest } from '../core/module.ts';
import { num, str, type Stem } from '../core/params.ts';
import { FULLSCREEN_VERT, createProgram, drawFullscreenTriangle, uniformLocation } from '../render/gl.ts';

export const orbManifest: ModuleManifest = {
  id: 'core.visualizer.orb',
  version: '0.1.0',
  kind: 'visualizer',
  name: 'Orb',
  description: 'A soft disc that swells with loudness and ripples with the spectrum',
  category: 'level',
  tags: ['orb', 'pulse', 'glow', 'neon', 'ambient'],
  capabilities: { needsAnalysis: true, needsInput: false, supportsAspect: true, stateful: false, gpuCost: 'low' },
  paramsSchemaVersion: 1,
  params: [
    { key: 'source', label: 'Source', group: 'Source', type: 'select:stem', default: 'mix' },
    {
      key: 'drive', label: 'Driven by', group: 'Source', type: 'enum', default: 'rms',
      options: [
        { value: 'rms', label: 'Loudness (RMS)' },
        { value: 'peak', label: 'Peak' },
        { value: 'onset', label: 'Onsets' },
        { value: 'beat', label: 'Beat grid' },
      ],
    },
    { key: 'radius', label: 'Radius', group: 'Shape', type: 'float', default: 0.18, min: 0.01, max: 0.6, space: 'canvas' },
    { key: 'swell', label: 'Swell', group: 'Shape', type: 'float', default: 0.35, min: 0, max: 2, softMax: 0.8, description: 'How much the level grows the orb' },
    { key: 'softness', label: 'Softness', group: 'Shape', type: 'float', default: 0.55, min: 0.01, max: 1, description: 'Edge falloff' },
    { key: 'ripple', label: 'Ripple', group: 'Shape', type: 'float', default: 0.25, min: 0, max: 1, description: 'Spectrum displacement around the edge' },
    { key: 'ripples', label: 'Ripple count', group: 'Shape', type: 'int', default: 6, min: 1, max: 32, advanced: true },
    { key: 'fill', label: 'Colour', group: 'Appearance', type: 'color', default: '#7a2fff', paletteRole: 'glow' },
    { key: 'core', label: 'Core brightness', group: 'Appearance', type: 'float', default: 1, min: 0, max: 4, softMax: 2, scale: 'log' },
  ],
};

const FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
uniform vec2 u_canvas;
uniform float u_reference;
uniform float u_radius;
uniform float u_swell;
uniform float u_softness;
uniform float u_ripple;
uniform int u_ripples;
uniform float u_level;
uniform vec4 u_fill;
uniform float u_core;
out vec4 outColor;
${SPECTRUM_GLSL}

const float TAU = 6.283185307179586;

void main() {
  vec2 px = (v_uv * u_canvas) - u_canvas * 0.5;
  float dist = length(px);
  float angle = atan(px.y, px.x);

  // Radius in pixels, grown by the level. referenceScale keeps it the same physical size
  // whatever shape the canvas is.
  float radius = (u_radius + u_level * u_swell * u_radius) * u_reference;

  // Edge displacement from the spectrum, sampled around the circle so it is symmetrical.
  float turn = fract(angle / TAU + 1.0);
  float ripplePosition = abs(turn * 2.0 - 1.0);
  float displacement = pf_spectrum(ripplePosition) * u_ripple * radius * 0.5;
  float rippled = radius + displacement * sin(float(u_ripples) * angle);

  float edge = max(rippled * u_softness, 1.0);
  float body = 1.0 - smoothstep(rippled - edge, rippled + edge * 0.25, dist);
  // Squared so the centre reads as a core rather than a flat disc.
  float intensity = body * body * u_core;
  outColor = u_fill * intensity;
}
`;

function createOrb(gl: WebGL2RenderingContext): ModuleInstance {
  const program = createProgram(gl, orbManifest.id, FULLSCREEN_VERT, FRAG);
  const u = {
    canvas: uniformLocation(gl, program, 'u_canvas'),
    reference: uniformLocation(gl, program, 'u_reference'),
    radius: uniformLocation(gl, program, 'u_radius'),
    swell: uniformLocation(gl, program, 'u_swell'),
    softness: uniformLocation(gl, program, 'u_softness'),
    ripple: uniformLocation(gl, program, 'u_ripple'),
    ripples: uniformLocation(gl, program, 'u_ripples'),
    level: uniformLocation(gl, program, 'u_level'),
    fill: uniformLocation(gl, program, 'u_fill'),
    core: uniformLocation(gl, program, 'u_core'),
    spectrum: uniformLocation(gl, program, 'u_spectrum'),
    bins: uniformLocation(gl, program, 'u_bins'),
  };
  const vao = gl.createVertexArray();
  const analysis = new AnalysisTexture(gl);

  return {
    resize() {},
    render(ctx, params) {
      const { bins, features } = analysis.update(ctx, str(params, 'source') as Stem);
      const drive = str(params, 'drive');
      const level = drive === 'peak' ? features.peak
        : drive === 'onset' ? features.onset
          : drive === 'beat' ? features.beat
            : features.rms;
      const colour = fillColour(str(params, 'fill'));

      gl.useProgram(program);
      analysis.bindTo(0);
      gl.uniform1i(u.spectrum, 0);
      gl.uniform1i(u.bins, bins);
      gl.uniform2f(u.canvas, ctx.canvas.width, ctx.canvas.height);
      gl.uniform1f(u.reference, ctx.canvas.referenceScale);
      gl.uniform1f(u.radius, num(params, 'radius'));
      gl.uniform1f(u.swell, num(params, 'swell'));
      gl.uniform1f(u.softness, num(params, 'softness'));
      gl.uniform1f(u.ripple, num(params, 'ripple'));
      gl.uniform1i(u.ripples, Math.round(num(params, 'ripples')));
      gl.uniform1f(u.level, level);
      gl.uniform4f(u.fill, colour.r, colour.g, colour.b, colour.a);
      gl.uniform1f(u.core, num(params, 'core'));
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

export const orbModule: ModuleDefinition = { manifest: orbManifest, create: createOrb };
