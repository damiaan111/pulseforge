// core.effect.dof — depth of field for 3D scene layers (M37, compositor-spec §7.3).
//
// Needs depth, so it declares `needsDepth` and the engine refuses it anywhere but a 3D scene layer
// (D18: depth is 3D-only). It is an engine effect rather than Three's post-processing, so it sits
// in the same chain as every other effect, previews and exports the same way, and can be followed
// by bloom or grain like anything else.
//
// A single gather pass. Each pixel's blur radius — its circle of confusion — comes from how far
// it is from the focus distance, and each pixel collects the taps of a fixed golden-angle spiral
// whose own circle is large enough to reach it. One rule keeps in-focus edges clean: a tap behind
// this pixel may blur no more than this pixel does, so a defocused background cannot bleed over a
// sharp subject standing in front of it. The spiral is fixed, so the result is deterministic.

import type { ModuleDefinition, ModuleInstance, ModuleManifest } from '../core/module.ts';
import { num } from '../core/params.ts';
import { singlePassEffect } from './effect-base.ts';

export const dofManifest: ModuleManifest = {
  id: 'core.effect.dof',
  version: '0.1.0',
  kind: 'effect',
  name: 'Depth of field',
  description: 'Focus on one distance in a 3D scene and blur what is nearer and further',
  category: 'lens',
  tags: ['dof', 'focus', 'bokeh', 'lens', '3d', 'cinematic'],
  capabilities: {
    needsAnalysis: false, needsInput: true, supportsAspect: true, stateful: false, gpuCost: 'medium',
    expandsBounds: true, needsDepth: true,
  },
  paramsSchemaVersion: 1,
  params: [
    { key: 'focus', label: 'Focus distance', group: 'Focus', type: 'float', default: 5, min: 0.1, max: 150, softMax: 40, unit: 'units', description: 'Distance from the camera that is sharp' },
    { key: 'range', label: 'Sharp range', group: 'Focus', type: 'float', default: 0.6, min: 0, max: 50, softMax: 10, unit: 'units', description: 'How far either side of the focus stays sharp' },
    { key: 'amount', label: 'Blur', group: 'Focus', type: 'float', default: 0.5, min: 0, max: 1, description: 'Largest blur, as the lens opens up' },
  ],
};

const TAPS = 48;
/** Draft (S18): the same golden-angle spiral over the same disc, sparser — grainier, never wider. */
const DRAFT_TAPS = 16;

const fragWith = (TAPS: number) => /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform sampler2D u_depth;
uniform bool u_hasDepth;
uniform float u_near;
uniform float u_far;
uniform float u_focus;
uniform float u_range;
uniform float u_maxRadius;   // pixels
out vec4 outColor;

float distanceAt(ivec2 p) {
  float d = texelFetch(u_depth, p, 0).r;
  float z = d * 2.0 - 1.0;
  return 2.0 * u_near * u_far / (u_far + u_near - z * (u_far - u_near));
}

float cocFor(float dist) {
  float off = max(abs(dist - u_focus) - u_range, 0.0);
  return clamp(off / max(u_focus, 1e-3), 0.0, 1.0) * u_maxRadius;
}

void main() {
  ivec2 size = textureSize(u_input, 0);
  ivec2 here = ivec2(gl_FragCoord.xy);
  vec4 centre = texelFetch(u_input, here, 0);
  if (!u_hasDepth || u_maxRadius < 0.5) { outColor = centre; return; }

  float dist = distanceAt(here);
  float coc = cocFor(dist);
  vec4 sum = centre;
  float weight = 1.0;
  const float GOLDEN = 2.39996323;
  for (int i = 0; i < ${TAPS}; i++) {
    float r = sqrt((float(i) + 0.5) / ${TAPS}.0) * u_maxRadius;
    float a = float(i) * GOLDEN;
    vec2 offset = vec2(cos(a), sin(a)) * r;
    ivec2 p = clamp(here + ivec2(round(offset)), ivec2(0), size - 1);
    float tapDist = distanceAt(p);
    float tapCoc = cocFor(tapDist);
    // Behind this pixel: it may not blur further than this pixel does (no halo over the subject).
    if (tapDist > dist) tapCoc = min(tapCoc, coc);
    float w = clamp(tapCoc - r + 1.0, 0.0, 1.0);
    // Premultiplied colours average correctly, alpha included.
    sum += texture(u_input, (gl_FragCoord.xy + offset) / vec2(size)) * w;
    weight += w;
  }
  outColor = sum / weight;
}
`;

const dofOptions: Parameters<typeof singlePassEffect>[2] = {
  uniforms: ['u_depth', 'u_hasDepth', 'u_near', 'u_far', 'u_focus', 'u_range', 'u_maxRadius'],
  filter: 'linear',
  set(gl, u, ctx, params) {
    const depth = ctx.depth;
    gl.uniform1i(u('u_hasDepth'), depth === null ? 0 : 1);
    if (depth !== null) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, depth.texture);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1i(u('u_depth'), 1);
      gl.uniform1f(u('u_near'), depth.near);
      gl.uniform1f(u('u_far'), depth.far);
    }
    gl.uniform1f(u('u_focus'), num(params, 'focus'));
    gl.uniform1f(u('u_range'), num(params, 'range'));
    // The largest blur follows the layer's size reference, so it matches at 1080p and 4K.
    gl.uniform1f(u('u_maxRadius'), num(params, 'amount') * 0.035 * ctx.canvas.referenceScale);
  },
};

const finalDof = singlePassEffect(dofManifest, fragWith(TAPS), dofOptions);
const draftDof = singlePassEffect(dofManifest, fragWith(DRAFT_TAPS), dofOptions);

/** Depth of field: the full 48-tap kernel, or in draft (S18) the 16-tap one, chosen per frame. */
export const dofModule: ModuleDefinition = {
  manifest: dofManifest,
  create(gl) {
    const full = finalDof.create(gl);
    let draft: ModuleInstance | null = null;
    return {
      resize(width, height) {
        full.resize(width, height);
        draft?.resize(width, height);
      },
      render(ctx, params) {
        if (ctx.quality !== 'draft') return full.render(ctx, params);
        draft ??= draftDof.create(gl);
        return draft.render(ctx, params);
      },
      dispose() {
        full.dispose();
        draft?.dispose();
      },
    };
  },
};
