// core.visualizer.blobs — metaballs that merge and separate with the music.
//
// Every other module in the catalogue is made of edges: bars, lines, rings, cells. This one is
// made of *mass*, and that is the whole reason it exists — a frame needs something organic in it
// or the result looks like an instrument panel.
//
// Each blob sits on a slowly turning orbit and swells with its own slice of the spectrum. The
// field is summed and thresholded, so two blobs that come close merge into one shape instead of
// overlapping, which is what separates a metaball from a pile of circles.

import { AnalysisTexture, SPECTRUM_GLSL, fillColour } from './analysis-texture.ts';
import type { ModuleDefinition, ModuleInstance, ModuleManifest } from '../core/module.ts';
import { num, str, type Stem } from '../core/params.ts';
import { FULLSCREEN_VERT, createProgram, drawFullscreenTriangle, uniformLocation } from '../render/gl.ts';

/** Matches the loop bound in the shader. */
const MAX_BLOBS = 12;

export const blobsManifest: ModuleManifest = {
  id: 'core.visualizer.blobs',
  version: '0.1.0',
  kind: 'visualizer',
  name: 'Blobs',
  description: 'Metaballs that swell with the spectrum and merge as they meet',
  category: 'organic',
  tags: ['blobs', 'metaballs', 'organic', 'lava', 'soft'],
  capabilities: { needsAnalysis: true, needsInput: false, supportsAspect: true, stateful: false, gpuCost: 'medium' },
  paramsSchemaVersion: 1,
  params: [
    { key: 'source', label: 'Source', group: 'Source', type: 'select:stem', default: 'mix' },
    { key: 'count', label: 'Blobs', group: 'Shape', type: 'int', default: 5, min: 1, max: MAX_BLOBS },
    { key: 'radius', label: 'Radius', group: 'Shape', type: 'float', default: 0.06, min: 0.01, max: 0.4, space: 'canvas' },
    { key: 'swell', label: 'Swell', group: 'Shape', type: 'float', default: 0.6, min: 0, max: 3, softMax: 1.5, description: 'How much the spectrum grows each blob' },
    { key: 'orbit', label: 'Orbit', group: 'Shape', type: 'float', default: 0.2, min: 0, max: 0.5, space: 'canvas', description: 'How far from the centre the blobs sit' },
    { key: 'threshold', label: 'Threshold', group: 'Shape', type: 'float', default: 1.2, min: 0.05, max: 4, softMax: 2, description: 'Where the field becomes surface; lower merges more' },
    { key: 'speed', label: 'Speed', group: 'Motion', type: 'float', default: 0.08, min: -2, max: 2, unit: '/s', description: 'Turns of the orbit per second' },
    { key: 'wobble', label: 'Wobble', group: 'Motion', type: 'float', default: 0.35, min: 0, max: 2, description: 'Breathing of the orbit radius' },
    { key: 'edge', label: 'Edge softness', group: 'Appearance', type: 'float', default: 0.12, min: 0.001, max: 1, scale: 'log' },
    { key: 'rim', label: 'Rim', group: 'Appearance', type: 'float', default: 0.35, min: 0, max: 1, description: 'Brighten the outline of the surface' },
    { key: 'fill', label: 'Colour', group: 'Appearance', type: 'color', default: '#7a2fff', paletteRole: 'glow' },
  ],
};

const FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
uniform vec2 u_canvas;
uniform float u_reference;
uniform int u_count;
uniform float u_radius;
uniform float u_swell;
uniform float u_orbit;
uniform float u_threshold;
uniform float u_turn;        // speed x time, in turns
uniform float u_wobble;
uniform float u_edge;
uniform float u_rim;
uniform vec4 u_fill;
out vec4 outColor;
${SPECTRUM_GLSL}

const float TAU = 6.283185307179586;

void main() {
  vec2 p = (v_uv * u_canvas - u_canvas * 0.5) / max(u_reference, 1.0);

  float field = 0.0;
  for (int i = 0; i < ${MAX_BLOBS}; i++) {
    if (i >= u_count) break;
    float share = float(i) / float(max(u_count - 1, 1));

    // Each blob reads its own slice of the spectrum. Spacing them evenly means the low end
    // always drives one blob, so a bass-heavy track still moves something.
    float energy = pf_spectrum(share);

    float angle = (share + u_turn) * TAU;
    // The orbit breathes rather than being a rigid circle; the phase offset per blob keeps
    // them from all breathing together, which would read as a single pulsing ring.
    float orbit = u_orbit * (1.0 + u_wobble * 0.3 * sin(angle * 2.0 + float(i) * 1.7));
    vec2 centre = vec2(cos(angle), sin(angle)) * orbit;

    float radius = u_radius * (1.0 + energy * u_swell);
    float d = length(p - centre);
    // Inverse-square falloff: the classic metaball kernel. The epsilon keeps the singularity
    // at the centre from producing an inf, which would make the whole frame white.
    field += (radius * radius) / max(d * d, 1e-6);
  }

  // The surface is where the summed field crosses the threshold.
  float surface = field - u_threshold;
  float inside = smoothstep(-u_edge, u_edge, surface);
  // A rim is the band just around the surface, which gives the shape an outline without a
  // separate pass.
  float rim = (1.0 - smoothstep(0.0, u_edge * 3.0, abs(surface))) * u_rim;

  outColor = u_fill * clamp(inside + rim, 0.0, 1.0);
}
`;

function createBlobs(gl: WebGL2RenderingContext): ModuleInstance {
  const program = createProgram(gl, blobsManifest.id, FULLSCREEN_VERT, FRAG);
  const u = {
    canvas: uniformLocation(gl, program, 'u_canvas'),
    reference: uniformLocation(gl, program, 'u_reference'),
    count: uniformLocation(gl, program, 'u_count'),
    radius: uniformLocation(gl, program, 'u_radius'),
    swell: uniformLocation(gl, program, 'u_swell'),
    orbit: uniformLocation(gl, program, 'u_orbit'),
    threshold: uniformLocation(gl, program, 'u_threshold'),
    turn: uniformLocation(gl, program, 'u_turn'),
    wobble: uniformLocation(gl, program, 'u_wobble'),
    edge: uniformLocation(gl, program, 'u_edge'),
    rim: uniformLocation(gl, program, 'u_rim'),
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
      gl.uniform1i(u.count, Math.round(num(params, 'count')));
      gl.uniform1f(u.radius, num(params, 'radius'));
      gl.uniform1f(u.swell, num(params, 'swell'));
      gl.uniform1f(u.orbit, num(params, 'orbit'));
      gl.uniform1f(u.threshold, num(params, 'threshold'));
      gl.uniform1f(u.turn, ctx.time.t * num(params, 'speed'));
      gl.uniform1f(u.wobble, num(params, 'wobble'));
      gl.uniform1f(u.edge, num(params, 'edge'));
      gl.uniform1f(u.rim, num(params, 'rim'));
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

export const blobsModule: ModuleDefinition = { manifest: blobsManifest, create: createBlobs };
