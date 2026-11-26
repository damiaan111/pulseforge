// core.visualizer.particles — a drifting field of points that flare on transients.
//
// The first module in the catalogue that is not a fullscreen triangle: it draws `count` points
// and lets the rasteriser place them. That is worth the extra plumbing because a particle field
// done in a fragment shader costs `count` iterations *per pixel*, and at a few hundred particles
// on a 4K frame that is minutes, not milliseconds.
//
// **Where the randomness comes from matters.** `Math.random` is banned in the engine
// (CLAUDE.md constraint 1), and a CPU-side PRNG would mean uploading a buffer every frame. So
// each particle derives its constants from a hash of its own index and the layer's `seed`
// parameter: no state, no upload, and the same seed gives the same field on every machine —
// integer hashing is exactly specified in GLSL ES 3.00, unlike anything involving `sin` as a
// noise source.
//
// Position is a closed form in `t`, never an accumulator, so scrubbing backwards is free.

import { AnalysisTexture, SPECTRUM_GLSL, fillColour } from './analysis-texture.ts';
import type { ModuleDefinition, ModuleInstance, ModuleManifest } from '../core/module.ts';
import { num, str, type Stem } from '../core/params.ts';
import { createProgram, uniformLocation } from '../render/gl.ts';

export const particlesManifest: ModuleManifest = {
  id: 'core.visualizer.particles',
  version: '0.1.0',
  kind: 'visualizer',
  name: 'Particles',
  description: 'A drifting field of points that flares on transients',
  category: 'ambient',
  tags: ['particles', 'dust', 'stars', 'sparks', 'ambient'],
  capabilities: { needsAnalysis: true, needsInput: false, supportsAspect: true, stateful: false, gpuCost: 'medium' },
  paramsSchemaVersion: 1,
  params: [
    { key: 'source', label: 'Source', group: 'Source', type: 'select:stem', default: 'mix' },
    {
      key: 'flareOn', label: 'Flare on', group: 'Source', type: 'enum', default: 'onset',
      options: [
        { value: 'onset', label: 'Onsets' },
        { value: 'beat', label: 'Beat grid' },
        { value: 'peak', label: 'Peak' },
        { value: 'rms', label: 'Loudness (RMS)' },
      ],
    },
    { key: 'count', label: 'Count', group: 'Field', type: 'int', default: 400, min: 1, max: 4000 },
    { key: 'seed', label: 'Seed', group: 'Field', type: 'int', default: 1, min: 1, max: 9999, description: 'Changes the arrangement; the same seed always gives the same field' },
    { key: 'size', label: 'Size', group: 'Field', type: 'float', default: 0.012, min: 0.001, max: 0.1, space: 'canvas', scale: 'log' },
    { key: 'sizeVariance', label: 'Size variance', group: 'Field', type: 'float', default: 0.6, min: 0, max: 1, advanced: true },
    { key: 'margin', label: 'Margin', group: 'Field', type: 'float', default: 0.05, min: -0.5, max: 0.5, space: 'fraction', description: 'Inset (or outset) of the field from the frame', advanced: true },
    {
      key: 'direction', label: 'Drift', group: 'Motion', type: 'enum', default: 'up',
      options: [
        { value: 'up', label: 'Up' },
        { value: 'down', label: 'Down' },
        { value: 'left', label: 'Left' },
        { value: 'right', label: 'Right' },
      ],
    },
    { key: 'speed', label: 'Speed', group: 'Motion', type: 'float', default: 0.05, min: 0, max: 2, unit: '/s', description: 'Frames crossed per second' },
    { key: 'speedVariance', label: 'Speed variance', group: 'Motion', type: 'float', default: 0.7, min: 0, max: 1 },
    { key: 'sway', label: 'Sway', group: 'Motion', type: 'float', default: 0.02, min: 0, max: 0.25, space: 'fraction', description: 'Side to side wander' },
    { key: 'flare', label: 'Flare', group: 'Appearance', type: 'float', default: 1.2, min: 0, max: 4, softMax: 2, description: 'Extra size and brightness on a transient' },
    { key: 'reactivity', label: 'Spectrum reactivity', group: 'Appearance', type: 'float', default: 0.6, min: 0, max: 2, softMax: 1, description: 'How much each particle follows its own band' },
    { key: 'softness', label: 'Softness', group: 'Appearance', type: 'float', default: 0.7, min: 0, max: 1, description: 'Hard dots to soft glows' },
    { key: 'fill', label: 'Colour', group: 'Appearance', type: 'color', default: '#ffffff', paletteRole: 'accent' },
  ],
};

