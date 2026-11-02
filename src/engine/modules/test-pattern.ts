// core.test.pattern — fixed colour patches for measuring the output pipeline (export-spec §17 check 4).
// The expected encoded values are computed from TEST_PATTERN_COLORS by the validator, so the
// patch list is the single source of truth for both drawing and checking.

import { parseHexColor, srgbToLinear } from '../core/color.ts';
import type { ModuleDefinition, ModuleInstance, ModuleManifest } from '../core/module.ts';
import { FULLSCREEN_VERT, createProgram, drawFullscreenTriangle, uniformLocation } from '../render/gl.ts';

/** Row-major, top-left first. A grey ramp, primaries/secondaries below the tone knee, palette colours, and two above it. */
export const TEST_PATTERN_COLORS: readonly string[] = [
  '#000000', '#202020', '#404040', '#606060', '#808080', '#a0a0a0', '#c0c0c0', '#e0e0e0',
  '#e00000', '#00e000', '#0000e0', '#e0e000', '#00e0e0', '#e000e0', '#0b0614', '#ff2d95',
  '#ffffff', '#ff0000', '#101010', '#f0f0f0', '#7f3fbf', '#3fbf7f', '#bf7f3f', '#1a1a2e',
];
export const TEST_PATTERN_COLUMNS = 8;
export const TEST_PATTERN_ROWS = 3;

export const testPatternManifest: ModuleManifest = {
  id: 'core.test.pattern',
  version: '0.1.0',
  kind: 'source',
  name: 'Test pattern',
  description: 'Fixed colour patches for output-pipeline measurement',
  category: 'test',
  tags: ['test', 'calibration'],
  capabilities: { needsAnalysis: false, needsInput: false, supportsAspect: true, stateful: false, gpuCost: 'low' },
  paramsSchemaVersion: 1,
  params: [],
};

const FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 u_canvas;
uniform vec4 u_colors[${TEST_PATTERN_COLORS.length}];
out vec4 outColor;
void main() {
  vec2 p = vec2(gl_FragCoord.x, u_canvas.y - gl_FragCoord.y) / u_canvas; // y down
  int col = min(int(p.x * ${TEST_PATTERN_COLUMNS}.0), ${TEST_PATTERN_COLUMNS - 1});
  int row = min(int(p.y * ${TEST_PATTERN_ROWS}.0), ${TEST_PATTERN_ROWS - 1});
  outColor = u_colors[row * ${TEST_PATTERN_COLUMNS} + col];
}
`;

function createTestPattern(gl: WebGL2RenderingContext): ModuleInstance {
  const program = createProgram(gl, testPatternManifest.id, FULLSCREEN_VERT, FRAG);
  const uCanvas = uniformLocation(gl, program, 'u_canvas');
  const uColors = uniformLocation(gl, program, 'u_colors[0]');
  const vao = gl.createVertexArray();
  const colors = new Float32Array(TEST_PATTERN_COLORS.length * 4);
  TEST_PATTERN_COLORS.forEach((hex, i) => {
    const c = parseHexColor(hex) ?? { r: 1, g: 0, b: 1, a: 1 };
    colors.set([srgbToLinear(c.r), srgbToLinear(c.g), srgbToLinear(c.b), 1], i * 4);
  });
  return {
    resize() {},
    render(ctx) {
      gl.disable(gl.BLEND);
      gl.useProgram(program);
      gl.uniform2f(uCanvas, ctx.canvas.width, ctx.canvas.height);
      gl.uniform4fv(uColors, colors);
      drawFullscreenTriangle(gl, vao);
      gl.useProgram(null);
    },
    dispose() {
      gl.deleteProgram(program);
      gl.deleteVertexArray(vao);
    },
  };
}

export const testPatternModule: ModuleDefinition = { manifest: testPatternManifest, create: createTestPattern };
