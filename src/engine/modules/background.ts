// core.source.background — solid, gradient or image backdrop (M14, PROJECT.md §8.2).
//
// Three things matter more than they look:
//
//  - **Gradients interpolate in linear light.** compositor-spec §2 is explicit that gradients are
//    wrong in sRGB space. The colours are authored in sRGB and converted once, here.
//  - **Images are sampled from an sRGB texture** (render/images.ts), so they arrive linear and
//    are only premultiplied after that. Premultiplying the encoded values would darken every soft
//    edge of a PNG with transparency.
//  - **Movement is a closed form in `t`** — the Ken Burns zoom and drift are sines of time, never
//    an accumulated position, so scrubbing to 3:12 shows what playing to 3:12 shows. Audio-driven
//    movement comes from modulating `zoom` (M13), not from anything built in here.
//
// A missing image is reported and drawn as a dark checkerboard: visibly wrong, not black, so a
// relink problem cannot pass for a deliberate choice (CLAUDE.md constraint 4).

import { parseHexColor, srgbToLinear } from '../core/color.ts';
import type { ModuleDefinition, ModuleInstance, ModuleManifest } from '../core/module.ts';
import { num, str } from '../core/params.ts';
import { FULLSCREEN_VERT, createProgram, drawFullscreenTriangle, uniformLocation } from '../render/gl.ts';

export const backgroundManifest: ModuleManifest = {
  id: 'core.source.background',
  version: '0.1.0',
  kind: 'source',
  name: 'Background',
  description: 'Solid colour, gradient or image, with fit modes and a slow Ken Burns drift',
  category: 'background',
  tags: ['background', 'image', 'gradient', 'solid'],
  capabilities: { needsAnalysis: false, needsInput: false, supportsAspect: true, stateful: false, gpuCost: 'low' },
  paramsSchemaVersion: 1,
  params: [
    {
      key: 'mode', label: 'Type', group: 'Background', type: 'enum', default: 'gradient',
      options: [{ value: 'solid', label: 'Solid' }, { value: 'gradient', label: 'Gradient' }, { value: 'image', label: 'Image' }],
    },
    { key: 'colorA', label: 'Colour', group: 'Background', type: 'color', default: '#0b0614', paletteRole: 'background' },
    { key: 'colorB', label: 'Second colour', group: 'Background', type: 'color', default: '#2a0845', visibleWhen: { param: 'mode', equals: 'gradient' } },
    {
      key: 'gradient', label: 'Gradient', group: 'Background', type: 'enum', default: 'linear', visibleWhen: { param: 'mode', equals: 'gradient' },
      options: [{ value: 'linear', label: 'Linear' }, { value: 'radial', label: 'Radial' }],
    },
    { key: 'angle', label: 'Angle', group: 'Background', type: 'float', default: 90, min: 0, max: 360, unit: '°', visibleWhen: { param: 'gradient', equals: 'linear' } },

    { key: 'image', label: 'Image', group: 'Image', type: 'asset', accept: 'image', default: '', visibleWhen: { param: 'mode', equals: 'image' } },
    {
      key: 'fit', label: 'Fit', group: 'Image', type: 'enum', default: 'cover', visibleWhen: { param: 'mode', equals: 'image' },
      options: [
        { value: 'cover', label: 'Cover' }, { value: 'contain', label: 'Contain' },
        { value: 'stretch', label: 'Stretch' }, { value: 'tile', label: 'Tile' },
      ],
    },
    { key: 'dim', label: 'Dim', group: 'Image', type: 'float', default: 0, min: 0, max: 1, visibleWhen: { param: 'mode', equals: 'image' }, description: 'Darkens the image — for legibility of what sits on top' },

    { key: 'zoom', label: 'Zoom', group: 'Motion', type: 'float', default: 1, min: 1, max: 4, softMax: 2, unit: '×', aspectOverridable: true, modulatable: true },
    { key: 'drift', label: 'Drift', group: 'Motion', type: 'float', default: 0, min: 0, max: 1, description: 'Ken Burns: a slow pan and breathing zoom. Never reveals the image edge in cover mode' },
    { key: 'driftSeconds', label: 'Drift period', group: 'Motion', type: 'float', default: 30, min: 4, max: 240, unit: 's', advanced: true },
  ],
};