// A particle's constants come from an integer hash of its index, so nothing is uploaded and
// nothing is remembered. Three decorrelated streams per particle: placement, rate, and band.
const HASH_GLSL = /* glsl */ `
uint pf_hash(uint x) {
  // Thomas Wang's 32-bit integer hash. Exact in GLSL ES 3.00, unlike fract(sin(...)) noise,
  // which differs between drivers and would break "same pixels everywhere".
  x = (x ^ 61u) ^ (x >> 16u);
  x *= 9u;
  x = x ^ (x >> 4u);
  x *= 0x27d4eb2du;
  x = x ^ (x >> 15u);
  return x;
}

float pf_random(uint index, uint stream) {
  return float(pf_hash(index * 747796405u + stream * 2891336453u)) / 4294967296.0;
}
`;

const VERT = /* glsl */ `#version 300 es
precision highp float;
// No u_canvas here: points are placed in clip space and sized by the scale reference, so the
// pixel dimensions never enter the vertex shader. Declaring it anyway would be dropped by the
// compiler and then fail the uniformLocation lookup at startup.
uniform float u_reference;
uniform int u_seed;
uniform float u_size;
uniform float u_sizeVariance;
uniform float u_margin;
uniform int u_direction;
uniform float u_travel;        // speed x time, in frame crossings
uniform float u_speedVariance;
uniform float u_sway;
uniform float u_flare;
uniform float u_level;
uniform float u_reactivity;
out float v_gain;
${HASH_GLSL}
${SPECTRUM_GLSL}

void main() {
  uint index = uint(gl_VertexID) + uint(u_seed) * 65537u;
  float placeA = pf_random(index, 1u);
  float placeB = pf_random(index, 2u);
  float rate = pf_random(index, 3u);
  float band = pf_random(index, 4u);
  // Size gets its own stream. Reusing the placement one made every particle on the right of
  // the frame bigger than every particle on the left — a gradient that reads as a bug.
  float bulk = pf_random(index, 5u);

  // Progress along the drift axis wraps in 0..1 — the field is a loop, not a queue, so no
  // particle is ever "used up" and there is nothing to respawn.
  float pace = mix(1.0, 0.25 + 1.5 * rate, u_speedVariance);
  float along = fract(placeB + u_travel * pace);
  float across = placeA + u_sway * sin((along + placeA) * 6.283185307179586 + rate * 6.0);

  vec2 unit;
  if (u_direction == 0) unit = vec2(across, 1.0 - along);        // up
  else if (u_direction == 1) unit = vec2(across, along);         // down
  else if (u_direction == 2) unit = vec2(1.0 - along, across);   // left
  else unit = vec2(along, across);                               // right

  // The margin insets the field so particles are not clipped in half at the frame edge.
  unit = mix(vec2(u_margin), vec2(1.0 - u_margin), unit);

  float energy = pf_spectrum(band);
  float gain = clamp(mix(1.0, energy * 2.0, u_reactivity) * (0.4 + 0.6 * rate), 0.0, 4.0);
  float flare = 1.0 + u_level * u_flare;
  v_gain = gain * flare;

  float size = u_size * mix(1.0, 0.3 + 1.4 * bulk, u_sizeVariance) * u_reference * flare;
  // Clamped because a point larger than the driver's maximum is silently dropped by some
  // implementations rather than clipped, which would make the layer vanish at high sizes.
  gl_PointSize = clamp(size, 1.0, 255.0);
  gl_Position = vec4(vec2(unit.x, 1.0 - unit.y) * 2.0 - 1.0, 0.0, 1.0);
}
`;

