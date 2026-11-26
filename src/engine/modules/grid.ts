// core.visualizer.grid — a matrix of cells lit by the spectrum.
//
// The "equaliser wall" look: chunky, readable at thumbnail size, and the one module in the
// catalogue that survives heavy compression, because it is made of large flat areas rather than
// thin lines. Which axis the spectrum runs along is a parameter, since the same grid reads as a
// bar meter, a waterfall or a bloom of light depending on the mapping.

import { AnalysisTexture, SPECTRUM_GLSL, fillColour } from './analysis-texture.ts';
import type { ModuleDefinition, ModuleInstance, ModuleManifest } from '../core/module.ts';
import { num, str, type Stem } from '../core/params.ts';
import { FULLSCREEN_VERT, createProgram, drawFullscreenTriangle, uniformLocation } from '../render/gl.ts';

export const gridManifest: ModuleManifest = {
  id: 'core.visualizer.grid',
  version: '0.1.0',
  kind: 'visualizer',
  name: 'Grid',
  description: 'A matrix of cells lit by the spectrum',
  category: 'spectrum',
  tags: ['grid', 'matrix', 'cells', 'equaliser', 'retro'],
  capabilities: { needsAnalysis: true, needsInput: false, supportsAspect: true, stateful: false, gpuCost: 'low' },
  paramsSchemaVersion: 1,
  params: [
    { key: 'source', label: 'Source', group: 'Source', type: 'select:stem', default: 'mix' },
    {
      key: 'mapping', label: 'Spectrum runs', group: 'Shape', type: 'enum', default: 'columns',
      options: [
        { value: 'columns', label: 'Left to right' },
        { value: 'rows', label: 'Bottom to top' },
        { value: 'radial', label: 'Out from the centre' },
      ],
    },
    { key: 'columns', label: 'Columns', group: 'Shape', type: 'int', default: 24, min: 1, max: 128, aspectOverridable: true },
    { key: 'rows', label: 'Rows', group: 'Shape', type: 'int', default: 14, min: 1, max: 128, aspectOverridable: true },
    { key: 'gap', label: 'Gap', group: 'Shape', type: 'float', default: 0.18, min: 0, max: 0.9, unit: '×', description: 'Fraction of a cell left empty' },
    { key: 'rounding', label: 'Rounding', group: 'Shape', type: 'float', default: 0.25, min: 0, max: 1, advanced: true },
    // A meter fills up to the level; a lamp lights every cell by its own value. Both are common
    // enough that picking one would have made the module feel arbitrary.
    { key: 'meter', label: 'Fill as a meter', group: 'Appearance', type: 'bool', default: true, description: 'Cells below the level light fully, rather than each cell fading on its own' },
    { key: 'gain', label: 'Gain', group: 'Appearance', type: 'float', default: 1, min: 0.1, max: 4, softMax: 2, scale: 'log' },
    { key: 'floor', label: 'Unlit level', group: 'Appearance', type: 'float', default: 0.06, min: 0, max: 1, description: 'Brightness of a cell with no energy' },
    { key: 'fill', label: 'Colour', group: 'Appearance', type: 'color', default: '#ff2d95', paletteRole: 'primary' },
  ],
};

const FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
uniform ivec2 u_cells;
uniform int u_mapping;      // 0 columns, 1 rows, 2 radial
uniform float u_gap;
uniform float u_rounding;
uniform bool u_meter;
uniform float u_gain;
uniform float u_floor;
uniform vec4 u_fill;
out vec4 outColor;
${SPECTRUM_GLSL}

void main() {
  vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y);           // y down
  vec2 cells = vec2(u_cells);
  vec2 cell = floor(uv * cells);
  vec2 within = fract(uv * cells);

  // Cell centre in 0..1, so the mapping never depends on where inside a cell we are —
  // every pixel of a cell must resolve to the same spectrum position or the cell shimmers.
  vec2 centre = (cell + 0.5) / cells;

  float position;
  float along;                                     // 0..1 along the meter axis, from the root
  if (u_mapping == 0) {
    position = centre.x;
    along = 1.0 - centre.y;                        // meters grow upwards
  } else if (u_mapping == 1) {
    position = 1.0 - centre.y;
    along = centre.x;
  } else {
    vec2 d = (centre - 0.5) * vec2(2.0);
    position = clamp(length(d), 0.0, 1.0);
    along = position;
  }

  float value = clamp(pf_spectrum(position) * u_gain, 0.0, 1.0);
  float lit = u_meter
    ? 1.0 - smoothstep(value, value + 1.0 / max(u_mapping == 0 ? cells.y : cells.x, 1.0), along)
    : value;
  lit = max(lit, u_floor);

  // Cell shape: a rounded box in cell-local space, antialiased with the derivative so the
  // edge is one pixel wide at any resolution.
  vec2 half_ = vec2(0.5 - u_gap * 0.5);
  vec2 q = abs(within - 0.5) - half_ + u_rounding * min(half_.x, half_.y);
  float box = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - u_rounding * min(half_.x, half_.y);
  float aa = max(fwidth(box), 1e-5);
  float shape = 1.0 - smoothstep(-aa, aa, box);

  outColor = u_fill * (shape * lit);
}
`;

function createGrid(gl: WebGL2RenderingContext): ModuleInstance {
  const program = createProgram(gl, gridManifest.id, FULLSCREEN_VERT, FRAG);
  const u = {
    cells: uniformLocation(gl, program, 'u_cells'),
    mapping: uniformLocation(gl, program, 'u_mapping'),
    gap: uniformLocation(gl, program, 'u_gap'),
    rounding: uniformLocation(gl, program, 'u_rounding'),
    meter: uniformLocation(gl, program, 'u_meter'),
    gain: uniformLocation(gl, program, 'u_gain'),
    floor: uniformLocation(gl, program, 'u_floor'),
    fill: uniformLocation(gl, program, 'u_fill'),
    spectrum: uniformLocation(gl, program, 'u_spectrum'),
    bins: uniformLocation(gl, program, 'u_bins'),
  };
  const vao = gl.createVertexArray();
  const analysis = new AnalysisTexture(gl);

  const MAPPINGS = ['columns', 'rows', 'radial'];

  return {
    resize() {},
    render(ctx, params) {
      const { bins } = analysis.update(ctx, str(params, 'source') as Stem);
      const colour = fillColour(str(params, 'fill'));

      gl.useProgram(program);
      analysis.bindTo(0);
      gl.uniform1i(u.spectrum, 0);
      gl.uniform1i(u.bins, bins);
      gl.uniform2i(u.cells, Math.round(num(params, 'columns')), Math.round(num(params, 'rows')));
      gl.uniform1i(u.mapping, Math.max(0, MAPPINGS.indexOf(str(params, 'mapping'))));
      gl.uniform1f(u.gap, num(params, 'gap'));
      gl.uniform1f(u.rounding, num(params, 'rounding'));
      gl.uniform1i(u.meter, params['meter'] === true ? 1 : 0);
      gl.uniform1f(u.gain, num(params, 'gain'));
      gl.uniform1f(u.floor, num(params, 'floor'));
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

export const gridModule: ModuleDefinition = { manifest: gridManifest, create: createGrid };