const MODES = { solid: 0, gradient: 1, image: 2 } as const;
const FITS = { cover: 0, contain: 1, stretch: 2, tile: 3 } as const;

/**
 * Ken Burns framing at time t, closed form. `scale` magnifies about the centre and `offset` shifts
 * the sampled window. The base magnification grows with the drift amount exactly enough that the
 * largest offset never reveals the image edge in cover mode: the visible half-width is 0.5/scale,
 * and 0.5/scale + |offset| ≤ 0.5 whenever scale ≥ 1 / (1 − 2·maxOffset).
 */
export function kenBurns(t: number, zoom: number, drift: number, periodSeconds: number): { scale: number; offsetX: number; offsetY: number } {
  const maxOffset = 0.03 * drift;
  const phase = (2 * Math.PI * t) / periodSeconds;
  const breathe = 1 + 0.04 * drift * (0.5 - 0.5 * Math.cos(phase));
  return {
    scale: (zoom / (1 - 2 * maxOffset)) * breathe,
    // Incommensurate periods, so the path does not trace the same ellipse every cycle.
    offsetX: maxOffset * Math.sin(phase),
    offsetY: maxOffset * Math.sin(phase * 0.731 + 1.3),
  };
}

const FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 u_canvas;
uniform int u_mode;
uniform vec3 u_colorA; // linear
uniform vec3 u_colorB; // linear
uniform int u_gradient; // 0 linear, 1 radial
uniform float u_angle;  // radians, 0 = left to right, clockwise
uniform sampler2D u_image;
uniform vec2 u_imageSize;
uniform int u_fit;
uniform float u_dim;
uniform vec3 u_frame; // scale, offsetX, offsetY
uniform bool u_missing;
out vec4 outColor;

