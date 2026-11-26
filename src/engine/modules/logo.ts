// core.source.logo — a logo or watermark (M15, PROJECT.md §7).
//
// An image layer that keeps its aspect ratio, sits where the layer transform puts it, and can
// pulse on the beat. Deliberately not the background module with different defaults: a logo is
// placed and sized in canvas units and never stretched to fill, and its pulse reads the analysis
// directly, so "make it breathe with the kick" is one slider rather than a modulation binding —
// while still going through the same precomputed analysis, so it stays deterministic.
//
// The pulse scales about the image's own centre, so the layer transform (anchor, position) still
// decides where it sits: a logo pinned bottom-right grows in place instead of drifting.

import { parseHexColor, srgbToLinear } from '../core/color.ts';
import type { ModuleDefinition, ModuleInstance, ModuleManifest } from '../core/module.ts';
import { num, str, type Stem } from '../core/params.ts';
import { FULLSCREEN_VERT, createProgram, drawFullscreenTriangle, uniformLocation } from '../render/gl.ts';
import { AnalysisTexture } from './analysis-texture.ts';

export const logoManifest: ModuleManifest = {
  id: 'core.source.logo',
  version: '0.1.0',
  kind: 'source',
  name: 'Logo',
  description: 'An image at a fixed size, aspect preserved, with opacity, tint and a reactive pulse',
  category: 'branding',
  tags: ['logo', 'watermark', 'image', 'branding'],
  capabilities: { needsAnalysis: false, needsInput: false, supportsAspect: true, stateful: false, gpuCost: 'low' },
  paramsSchemaVersion: 1,
  params: [
    { key: 'image', label: 'Image', group: 'Logo', type: 'asset', accept: 'image', default: '' },
    { key: 'size', label: 'Size', group: 'Logo', type: 'float', default: 0.2, min: 0.02, max: 1, space: 'canvas', aspectOverridable: true, description: 'Width, as a fraction of the layer’s scale reference' },
    { key: 'opacity', label: 'Opacity', group: 'Logo', type: 'float', default: 1, min: 0, max: 1, modulatable: true },

    { key: 'tint', label: 'Tint', group: 'Colour', type: 'color', default: '#ffffff', paletteRole: 'primary' },
    { key: 'tintAmount', label: 'Tint amount', group: 'Colour', type: 'float', default: 0, min: 0, max: 1, modulatable: true, description: 'Blends the image towards the tint; 1 is a flat silhouette' },

    { key: 'pulse', label: 'Pulse', group: 'Pulse', type: 'float', default: 0, min: 0, max: 1, softMax: 0.5, modulatable: true, description: 'How much the audio grows the logo' },
    {
      key: 'drive', label: 'Driven by', group: 'Pulse', type: 'enum', default: 'beat',
      options: [{ value: 'beat', label: 'Beat' }, { value: 'onset', label: 'Onsets' }, { value: 'rms', label: 'Level' }, { value: 'peak', label: 'Peak' }],
    },
    { key: 'source', label: 'Source', group: 'Pulse', type: 'select:stem', default: 'mix' },
  ],
};

const FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 u_canvas;
uniform sampler2D u_image;
uniform vec2 u_size;      // the logo's drawn size in canvas px
uniform vec3 u_tint;      // linear
uniform float u_tintAmount;
uniform float u_opacity;
uniform bool u_missing;
out vec4 outColor;

void main() {
  vec2 p = vec2(gl_FragCoord.x, u_canvas.y - gl_FragCoord.y);
  vec2 centre = u_canvas * 0.5;
  vec2 uv = (p - centre) / u_size + 0.5;
  // Sampled unconditionally: mip selection inside non-uniform control flow is undefined.
  vec4 texel = texture(u_image, uv);
  bool outside = uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0;

  if (u_missing) {
    // A visible placeholder rather than nothing: an empty logo slot looks like a broken export.
    vec2 d = abs(p - centre) - u_size * 0.5;
    float edge = max(d.x, d.y);
    float frame = step(edge, 0.0) * step(-4.0, edge);
    outColor = vec4(vec3(0.6, 0.1, 0.1) * frame, frame) * u_opacity;
    return;
  }

  vec3 rgb = mix(texel.rgb, u_tint * max(texel.r, max(texel.g, texel.b)), u_tintAmount);
  float a = outside ? 0.0 : texel.a * u_opacity;
  outColor = vec4(rgb * a, a); // premultiply after linearising and tinting
}
`;

function createLogo(gl: WebGL2RenderingContext): ModuleInstance {
  const program = createProgram(gl, logoManifest.id, FULLSCREEN_VERT, FRAG);
  const u = {
    canvas: uniformLocation(gl, program, 'u_canvas'),
    image: uniformLocation(gl, program, 'u_image'),
    size: uniformLocation(gl, program, 'u_size'),
    tint: uniformLocation(gl, program, 'u_tint'),
    tintAmount: uniformLocation(gl, program, 'u_tintAmount'),
    opacity: uniformLocation(gl, program, 'u_opacity'),
    missing: uniformLocation(gl, program, 'u_missing'),
  };
  const vao = gl.createVertexArray();
  const analysis = new AnalysisTexture(gl);
  const blank = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, blank);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
  gl.bindTexture(gl.TEXTURE_2D, null);

  return {
    resize() {},

    render(ctx, params) {
      const assetId = str(params, 'image');
      const image = assetId === '' ? undefined : ctx.image(assetId);
      const missing = image === undefined;
      if (missing) {
        ctx.warn(assetId === ''
          ? 'logo: no image chosen'
          : `logo: image asset "${assetId}" is not available (missing file or not in the project)`);
      }

      const { features } = analysis.update(ctx, str(params, 'source') as Stem);
      const drive = str(params, 'drive');
      const level = drive === 'peak' ? features.peak
        : drive === 'onset' ? features.onset
          : drive === 'beat' ? features.beat
            : features.rms;
      // Half again at full pulse on a full-scale hit: enough to read as a beat, not a bounce.
      const scale = 1 + num(params, 'pulse') * level * 0.5;

      const width = num(params, 'size') * ctx.canvas.referenceScale * scale;
      const aspect = missing || image.height === 0 ? 1 : image.width / image.height;
      const height = width / aspect;

      const c = parseHexColor(str(params, 'tint')) ?? { r: 1, g: 1, b: 1, a: 1 };
      gl.disable(gl.BLEND);
      gl.useProgram(program);
      gl.uniform2f(u.canvas, ctx.canvas.width, ctx.canvas.height);
      gl.uniform2f(u.size, width, height);
      gl.uniform3f(u.tint, srgbToLinear(c.r), srgbToLinear(c.g), srgbToLinear(c.b));
      gl.uniform1f(u.tintAmount, num(params, 'tintAmount'));
      gl.uniform1f(u.opacity, num(params, 'opacity'));
      gl.uniform1i(u.missing, missing ? 1 : 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, missing ? blank : image.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.uniform1i(u.image, 0);
      drawFullscreenTriangle(gl, vao);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.useProgram(null);
    },

    dispose() {
      analysis.dispose();
      gl.deleteTexture(blank);
      gl.deleteProgram(program);
      gl.deleteVertexArray(vao);
    },
  };
}

export const logoModule: ModuleDefinition = { manifest: logoManifest, create: createLogo };
