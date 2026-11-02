// core.test.flash — a full-frame flash on a fixed schedule in timeline time, for measuring A/V
// sync end to end (export-spec §17 check 8). Deliberately not audio-driven: it tests that frame n
// and audio sample round(n · 48000 / fps) land together in the file, independent of analysis lag.

import { parseHexColor, toLinearPremultiplied } from '../core/color.ts';
import type { ModuleDefinition, ModuleInstance, ModuleManifest } from '../core/module.ts';
import { num, str } from '../core/params.ts';
import { FULLSCREEN_VERT, createProgram, drawFullscreenTriangle, uniformLocation } from '../render/gl.ts';

export const flashManifest: ModuleManifest = {
  id: 'core.test.flash',
  version: '0.1.0',
  kind: 'source',
  name: 'Scheduled flash',
  description: 'Full-frame flash at fixed times, for A/V sync measurement',
  category: 'test',
  tags: ['test', 'sync'],
  capabilities: { needsAnalysis: false, needsInput: false, supportsAspect: true, stateful: false, gpuCost: 'low' },
  paramsSchemaVersion: 1,
  params: [
    { key: 'firstSeconds', label: 'First flash', group: 'Schedule', type: 'float', default: 1, min: 0, max: 36_000, unit: 's' },
    { key: 'periodSeconds', label: 'Period', group: 'Schedule', type: 'float', default: 0.5, min: 0.01, max: 3600, unit: 's' },
    { key: 'durationSeconds', label: 'Duration', group: 'Schedule', type: 'float', default: 0.05, min: 0.001, max: 10, unit: 's' },
    { key: 'color', label: 'Colour', group: 'Appearance', type: 'color', default: '#ffffff' },
  ],
};

/** Whether a flash is lit at timeline time t. Pure; shared by the module and the validator. */
export function flashLit(t: number, first: number, period: number, duration: number): boolean {
  if (t < first) return false;
  const phase = (t - first) % period;
  return phase < duration;
}

const FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform vec4 u_color;
out vec4 outColor;
void main() { outColor = u_color; }
`;

function createFlash(gl: WebGL2RenderingContext): ModuleInstance {
  const program = createProgram(gl, flashManifest.id, FULLSCREEN_VERT, FRAG);
  const uColor = uniformLocation(gl, program, 'u_color');
  const vao = gl.createVertexArray();
  return {
    resize() {},
    render(ctx, params) {
      if (!flashLit(ctx.time.t, num(params, 'firstSeconds'), num(params, 'periodSeconds'), num(params, 'durationSeconds'))) return;
      const c = toLinearPremultiplied(parseHexColor(str(params, 'color')) ?? { r: 1, g: 1, b: 1, a: 1 });
      gl.useProgram(program);
      gl.uniform4f(uColor, c.r, c.g, c.b, c.a);
      drawFullscreenTriangle(gl, vao);
      gl.useProgram(null);
    },
    dispose() {
      gl.deleteProgram(program);
      gl.deleteVertexArray(vao);
    },
  };
}

export const flashModule: ModuleDefinition = { manifest: flashManifest, create: createFlash };