void main() {
  vec2 p = vec2(gl_FragCoord.x, u_canvas.y - gl_FragCoord.y) / u_canvas; // 0..1, y down
  float aspect = u_canvas.x / u_canvas.y;
  vec2 q = (p - 0.5) / u_frame.x + 0.5 - u_frame.yz; // zoom about the centre, then drift

  if (u_mode == 0) {
    outColor = vec4(u_colorA, 1.0);
    return;
  }

  if (u_mode == 1) {
    vec2 c = (q - 0.5) * vec2(aspect, 1.0); // measured in canvas heights, so angles are true angles
    float t;
    if (u_gradient == 0) {
      vec2 d = vec2(cos(u_angle), sin(u_angle));
      // Half the frame's extent along d, so the colours reach exactly corner to corner.
      float extent = abs(d.x) * aspect * 0.5 + abs(d.y) * 0.5;
      t = dot(c, d) / (2.0 * extent) + 0.5;
    } else {
      t = length(c) / (0.5 * length(vec2(aspect, 1.0)));
    }
    outColor = vec4(mix(u_colorA, u_colorB, clamp(t, 0.0, 1.0)), 1.0);
    return;
  }

  if (u_missing) {
    vec2 cell = floor(p * vec2(aspect, 1.0) * 12.0);
    float checker = mod(cell.x + cell.y, 2.0);
    outColor = vec4(mix(vec3(0.02), vec3(0.06), checker), 1.0);
    return;
  }

  float imageAspect = u_imageSize.x / u_imageSize.y;
  vec2 uv = q;
  if (u_fit == 0) {      // cover: fill, crop the overflow
    if (aspect > imageAspect) uv.y = (q.y - 0.5) * imageAspect / aspect + 0.5;
    else uv.x = (q.x - 0.5) * aspect / imageAspect + 0.5;
  } else if (u_fit == 1) { // contain: whole image, bars filled with the colour
    if (aspect > imageAspect) uv.x = (q.x - 0.5) * aspect / imageAspect + 0.5;
    else uv.y = (q.y - 0.5) * imageAspect / aspect + 0.5;
  } else if (u_fit == 3) { // tile at the image's own proportions, one tile per canvas height
    uv = vec2((q.x - 0.5) * aspect / imageAspect, q.y - 0.5);
  }

  // Sample outside any per-pixel branch: implicit derivatives (and so mip selection) are undefined
  // inside non-uniform control flow in GLSL ES 3.00.
  vec4 texel = texture(u_image, uv);
  bool outside = u_fit != 3 && (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0);
  vec3 rgb = texel.rgb * (1.0 - u_dim);
  vec4 image = vec4(rgb * texel.a, texel.a); // premultiply after linearising
  // Contain bars and transparent image areas show the base colour underneath.
  vec4 base = vec4(u_colorA, 1.0);
  outColor = outside ? base : image + base * (1.0 - image.a);
}
`;

function createBackground(gl: WebGL2RenderingContext): ModuleInstance {
  const program = createProgram(gl, backgroundManifest.id, FULLSCREEN_VERT, FRAG);
  const u = (name: string) => uniformLocation(gl, program, name);
  const uniforms = {
    canvas: u('u_canvas'), mode: u('u_mode'), colorA: u('u_colorA'), colorB: u('u_colorB'),
    gradient: u('u_gradient'), angle: u('u_angle'), image: u('u_image'), imageSize: u('u_imageSize'),
    fit: u('u_fit'), dim: u('u_dim'), frame: u('u_frame'), missing: u('u_missing'),
  };
  const vao = gl.createVertexArray();
  // A 1×1 texture bound when there is no image, so the sampler is never incomplete.
  const blank = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, blank);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
  gl.bindTexture(gl.TEXTURE_2D, null);

  const linear = (hex: string, fallback: string): [number, number, number] => {
    const c = parseHexColor(hex) ?? parseHexColor(fallback) ?? { r: 0, g: 0, b: 0, a: 1 };
    return [srgbToLinear(c.r), srgbToLinear(c.g), srgbToLinear(c.b)];
  };

  return {
    resize() {},

    render(ctx, params) {
      const mode = MODES[str(params, 'mode') as keyof typeof MODES] ?? MODES.gradient;
      const fit = FITS[str(params, 'fit') as keyof typeof FITS] ?? FITS.cover;
      const frame = kenBurns(ctx.time.t, num(params, 'zoom'), num(params, 'drift'), num(params, 'driftSeconds'));

      let texture: WebGLTexture = blank;
      let size = [1, 1];
      let missing = false;
      if (mode === MODES.image) {
        const assetId = str(params, 'image');
        const image = assetId === '' ? undefined : ctx.image(assetId);
        if (image === undefined) {
          missing = true;
          ctx.warn(assetId === ''
            ? 'background: image mode with no image chosen'
            : `background: image asset "${assetId}" is not available (missing file or not in the project)`);
        } else {
          texture = image.texture;
          size = [image.width, image.height];
        }
      }

      const a = linear(str(params, 'colorA'), '#0b0614');
      const b = linear(str(params, 'colorB'), '#2a0845');
      gl.disable(gl.BLEND);
      gl.useProgram(program);
      gl.uniform2f(uniforms.canvas, ctx.canvas.width, ctx.canvas.height);
      gl.uniform1i(uniforms.mode, mode);
      gl.uniform3f(uniforms.colorA, a[0], a[1], a[2]);
      gl.uniform3f(uniforms.colorB, b[0], b[1], b[2]);
      gl.uniform1i(uniforms.gradient, str(params, 'gradient') === 'radial' ? 1 : 0);
      gl.uniform1f(uniforms.angle, (num(params, 'angle') * Math.PI) / 180);
      gl.uniform1i(uniforms.fit, fit);
      gl.uniform1f(uniforms.dim, num(params, 'dim'));
      gl.uniform3f(uniforms.frame, frame.scale, frame.offsetX, frame.offsetY);
      gl.uniform1i(uniforms.missing, missing ? 1 : 0);
      gl.uniform2f(uniforms.imageSize, size[0] ?? 1, size[1] ?? 1);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      // The texture may be shared with another layer, so wrap is set for this draw every time.
      const wrap = fit === FITS.tile ? gl.REPEAT : gl.CLAMP_TO_EDGE;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
      gl.uniform1i(uniforms.image, 0);
      drawFullscreenTriangle(gl, vao);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.useProgram(null);
    },

    dispose() {
      gl.deleteTexture(blank);
      gl.deleteProgram(program);
      gl.deleteVertexArray(vao);
    },
  };
}

export const backgroundModule: ModuleDefinition = { manifest: backgroundManifest, create: createBackground };
