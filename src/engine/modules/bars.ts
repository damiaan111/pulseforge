// core.visualizer.bars — the P0 subset of module-spec §14: linear frequency bars.
// Sizes are canvas fractions, so the same params render identically at 1080p and 4K.

import { sampleTrackInto } from '../core/analysis.ts';
import { parseHexColor, toLinearPremultiplied } from '../core/color.ts';
import type { ModuleDefinition, ModuleInstance, ModuleManifest } from '../core/module.ts';
import { num, str, type Stem } from '../core/params.ts';
import { createProgram, uniformLocation } from '../render/gl.ts';

const MAX_BARS = 256;

export const barsManifest: ModuleManifest = {
  id: 'core.visualizer.bars',
  version: '0.1.0',
  kind: 'visualizer',
  name: 'Bars',
  description: 'Frequency bars across the canvas',
  category: 'spectrum',
  tags: ['bars', 'spectrum', '2d', 'neon'],
  capabilities: { needsAnalysis: true, needsInput: false, supportsAspect: true, stateful: false, gpuCost: 'low' },
  paramsSchemaVersion: 1,
  params: [
    { key: 'source', label: 'Source', group: 'Source', type: 'select:stem', default: 'mix' },
    { key: 'barCount', label: 'Bar count', group: 'Shape', type: 'int', default: 64, min: 8, max: MAX_BARS, aspectOverridable: true },
    { key: 'barWidth', label: 'Bar width', group: 'Shape', type: 'float', default: 0.7, min: 0.05, max: 1, unit: '×', description: 'Fraction of each bar\'s slot' },
    { key: 'spread', label: 'Spread', group: 'Shape', type: 'float', default: 0.9, min: 0.1, max: 1, space: 'fraction', description: 'Width of the whole row, as a fraction of the canvas' },
    { key: 'baseline', label: 'Baseline', group: 'Shape', type: 'float', default: 0.82, min: 0, max: 1, space: 'fraction', description: 'Vertical position of the bars\' bottom edge, from the top' },
    { key: 'minHeight', label: 'Min height', group: 'Shape', type: 'float', default: 0.01, min: 0, max: 0.3, space: 'fraction' },
    { key: 'maxHeight', label: 'Max height', group: 'Shape', type: 'float', default: 0.6, min: 0, max: 1, space: 'fraction', aspectOverridable: true },
    { key: 'fill', label: 'Fill', group: 'Appearance', type: 'color', default: '#ff2d95', paletteRole: 'primary', modulatable: true },
  ],
};

/**
 * Maps `bins` spectrum values onto `barCount` bars: averages when there are more bins
 * than bars, interpolates when there are fewer. Pure; allocation-free.
 */
export function binsToBars(bins: Float32Array, binCount: number, barCount: number, out: Float32Array): void {
  if (binCount <= 0) {
    out.fill(0, 0, barCount);
    return;
  }
  if (barCount <= binCount) {
    for (let i = 0; i < barCount; i++) {
      const start = Math.floor((i * binCount) / barCount);
      const end = Math.max(start + 1, Math.floor(((i + 1) * binCount) / barCount));
      let sum = 0;
      for (let b = start; b < end; b++) sum += bins[b] ?? 0;
      out[i] = sum / (end - start);
    }
    return;
  }
  for (let i = 0; i < barCount; i++) {
    const x = Math.min(binCount - 1, Math.max(0, ((i + 0.5) * binCount) / barCount - 0.5));
    const i0 = Math.floor(x);
    const i1 = Math.min(binCount - 1, i0 + 1);
    const a = bins[i0] ?? 0;
    out[i] = a + ((bins[i1] ?? 0) - a) * (x - i0);
  }
}

const VERT = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_rect; // x0, y0, x1, y1 in canvas pixels, y down
uniform vec2 u_canvas;
out vec2 v_px;
flat out vec4 v_rect;
void main() {
  // One pixel of margin so the anti-aliased edge has room.
  vec2 p = mix(a_rect.xy - 1.0, a_rect.zw + 1.0, a_corner);
  v_px = p;
  v_rect = a_rect;
  gl_Position = vec4(p.x / u_canvas.x * 2.0 - 1.0, 1.0 - p.y / u_canvas.y * 2.0, 0.0, 1.0);
}
`;

const FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform vec4 u_fill; // linear, premultiplied
in vec2 v_px;
flat in vec4 v_rect;
out vec4 outColor;
void main() {
  // Analytic box coverage: exact, resolution-independent, no derivatives needed.
  float cx = clamp(min(v_px.x - v_rect.x, v_rect.z - v_px.x) + 0.5, 0.0, 1.0);
  float cy = clamp(min(v_px.y - v_rect.y, v_rect.w - v_px.y) + 0.5, 0.0, 1.0);
  outColor = u_fill * (cx * cy);
}
`;

function createBars(gl: WebGL2RenderingContext): ModuleInstance {
  const program = createProgram(gl, barsManifest.id, VERT, FRAG);
  const uCanvas = uniformLocation(gl, program, 'u_canvas');
  const uFill = uniformLocation(gl, program, 'u_fill');

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const cornerBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const rects = new Float32Array(MAX_BARS * 4);
  const rectBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, rectBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, rects.byteLength, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(1, 1);
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);

  // Per-frame scratch, allocated once (module-spec §7 rule 6).
  let spectrum = new Float32Array(0);
  const values = new Float32Array(MAX_BARS);

  return {
    resize() {},

    render(ctx, params) {
      const { width, height } = ctx.canvas;
      const stem = str(params, 'source') as Stem;
      const barCount = num(params, 'barCount');
      const source = ctx.analysis.sources.get(stem);

      if (source === undefined) {
        ctx.warn(`bars: no analysis for stem "${stem}"; drawing minimum heights`);
        values.fill(0, 0, barCount);
      } else {
        const track = source.spectrum;
        if (spectrum.length !== track.channels) spectrum = new Float32Array(track.channels);
        sampleTrackInto(track, ctx.audioSeconds, spectrum);
        binsToBars(spectrum, track.channels, barCount, values);
      }

      const spread = num(params, 'spread') * width;
      const left = (width - spread) / 2;
      const slot = spread / barCount;
      const barWidth = slot * num(params, 'barWidth');
      const baseline = num(params, 'baseline') * height;
      const minHeight = num(params, 'minHeight');
      const maxHeight = Math.max(minHeight, num(params, 'maxHeight'));
      for (let i = 0; i < barCount; i++) {
        const v = Math.min(1, Math.max(0, values[i] ?? 0));
        const h = (minHeight + v * (maxHeight - minHeight)) * height;
        const x0 = left + i * slot + (slot - barWidth) / 2;
        rects[i * 4] = x0;
        rects[i * 4 + 1] = baseline - h;
        rects[i * 4 + 2] = x0 + barWidth;
        rects[i * 4 + 3] = baseline;
      }

      const fill = toLinearPremultiplied(parseHexColor(str(params, 'fill')) ?? { r: 1, g: 0, b: 1, a: 1 });
      gl.useProgram(program);
      gl.uniform2f(uCanvas, width, height);
      gl.uniform4f(uFill, fill.r, fill.g, fill.b, fill.a);
      gl.bindBuffer(gl.ARRAY_BUFFER, rectBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, rects, 0, barCount * 4);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      gl.bindVertexArray(vao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, barCount);
      gl.bindVertexArray(null);
      gl.useProgram(null);
    },

    dispose() {
      gl.deleteBuffer(cornerBuffer);
      gl.deleteBuffer(rectBuffer);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(program);
    },
  };
}

export const barsModule: ModuleDefinition = { manifest: barsManifest, create: createBars };
