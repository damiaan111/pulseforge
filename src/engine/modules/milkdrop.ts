// core.visualizer.milkdrop — a MilkDrop preset as a layer, rendered by Butterchurn through the host
// (core/milkdrop.ts). The module's own job is small: hand the host this frame's audio, then bring
// its picture into the frame in linear light, like any other layer.

import { MILKDROP_SAMPLES, type MilkdropHost } from '../core/milkdrop.ts';
import type { AnalysisTrack } from '../core/analysis.ts';
import type { ModuleDefinition, ModuleInstance, ModuleManifest, RenderContext } from '../core/module.ts';
import { num, str } from '../core/params.ts';
import { FULLSCREEN_VERT, createProgram, drawFullscreenTriangle, uniformLocation } from '../render/gl.ts';

export const MILKDROP_MODULE = 'core.visualizer.milkdrop';

export const milkdropManifest: ModuleManifest = {
  id: MILKDROP_MODULE,
  version: '0.1.0',
  kind: 'visualizer',
  name: 'MilkDrop',
  description: 'A MilkDrop preset, from the community library',
  category: 'visualizer',
  tags: ['milkdrop', 'psychedelic', 'community'],
  capabilities: { needsAnalysis: true, needsInput: false, supportsAspect: true, stateful: true, gpuCost: 'high' },
  paramsSchemaVersion: 1,
  params: [
    { key: 'preset', label: 'Preset', group: 'MilkDrop', type: 'string', default: '', picker: 'milkdrop', modulatable: false, description: 'Type to search the installed presets' },
    { key: 'seed', label: 'Variation', group: 'MilkDrop', type: 'int', default: 1, min: 1, max: 9999, modulatable: false, description: 'The same preset grown from a different start' },
    { key: 'brightness', label: 'Brightness', group: 'MilkDrop', type: 'float', default: 1, min: 0, max: 2, modulatable: true },
  ],
};

const FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_picture;
uniform vec2 u_canvas;
uniform float u_brightness;
out vec4 outColor;
vec3 toLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
void main() {
  // y down, as the canvas's first row is its top.
  vec2 uv = vec2(gl_FragCoord.x, u_canvas.y - gl_FragCoord.y) / u_canvas;
  outColor = vec4(toLinear(texture(u_picture, uv).rgb) * u_brightness, 1.0);
}
`;

/** The `MILKDROP_SAMPLES` samples up to `seconds`, as bytes; silence before the song and after it. */
export function waveformBytes(track: AnalysisTrack | undefined, seconds: number, out: Uint8Array): Uint8Array {
  const end = Math.floor(seconds * (track?.rate ?? 0));
  for (let i = 0; i < out.length; i += 1) {
    const sample = track?.data[end - MILKDROP_SAMPLES + i] ?? 0;
    out[i] = Math.max(0, Math.min(255, Math.round(128 + sample * 127)));
  }
  return out;
}

function createMilkdrop(gl: WebGL2RenderingContext): ModuleInstance {
  const program = createProgram(gl, 'core.visualizer.milkdrop', FULLSCREEN_VERT, FRAG);
  const uniforms = {
    picture: uniformLocation(gl, program, 'u_picture'),
    canvas: uniformLocation(gl, program, 'u_canvas'),
    brightness: uniformLocation(gl, program, 'u_brightness'),
  };
  const vao = gl.createVertexArray();
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  for (const [name, value] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]] as const) {
    gl.texParameteri(gl.TEXTURE_2D, name, value);
  }
  gl.bindTexture(gl.TEXTURE_2D, null);

  const owner = {};
  const scratch = new Uint8Array(MILKDROP_SAMPLES);
  let host: MilkdropHost | undefined;

  function picture(ctx: RenderContext, preset: string, seed: number): TexImageSource | null {
    if (ctx.milkdrop === undefined) {
      ctx.warn('MilkDrop needs a host that can run it; this render has none');
      return null;
    }
    host = ctx.milkdrop;
    if (preset === '') {
      ctx.warn('MilkDrop: no preset chosen. Pick one in the Presets panel, under MilkDrop');
      return null;
    }
    if (!ctx.milkdrop.hasPreset(preset)) {
      ctx.warn(`MilkDrop: preset "${preset}" is not installed. Add MilkDrop presets in Settings → Components`);
      return null;
    }
    const track = ctx.analysis.sources.get('mix')?.features.get('waveform');
    if (track === undefined) ctx.warn('MilkDrop: this analysis has no waveform, so the preset hears silence');
    const { fps } = ctx.time;
    const frameSeconds = fps.den / fps.num;
    // Timeline to audio is a fixed offset, so any frame's audio can be read while stepping to it.
    const offset = ctx.audioSeconds - ctx.time.t;
    return ctx.milkdrop.frame({
      owner,
      preset,
      seed,
      width: ctx.canvas.width,
      height: ctx.canvas.height,
      frameIndex: ctx.time.frameIndex,
      frameSeconds,
      exact: ctx.quality === 'final',
      samples: (frame) => waveformBytes(track, frame * frameSeconds + offset, scratch),
    });
  }

  return {
    resize() {},
    render(ctx, params) {
      const source = picture(ctx, str(params, 'preset'), Math.round(num(params, 'seed')));
      if (source === null) return;
      gl.useProgram(program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
      gl.uniform1i(uniforms.picture, 0);
      gl.uniform2f(uniforms.canvas, ctx.canvas.width, ctx.canvas.height);
      gl.uniform1f(uniforms.brightness, num(params, 'brightness'));
      drawFullscreenTriangle(gl, vao);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.useProgram(null);
    },
    dispose() {
      host?.release(owner);
      gl.deleteProgram(program);
      gl.deleteTexture(texture);
      gl.deleteVertexArray(vao);
    },
  };
}

export const milkdropModule: ModuleDefinition = { manifest: milkdropManifest, create: createMilkdrop };