const FRAG = /* glsl */ `#version 300 es
precision highp float;
in float v_gain;
uniform float u_softness;
uniform vec4 u_fill;
out vec4 outColor;

void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  // A hard dot still needs a pixel of antialiasing or the field crawls as points move.
  float inner = mix(0.85, 0.0, u_softness);
  float shape = 1.0 - smoothstep(inner, 1.0, d);
  outColor = u_fill * (shape * shape * v_gain);
}
`;

const DIRECTIONS = ['up', 'down', 'left', 'right'];

function createParticles(gl: WebGL2RenderingContext): ModuleInstance {
  const program = createProgram(gl, particlesManifest.id, VERT, FRAG);
  const u = {
    reference: uniformLocation(gl, program, 'u_reference'),
    seed: uniformLocation(gl, program, 'u_seed'),
    size: uniformLocation(gl, program, 'u_size'),
    sizeVariance: uniformLocation(gl, program, 'u_sizeVariance'),
    margin: uniformLocation(gl, program, 'u_margin'),
    direction: uniformLocation(gl, program, 'u_direction'),
    travel: uniformLocation(gl, program, 'u_travel'),
    speedVariance: uniformLocation(gl, program, 'u_speedVariance'),
    sway: uniformLocation(gl, program, 'u_sway'),
    flare: uniformLocation(gl, program, 'u_flare'),
    level: uniformLocation(gl, program, 'u_level'),
    reactivity: uniformLocation(gl, program, 'u_reactivity'),
    softness: uniformLocation(gl, program, 'u_softness'),
    fill: uniformLocation(gl, program, 'u_fill'),
    spectrum: uniformLocation(gl, program, 'u_spectrum'),
    bins: uniformLocation(gl, program, 'u_bins'),
  };
  const vao = gl.createVertexArray();
  const analysis = new AnalysisTexture(gl);

  return {
    resize() {},
    render(ctx, params) {
      const { bins, features } = analysis.update(ctx, str(params, 'source') as Stem);
      const flareOn = str(params, 'flareOn');
      const level = flareOn === 'beat' ? features.beat
        : flareOn === 'peak' ? features.peak
          : flareOn === 'rms' ? features.rms
            : features.onset;
      const colour = fillColour(str(params, 'fill'));

      gl.useProgram(program);
      analysis.bindTo(0);
      gl.uniform1i(u.spectrum, 0);
      gl.uniform1i(u.bins, bins);
      gl.uniform1f(u.reference, ctx.canvas.referenceScale);
      gl.uniform1i(u.seed, Math.round(num(params, 'seed')));
      gl.uniform1f(u.size, num(params, 'size'));
      gl.uniform1f(u.sizeVariance, num(params, 'sizeVariance'));
      gl.uniform1f(u.margin, num(params, 'margin'));
      gl.uniform1i(u.direction, Math.max(0, DIRECTIONS.indexOf(str(params, 'direction'))));
      gl.uniform1f(u.travel, ctx.time.t * num(params, 'speed'));
      gl.uniform1f(u.speedVariance, num(params, 'speedVariance'));
      gl.uniform1f(u.sway, num(params, 'sway'));
      gl.uniform1f(u.flare, num(params, 'flare'));
      gl.uniform1f(u.level, level);
      gl.uniform1f(u.reactivity, num(params, 'reactivity'));
      gl.uniform1f(u.softness, num(params, 'softness'));
      gl.uniform4f(u.fill, colour.r, colour.g, colour.b, colour.a);

      // Additive within the layer: overlapping particles should build up light rather than
      // occlude each other. The host's premultiplied "over" is restored afterwards, because
      // the next module in the chain is entitled to the state the compositor set up.
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.POINTS, 0, Math.round(num(params, 'count')));
      gl.bindVertexArray(null);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

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

export const particlesModule: ModuleDefinition = { manifest: particlesManifest, create: createParticles };
