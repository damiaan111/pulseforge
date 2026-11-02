// core.visualizer.spectrogram — the spectrum over time, scrolling.
//
// This module exists partly to make a point. A live visualiser can only scroll a spectrogram by
// *keeping a history buffer* — which is state, which breaks seeking and therefore determinism
// (module-spec §7 rule 3). Here the whole analysis is precomputed and random-access in time, so
// each column simply reads the spectrum at `t - offset`. No history, no state, and scrubbing
// backwards shows exactly what playing forwards showed.
//
// Two looks from one shader: a heat map, or a ridge plot ("terrain"), because they are the same
// data with a different mapping and splitting them into two modules would duplicate everything.

import { sampleTrackInto } from '../core/analysis.ts';
import { fillColour } from './analysis-texture.ts';
import type { ModuleDefinition, ModuleInstance, ModuleManifest } from '../core/module.ts';
import { num, str, type Stem } from '../core/params.ts';
import { FULLSCREEN_VERT, createProgram, drawFullscreenTriangle, uniformLocation } from '../render/gl.ts';

/** Columns of history uploaded per frame. Enough to look continuous, cheap enough to rebuild. */
const COLUMNS = 128;

export const spectrogramManifest: ModuleManifest = {
  id: 'core.visualizer.spectrogram',
  version: '0.1.0',
  kind: 'visualizer',
  name: 'Spectrogram',
  description: 'The spectrum over time, as a heat map or scrolling ridges',
  category: 'spectrum',
  tags: ['spectrogram', 'terrain', 'history', 'scroll'],
  capabilities: { needsAnalysis: true, needsInput: false, supportsAspect: true, stateful: false, gpuCost: 'medium' },
  paramsSchemaVersion: 1,
  params: [
    { key: 'source', label: 'Source', group: 'Source', type: 'select:stem', default: 'mix' },
    { key: 'window', label: 'Window', group: 'Source', type: 'float', default: 4, min: 0.25, max: 20, unit: 's', scale: 'log', description: 'How much history is on screen' },
    {
      key: 'style', label: 'Style', group: 'Shape', type: 'enum', default: 'heat',
      options: [{ value: 'heat', label: 'Heat map' }, { value: 'ridges', label: 'Ridges' }],
    },
    { key: 'ridgeCount', label: 'Ridges', group: 'Shape', type: 'int', default: 24, min: 4, max: 64, visibleWhen: { param: 'style', equals: 'ridges' } },
    { key: 'ridgeHeight', label: 'Ridge height', group: 'Shape', type: 'float', default: 0.06, min: 0.005, max: 0.3, space: 'fraction', visibleWhen: { param: 'style', equals: 'ridges' } },
    { key: 'gain', label: 'Gain', group: 'Appearance', type: 'float', default: 1, min: 0.1, max: 4, softMax: 2, scale: 'log' },
    { key: 'fill', label: 'Colour', group: 'Appearance', type: 'color', default: '#00e5ff', paletteRole: 'secondary' },
    { key: 'background', label: 'Floor', group: 'Appearance', type: 'float', default: 0, min: 0, max: 1, description: 'Opacity where there is no energy' },
  ],
};

const FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_history;   // x = time (0 = oldest), y = frequency bin
uniform ivec2 u_size;
uniform vec2 u_canvas;
uniform int u_style;           // 0 heat, 1 ridges
uniform int u_ridgeCount;
uniform float u_ridgeHeight;
uniform float u_gain;
uniform vec4 u_fill;
uniform float u_background;
out vec4 outColor;

float sampleHistory(int column, int bin) {
  return texelFetch(u_history, ivec2(clamp(column, 0, u_size.x - 1), clamp(bin, 0, u_size.y - 1)), 0).r;
}

