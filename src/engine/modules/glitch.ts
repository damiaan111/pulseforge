// core.effect.glitch — digital tearing: displaced bands, channel shift, dropped blocks.
//
// The effect that most obviously *should* be random and most obviously must not be. Everything
// here is a hash of the band index and the frame index, so the glitch on frame 412 is the same
// glitch every time that frame is rendered — which is what lets it be cut to a beat, exported
// twice, and compared byte for byte (CLAUDE.md constraint 1).
//
// `interval` is what makes it usable rather than a novelty: glitching on every frame is noise,
// and glitching in bursts is a cut. The burst schedule is derived from the timeline time, so it
// survives seeking exactly like everything else.

import { EFFECT_GLSL, frameSeed, singlePassEffect } from './effect-base.ts';
import type { ModuleManifest } from '../core/module.ts';
import { num } from '../core/params.ts';

export const glitchManifest: ModuleManifest = {
  id: 'core.effect.glitch',
  version: '0.1.0',
  kind: 'effect',
  name: 'Glitch',
  description: 'Displaced bands, channel shift and dropouts, in deterministic bursts',
  category: 'lens',
  tags: ['glitch', 'datamosh', 'tear', 'vhs', 'digital'],
  capabilities: { needsAnalysis: false, needsInput: true, supportsAspect: true, stateful: false, gpuCost: 'low', expandsBounds: false },
  paramsSchemaVersion: 1,
  params: [
    { key: 'amount', label: 'Amount', group: 'Glitch', type: 'float', default: 0.5, min: 0, max: 1, description: 'Overall strength; 0 passes the frame through untouched' },
    { key: 'bands', label: 'Bands', group: 'Glitch', type: 'int', default: 24, min: 2, max: 200, description: 'Horizontal slices the frame can tear along' },
    { key: 'displace', label: 'Displacement', group: 'Glitch', type: 'float', default: 0.06, min: 0, max: 0.5, space: 'fraction', description: 'How far a torn band slides' },
    { key: 'density', label: 'Density', group: 'Glitch', type: 'float', default: 0.3, min: 0, max: 1, description: 'Fraction of bands affected at full strength' },
    { key: 'channelShift', label: 'Channel shift', group: 'Glitch', type: 'float', default: 0.5, min: 0, max: 2, description: 'Red/blue separation inside a torn band' },
    { key: 'dropout', label: 'Dropout', group: 'Glitch', type: 'float', default: 0.15, min: 0, max: 1, description: 'Chance a band goes black instead of sliding' },
    // Bursts, not a constant state: a glitch that never stops stops reading as a glitch.
    { key: 'interval', label: 'Burst every', group: 'Timing', type: 'float', default: 0, min: 0, max: 60, unit: 's', description: '0 glitches continuously' },
    { key: 'burst', label: 'Burst length', group: 'Timing', type: 'float', default: 0.12, min: 0.01, max: 5, unit: 's', description: 'Ignored when the interval is 0' },
  ],
};

const FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_input;
uniform float u_bands;
uniform float u_displace;     // fraction of the width
uniform float u_density;
uniform float u_channelShift;
uniform float u_dropout;
uniform float u_amount;       // already includes the burst gate
uniform uint u_seed;
out vec4 outColor;
${EFFECT_GLSL}

void main() {
  vec2 uv = v_uv;
  if (u_amount <= 0.0) {
    outColor = texelFetch(u_input, ivec2(gl_FragCoord.xy), 0);
    return;
  }

  int band = int(floor(uv.y * u_bands));
  // Each band draws three independent values: whether it tears, how far, and whether it drops.
  float select = pf_noise(ivec2(band, 0), u_seed);
  float slide = pf_noise(ivec2(band, 1), u_seed) * 2.0 - 1.0;
  float drop = pf_noise(ivec2(band, 2), u_seed);

  // Deliberately not named active: that is a reserved word in GLSL ES.
  float torn = step(select, u_density * u_amount);
  float shift = slide * u_displace * u_amount * torn;
  vec2 shifted = vec2(fract(uv.x + shift), uv.y);

  vec4 src = texture(u_input, shifted);
  if (u_channelShift > 0.0) {
    float separation = shift * u_channelShift * 0.35;
    vec4 r = texture(u_input, vec2(fract(shifted.x + separation), shifted.y));
    vec4 b = texture(u_input, vec2(fract(shifted.x - separation), shifted.y));
    src = vec4(r.r, src.g, b.b, src.a);
  }

  // A dropped band is black but keeps its alpha: it is a hole in the picture, not a hole in
  // the layer, so what is underneath does not show through.
  float dropped = torn * step(drop, u_dropout * u_amount);
  outColor = mix(src, vec4(0.0, 0.0, 0.0, src.a), dropped);
}
`;

export const glitchModule = singlePassEffect(glitchManifest, FRAG, {
  filter: 'linear',
  uniforms: ['u_bands', 'u_displace', 'u_density', 'u_channelShift', 'u_dropout', 'u_amount', 'u_seed'],
  set(gl, u, ctx, params) {
    const interval = num(params, 'interval');
    const burst = num(params, 'burst');
    // The gate is a function of t, so scrubbing to a frame inside a burst shows the burst.
    const inBurst = interval <= 0 || (ctx.time.t >= 0 && ctx.time.t % interval < burst);
    gl.uniform1f(u('u_bands'), Math.max(2, Math.round(num(params, 'bands'))));
    gl.uniform1f(u('u_displace'), num(params, 'displace'));
    gl.uniform1f(u('u_density'), num(params, 'density'));
    gl.uniform1f(u('u_channelShift'), num(params, 'channelShift'));
    gl.uniform1f(u('u_dropout'), num(params, 'dropout'));
    gl.uniform1f(u('u_amount'), inBurst ? num(params, 'amount') : 0);
    // A different salt from the grain's, or the two patterns march in step.
    gl.uniform1ui(u('u_seed'), frameSeed(ctx, 11));
  },
});
