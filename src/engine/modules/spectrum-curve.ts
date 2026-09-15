// core.visualizer.curve — a smooth spectrum line with an optional filled body.
//
// The counterpart to bars: the same data read as a continuous shape. Distance to the curve is
// computed by sampling the spectrum either side of each pixel, so the line has a real thickness
// in pixels and stays the same weight at 1080p and 4K — a line width in pixels is the single
// most common way resolution independence goes wrong (module-spec §6).

import { AnalysisTexture, SPECTRUM_GLSL, fillColour } from './analysis-texture.ts';
import type { ModuleDefinition, ModuleInstance, ModuleManifest } from '../core/module.ts';
import { num, str, type Stem } from '../core/params.ts';
import { FULLSCREEN_VERT, createProgram, drawFullscreenTriangle, uniformLocation } from '../render/gl.ts';

export const curveManifest: ModuleManifest = {
  id: 'core.visualizer.curve',
  version: '0.1.0',
  kind: 'visualizer',
  name: 'Spectrum curve',
  description: 'A smooth line following the spectrum, optionally filled',
  category: 'spectrum',
  tags: ['curve', 'line', 'spectrum', 'minimal'],
  capabilities: { needsAnalysis: true, needsInput: false, supportsAspect: true, stateful: false, gpuCost: 'low' },
  paramsSchemaVersion: 1,
  params: [
    { key: 'source', label: 'Source', group: 'Source', type: 'select:stem', default: 'mix' },
    { key: 'baseline', label: 'Baseline', group: 'Shape', type: 'float', default: 0.75, min: 0, max: 1, space: 'fraction' },
    { key: 'height', label: 'Height', group: 'Shape', type: 'float', default: 0.45, min: 0.01, max: 1, space: 'fraction', aspectOverridable: true },
    { key: 'spread', label: 'Spread', group: 'Shape', type: 'float', default: 0.92, min: 0.1, max: 1, space: 'fraction' },
    { key: 'thickness', label: 'Line width', group: 'Shape', type: 'float', default: 0.004, min: 0.0005, max: 0.03, space: 'canvas', scale: 'log' },
    { key: 'mirror', label: 'Mirror', group: 'Shape', type: 'bool', default: false, description: 'Reflect the curve below the baseline' },
    { key: 'fillBody', label: 'Fill under', group: 'Appearance', type: 'float', default: 0.25, min: 0, max: 1, description: 'Opacity of the area under the line' },
    { key: 'fill', label: 'Colour', group: 'Appearance', type: 'color', default: '#00e5ff', paletteRole: 'secondary' },
  ],
};

const FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
uniform vec2 u_canvas;
uniform float u_reference;
uniform float u_baseline;
uniform float u_height;
uniform float u_spread;
uniform float u_thickness;
uniform bool u_mirror;
uniform float u_fillBody;
uniform vec4 u_fill;
out vec4 outColor;
${SPECTRUM_GLSL}

void main() {
  // y down, to match the baseline parameter reading as "from the top".
  vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y);
  float halfSpread = u_spread * 0.5;
  float position = (uv.x - (0.5 - halfSpread)) / max(u_spread, 1e-4);
  if (position < 0.0 || position > 1.0) { outColor = vec4(0.0); return; }

  float baselinePx = u_baseline * u_canvas.y;
  float pixelY = uv.y * u_canvas.y;
  float thicknessPx = max(1.0, u_thickness * u_reference);

  // Sample either side to approximate distance to a sloped line; a purely vertical distance
  // makes steep sections look thin, which is exactly where the eye is drawn.
  // Deliberately not called "step": that shadows the GLSL built-in of the same name, and every
  // later use of it then fails to compile.
  float dx = 1.0 / max(u_canvas.x * u_spread, 1.0);
  float here = pf_spectrum(position);
  float before = pf_spectrum(position - dx);
  float after = pf_spectrum(position + dx);
  float slope = (after - before) * 0.5 / dx * u_height * u_canvas.y / max(u_canvas.x * u_spread, 1.0);

  float curveY = baselinePx - here * u_height * u_canvas.y;
  float vertical = pixelY - curveY;
  float distance = abs(vertical) / sqrt(1.0 + slope * slope);
  float line = 1.0 - smoothstep(thicknessPx * 0.5 - 0.5, thicknessPx * 0.5 + 0.5, distance);

  float body = 0.0;
  if (u_fillBody > 0.0) {
    float inside = u_mirror
      ? step(abs(pixelY - baselinePx), here * u_height * u_canvas.y)
      : step(curveY, pixelY) * step(pixelY, baselinePx);
    body = inside * u_fillBody;
  }

  if (u_mirror) {
    float mirrored = baselinePx + here * u_height * u_canvas.y;
    float mirroredDistance = abs(pixelY - mirrored) / sqrt(1.0 + slope * slope);
    line = max(line, 1.0 - smoothstep(thicknessPx * 0.5 - 0.5, thicknessPx * 0.5 + 0.5, mirroredDistance));
  }

  outColor = u_fill * max(line, body);
}
`;

function createCurve(gl: WebGL2RenderingContext): ModuleInstance {
  const program = createProgram(gl, curveManifest.id, FULLSCREEN_VERT, FRAG);
  const u = {
    canvas: uniformLocation(gl, program, 'u_canvas'),
    reference: uniformLocation(gl, program, 'u_reference'),
    baseline: uniformLocation(gl, program, 'u_baseline'),
    height: uniformLocation(gl, program, 'u_height'),
    spread: uniformLocation(gl, program, 'u_spread'),
    thickness: uniformLocation(gl, program, 'u_thickness'),
    mirror: uniformLocation(gl, program, 'u_mirror'),
    fillBody: uniformLocation(gl, program, 'u_fillBody'),
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
      gl.uniform1f(u.baseline, num(params, 'baseline'));
      gl.uniform1f(u.height, num(params, 'height'));
      gl.uniform1f(u.spread, num(params, 'spread'));
      gl.uniform1f(u.thickness, num(params, 'thickness'));
      gl.uniform1i(u.mirror, params['mirror'] === true ? 1 : 0);
      gl.uniform1f(u.fillBody, num(params, 'fillBody'));
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

export const curveModule: ModuleDefinition = { manifest: curveManifest, create: createCurve };
