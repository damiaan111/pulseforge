// core.effect.grade — exposure, contrast, saturation and a colour cast.
//
// The effect that makes everything else look finished, and the one most easily got wrong: all of
// it happens in **linear light**, because a contrast curve applied to sRGB values crushes the
// shadows and a saturation applied to sRGB shifts hue. The compositor already works in linear
// (compositor-spec §2), so the only discipline needed here is not to leave it.
//
// Alpha is untouched throughout. The grade un-premultiplies, works on the colour, and
// premultiplies back — without that, every soft edge in the frame gets darker as contrast goes
// up, which reads as a halo nobody can find the source of.

import { EFFECT_GLSL, singlePassEffect } from './effect-base.ts';
import { parseHexColor, srgbToLinear } from '../core/color.ts';
import type { ModuleManifest } from '../core/module.ts';
import { num, str, type ParamValues } from '../core/params.ts';

export const gradeManifest: ModuleManifest = {
  id: 'core.effect.grade',
  version: '0.1.0',
  kind: 'effect',
  name: 'Colour grade',
  description: 'Exposure, contrast, saturation and a colour cast, in linear light',
  category: 'grade',
  tags: ['grade', 'colour', 'contrast', 'saturation', 'cinematic'],
  capabilities: { needsAnalysis: false, needsInput: true, supportsAspect: true, stateful: false, gpuCost: 'low', expandsBounds: false },
  paramsSchemaVersion: 1,
  params: [
    { key: 'exposure', label: 'Exposure', group: 'Tone', type: 'float', default: 0, min: -4, max: 4, softMin: -2, softMax: 2, unit: ' stops' },
    { key: 'contrast', label: 'Contrast', group: 'Tone', type: 'float', default: 1, min: 0, max: 3, softMax: 2, unit: '×' },
    { key: 'pivot', label: 'Pivot', group: 'Tone', type: 'float', default: 0.18, min: 0.01, max: 1, advanced: true, description: 'The tone contrast rotates around; 0.18 is mid grey' },
    { key: 'lift', label: 'Lift', group: 'Tone', type: 'float', default: 0, min: -0.25, max: 0.25, description: 'Raise or crush the blacks' },
    { key: 'saturation', label: 'Saturation', group: 'Colour', type: 'float', default: 1, min: 0, max: 3, softMax: 2, unit: '×' },
    { key: 'temperature', label: 'Temperature', group: 'Colour', type: 'float', default: 0, min: -1, max: 1, description: 'Cool to warm' },
    { key: 'tintAmount', label: 'Tint', group: 'Colour', type: 'float', default: 0, min: -1, max: 1, description: 'Green to magenta' },
    { key: 'tone', label: 'Tone', group: 'Colour', type: 'color', default: '#ffffff', description: 'Multiplied over the whole image' },
  ],
};

const FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_input;
uniform float u_exposure;      // linear gain, already 2^stops
uniform float u_contrast;
uniform float u_pivot;
uniform float u_lift;
uniform float u_saturation;
uniform vec3 u_cast;
out vec4 outColor;
${EFFECT_GLSL}

void main() {
  vec4 src = texelFetch(u_input, ivec2(gl_FragCoord.xy), 0);
  vec3 c = pf_unpremultiply(src);

  c *= u_exposure;
  c *= u_cast;

  // Contrast about a pivot, in linear light. max() keeps pow() away from negatives, which
  // RGBA16F can legitimately hold after an earlier effect.
  c = u_pivot * pow(max(c / u_pivot, 0.0), vec3(u_contrast));

  c += u_lift;
  c = mix(vec3(pf_luma(c)), c, u_saturation);

  // Nothing is clamped at the top: the compositor works in RGBA16F and the tone shoulder at
  // output (D48) is where highlights are handled. Clamping here would flatten a bloom.
  outColor = pf_premultiply(max(c, 0.0), src.a);
}
`;

export const gradeModule = singlePassEffect(gradeManifest, FRAG, {
  uniforms: ['u_exposure', 'u_contrast', 'u_pivot', 'u_lift', 'u_saturation', 'u_cast'],
  set(gl, u, _ctx, params) {
    gl.uniform1f(u('u_exposure'), Math.pow(2, num(params, 'exposure')));
    gl.uniform1f(u('u_contrast'), num(params, 'contrast'));
    gl.uniform1f(u('u_pivot'), num(params, 'pivot'));
    gl.uniform1f(u('u_lift'), num(params, 'lift'));
    gl.uniform1f(u('u_saturation'), num(params, 'saturation'));

    // Temperature and tint as simple channel gains, normalised so neither changes overall
    // brightness — a white balance control that dimmed the image would be a surprise.
    const temperature = num(params, 'temperature');
    const tint = num(params, 'tintAmount');
    const tone = parseTone(params);
    const cast: [number, number, number] = [
      tone[0] * (1 + temperature * 0.25) * (1 + tint * 0.1),
      tone[1] * (1 - Math.abs(temperature) * 0.05) * (1 - tint * 0.2),
      tone[2] * (1 - temperature * 0.25) * (1 + tint * 0.1),
    ];
    gl.uniform3f(u('u_cast'), cast[0], cast[1], cast[2]);
  },
});

/** The tone colour as a plain per-channel gain in linear light — not premultiplied: it is a
 * multiplier over the image, and its own alpha has no meaning here. */
function parseTone(params: ParamValues): [number, number, number] {
  const parsed = parseHexColor(str(params, 'tone'));
  if (parsed === undefined) return [1, 1, 1];
  return [srgbToLinear(parsed.r), srgbToLinear(parsed.g), srgbToLinear(parsed.b)];
}
