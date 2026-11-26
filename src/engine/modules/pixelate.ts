// core.effect.pixelate — blocks, or a dot-matrix panel.
//
// Two looks from one shader, because they are the same quantisation with a different cell
// shape: square blocks, or a round dot per cell on a dark background (the LED-panel look that
// reads well behind text).
//
// The block size is a fraction of `referenceScale`, not a pixel count: a 16-pixel block on a
// 1080p preview and the same 16 pixels at 4K are completely different pictures, and the preview
// is supposed to tell you what the export looks like (module-spec §6).

import { EFFECT_GLSL, singlePassEffect } from './effect-base.ts';
import type { ModuleManifest } from '../core/module.ts';
import { num } from '../core/params.ts';

export const pixelateManifest: ModuleManifest = {
  id: 'core.effect.pixelate',
  version: '0.1.0',
  kind: 'effect',
  name: 'Pixelate',
  description: 'Quantises the image into blocks, or a grid of dots',
  category: 'texture',
  tags: ['pixelate', 'mosaic', 'dots', 'led', 'retro'],
  capabilities: { needsAnalysis: false, needsInput: true, supportsAspect: true, stateful: false, gpuCost: 'low', expandsBounds: false },
  paramsSchemaVersion: 1,
  params: [
    { key: 'size', label: 'Block size', group: 'Blocks', type: 'float', default: 0.02, min: 0.002, max: 0.2, space: 'canvas', scale: 'log' },
    {
      key: 'shape', label: 'Shape', group: 'Blocks', type: 'enum', default: 'square',
      options: [{ value: 'square', label: 'Square' }, { value: 'dots', label: 'Dots' }],
    },
    { key: 'dotSize', label: 'Dot size', group: 'Blocks', type: 'float', default: 0.85, min: 0.1, max: 1, unit: '×', visibleWhen: { param: 'shape', equals: 'dots' } },
    { key: 'gap', label: 'Gap', group: 'Blocks', type: 'float', default: 0, min: 0, max: 0.8, unit: '×', visibleWhen: { param: 'shape', equals: 'square' } },
    { key: 'levels', label: 'Colour steps', group: 'Blocks', type: 'int', default: 0, min: 0, max: 32, advanced: true, description: 'Quantise each channel too; 0 leaves colour alone' },
    { key: 'mix', label: 'Mix', group: 'Blocks', type: 'float', default: 1, min: 0, max: 1 },
  ],
};

const FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_input;
uniform vec2 u_size;          // pixels
uniform vec2 u_canvas;
uniform int u_shape;          // 0 square, 1 dots
uniform float u_dotSize;
uniform float u_gap;
uniform int u_levels;
uniform float u_mix;
out vec4 outColor;
${EFFECT_GLSL}

void main() {
  vec2 pixel = gl_FragCoord.xy;
  vec2 cell = floor(pixel / u_size);
  vec2 within = fract(pixel / u_size);

  // The block takes the colour at its centre. Averaging the block would need a mip chain
  // and would only differ on very fine detail, which pixelation is throwing away anyway.
  vec2 centre = (cell + 0.5) * u_size;
  vec4 src = texelFetch(u_input, ivec2(clamp(centre, vec2(0.5), u_canvas - 0.5)), 0);
  vec3 c = pf_unpremultiply(src);
  float alpha = src.a;

  if (u_levels > 0) {
    float steps = float(u_levels);
    c = floor(clamp(c, 0.0, 1.0) * steps + 0.5) / steps;
  }

  float coverage = 1.0;
  if (u_shape == 1) {
    float d = length(within - 0.5) * 2.0;
    float aa = max(fwidth(d), 1e-4);
    coverage = 1.0 - smoothstep(u_dotSize - aa, u_dotSize + aa, d);
  } else if (u_gap > 0.0) {
    vec2 edge = abs(within - 0.5) * 2.0;
    float aa = max(fwidth(edge.x), 1e-4);
    coverage = (1.0 - smoothstep(1.0 - u_gap - aa, 1.0 - u_gap + aa, edge.x))
             * (1.0 - smoothstep(1.0 - u_gap - aa, 1.0 - u_gap + aa, edge.y));
  }

  vec4 blocked = pf_premultiply(c, alpha * coverage);
  vec4 original = texelFetch(u_input, ivec2(pixel), 0);
  outColor = mix(original, blocked, u_mix);
}
`;

export const pixelateModule = singlePassEffect(pixelateManifest, FRAG, {
  uniforms: ['u_size', 'u_canvas', 'u_shape', 'u_dotSize', 'u_gap', 'u_levels', 'u_mix'],
  set(gl, u, ctx, params) {
    // Never below one pixel: a sub-pixel block is a no-op that still costs a pass, and the
    // fract() below it degenerates.
    const size = Math.max(1, num(params, 'size') * ctx.canvas.referenceScale);
    gl.uniform2f(u('u_size'), size, size);
    gl.uniform2f(u('u_canvas'), ctx.canvas.width, ctx.canvas.height);
    gl.uniform1i(u('u_shape'), params['shape'] === 'dots' ? 1 : 0);
    gl.uniform1f(u('u_dotSize'), num(params, 'dotSize'));
    gl.uniform1f(u('u_gap'), num(params, 'gap'));
    gl.uniform1i(u('u_levels'), Math.round(num(params, 'levels')));
    gl.uniform1f(u('u_mix'), num(params, 'mix'));
  },
});