void main() {
  vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y); // y down
  if (u_style == 0) {
    int column = int(uv.x * float(u_size.x));
    // Low frequencies at the bottom, which is the convention everywhere else.
    int bin = int((1.0 - uv.y) * float(u_size.y));
    float value = clamp(sampleHistory(column, bin) * u_gain, 0.0, 1.0);
    outColor = u_fill * max(value, u_background);
    return;
  }

  // Ridges: one line per band, offset down the canvas, nearer bands drawn over farther ones.
  float best = 0.0;
  for (int r = 0; r < 64; r++) {
    if (r >= u_ridgeCount) break;
    float bandPosition = float(r) / float(max(u_ridgeCount - 1, 1));
    int bin = int(bandPosition * float(u_size.y - 1));
    int column = int(uv.x * float(u_size.x));
    float value = clamp(sampleHistory(column, bin) * u_gain, 0.0, 1.0);

    float baseline = mix(0.85, 0.2, bandPosition);
    float y = baseline - value * u_ridgeHeight;
    float thickness = 1.5 / u_canvas.y;
    float line = 1.0 - smoothstep(thickness, thickness * 2.5, abs(uv.y - y));
    best = max(best, line);
  }
  outColor = u_fill * max(best, u_background);
}
`;

function createSpectrogram(gl: WebGL2RenderingContext): ModuleInstance {
  const program = createProgram(gl, spectrogramManifest.id, FULLSCREEN_VERT, FRAG);
  const u = {
    history: uniformLocation(gl, program, 'u_history'),
    size: uniformLocation(gl, program, 'u_size'),
    canvas: uniformLocation(gl, program, 'u_canvas'),
    style: uniformLocation(gl, program, 'u_style'),
    ridgeCount: uniformLocation(gl, program, 'u_ridgeCount'),
    ridgeHeight: uniformLocation(gl, program, 'u_ridgeHeight'),
    gain: uniformLocation(gl, program, 'u_gain'),
    fill: uniformLocation(gl, program, 'u_fill'),
    background: uniformLocation(gl, program, 'u_background'),
  };
  const vao = gl.createVertexArray();
  const texture = gl.createTexture();
  let bins = 0;
  let history = new Float32Array(0);
  let column = new Float32Array(0);

  return {
    resize() {},
    render(ctx, params) {
      const stem = str(params, 'source') as Stem;
      const source = ctx.analysis.sources.get(stem);
      if (source === undefined) {
        ctx.warn(`spectrogram: no analysis for stem "${stem}"; nothing to draw`);
        return;
      }
      const track = source.spectrum;
      const channels = Math.max(1, track.channels);
      if (bins !== channels) {
        bins = channels;
        history = new Float32Array(COLUMNS * channels);
        column = new Float32Array(channels);
      }

      // Rebuilt from scratch every frame by reading the past — which is exactly what makes this
      // module stateless and seek-safe. The cost is COLUMNS interpolated reads, not a buffer
      // that has to be replayed from t=0 after every scrub.
      const windowSeconds = num(params, 'window');
      for (let c = 0; c < COLUMNS; c += 1) {
        const age = (1 - c / (COLUMNS - 1)) * windowSeconds;
        sampleTrackInto(track, ctx.audioSeconds - age, column);
        // Texture is (time, bin), so a whole column is a strided write.
        for (let b = 0; b < channels; b += 1) history[b * COLUMNS + c] = column[b] ?? 0;
      }

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, COLUMNS, channels, 0, gl.RED, gl.FLOAT, history);

      const colour = fillColour(str(params, 'fill'));
      gl.useProgram(program);
      gl.uniform1i(u.history, 0);
      gl.uniform2i(u.size, COLUMNS, channels);
      gl.uniform2f(u.canvas, ctx.canvas.width, ctx.canvas.height);
      gl.uniform1i(u.style, str(params, 'style') === 'ridges' ? 1 : 0);
      gl.uniform1i(u.ridgeCount, Math.round(num(params, 'ridgeCount')));
      gl.uniform1f(u.ridgeHeight, num(params, 'ridgeHeight'));
      gl.uniform1f(u.gain, num(params, 'gain'));
      gl.uniform4f(u.fill, colour.r, colour.g, colour.b, colour.a);
      gl.uniform1f(u.background, num(params, 'background'));
      drawFullscreenTriangle(gl, vao);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.useProgram(null);
    },
    dispose() {
      gl.deleteTexture(texture);
      gl.deleteProgram(program);
      gl.deleteVertexArray(vao);
    },
  };
}

export const spectrogramModule: ModuleDefinition = { manifest: spectrogramManifest, create: createSpectrogram };
