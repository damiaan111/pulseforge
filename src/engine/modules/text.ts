// core.text.title — a styled, animated text block (M16; PROJECT.md §8.7 styling, §8.13).
//
// Split in two, on purpose:
//  - **Glyphs** come from the host's `TextRasterizer` as coverage masks at output resolution (a
//    fill mask, an outline mask) plus per-line and per-word boxes. Rasterised once per distinct
//    request and cached on the layer, so a static title costs one upload, not one per frame.
//  - **Everything visual** is one shader over those masks: fill or vertical gradient (mixed in
//    linear light), outline, drop shadow, glow, background plate, and entry/exit animation. That
//    is why colour, glow and shadow can be modulated every frame for free while size cannot —
//    size changes the glyphs, so it re-rasterises (use the layer's scale to pulse text instead).
//
// Blur (shadow softness, glow, blur-in) samples the mask's mipmaps: `textureLod` a level finer than
// the radius, on a ring of taps. Cheap, smooth enough for a halo, and needs no derivatives, so it
// is safe in branches.
//
// Per-word animation (typewriter, stagger) multiplies the mask by each word's visibility in a first
// pass — a word-id map built from the rasteriser's word boxes and a one-row visibility texture
// updated per frame — then rebuilds the mipmaps, so blur never smears hidden words into streaks.
// The same id map is what the karaoke fill will use (lyrics-spec §4).
//
// A colour glyph is the one exception to "colour is a uniform": it brings a texture of its own, which
// replaces the fill colour under the same masks, so everything above still works on it.
//
// Missing fonts draw with the default font and **say so** (§8.13: reported, never silently
// substituted). A host without a rasteriser draws nothing and says so.

import type { ModuleDefinition, ModuleInstance, ModuleManifest, RenderContext } from '../core/module.ts';
import { num, str, type ParamValues } from '../core/params.ts';
import type { TextRaster, TextRequest } from '../core/text.ts';
import { FULLSCREEN_VERT, createProgram, drawFullscreenTriangle, uniformLocation } from '../render/gl.ts';
import {
  TEXT_SAMPLING_GLSL, bindTexture, clamp01, createWordMaskPass, linearHex, releaseTextRaster,
  unbindTextures, uploadTextRaster, type UploadedText,
} from './text-gpu.ts';

export const TEXT_ANIMATIONS = [
  { value: 'none', label: 'None' },
  { value: 'fade', label: 'Fade' },
  { value: 'slide-up', label: 'Slide up' },
  { value: 'slide-down', label: 'Slide down' },
  { value: 'scale', label: 'Scale' },
  { value: 'blur', label: 'Blur' },
  { value: 'typewriter', label: 'Typewriter (per word)' },
  { value: 'stagger', label: 'Stagger (per word)' },
] as const;

export type TextAnimation = (typeof TEXT_ANIMATIONS)[number]['value'];

export const textManifest: ModuleManifest = {
  id: 'core.text.title',
  version: '0.1.0',
  kind: 'text',
  name: 'Text',
  description: 'A title or credit: font, size, spacing, fill or gradient, outline, shadow, glow, plate, entry and exit animation',
  category: 'text',
  tags: ['text', 'title', 'typography'],
  capabilities: { needsAnalysis: false, needsInput: false, supportsAspect: true, stateful: false, gpuCost: 'low', expandsBounds: true },
  paramsSchemaVersion: 1,
  params: [
    { key: 'text', label: 'Text', group: 'Text', type: 'string', default: 'Pulseforge', multiline: true, maxLength: 2000 },
    { key: 'font', label: 'Font', group: 'Text', type: 'asset', accept: 'font', default: '', description: 'Empty uses the bundled Inter' },
    {
      key: 'case', label: 'Case', group: 'Text', type: 'enum', default: 'none',
      options: [{ value: 'none', label: 'As typed' }, { value: 'upper', label: 'UPPERCASE' }, { value: 'lower', label: 'lowercase' }],
    },
    // Not modulatable: size re-rasterises the glyphs. Pulse text with the layer's scale instead.
    { key: 'size', label: 'Size', group: 'Text', type: 'float', default: 0.12, min: 0.01, max: 0.6, softMax: 0.3, space: 'canvas', aspectOverridable: true, modulatable: false },
    { key: 'letterSpacing', label: 'Tracking', group: 'Text', type: 'float', default: 0, min: -0.2, max: 1, softMax: 0.4, unit: 'em', modulatable: false },
    { key: 'lineHeight', label: 'Line height', group: 'Text', type: 'float', default: 1.15, min: 0.7, max: 3, modulatable: false },
    {
      key: 'align', label: 'Align', group: 'Text', type: 'enum', default: 'center',
      options: [{ value: 'left', label: 'Left' }, { value: 'center', label: 'Centre' }, { value: 'right', label: 'Right' }],
    },
    { key: 'maxWidth', label: 'Max width', group: 'Text', type: 'float', default: 0.9, min: 0.05, max: 1, aspectOverridable: true, modulatable: false, description: 'Wrap width, as a fraction of the canvas width; for vertical text, the column height as a fraction of its height' },
    { key: 'colorEmoji', label: 'Colour emoji', group: 'Text', type: 'bool', default: false, modulatable: false, description: 'Emoji in their own colours, not the fill. Needs the Colour emoji component. This layer only: lyrics stay one colour' },
    {
      key: 'direction', label: 'Direction', group: 'Text', type: 'enum', default: 'horizontal', modulatable: false,
      options: [{ value: 'horizontal', label: 'Horizontal' }, { value: 'vertical', label: 'Vertical' }],
      description: 'Vertical stacks upright characters top to bottom, in columns from the right. This layer only: lyrics stay horizontal',
    },

    {
      key: 'fillMode', label: 'Fill', group: 'Fill', type: 'enum', default: 'solid',
      options: [{ value: 'solid', label: 'Solid' }, { value: 'gradient', label: 'Vertical gradient' }],
    },
    { key: 'color', label: 'Colour', group: 'Fill', type: 'color', default: '#ffffff', paletteRole: 'text', modulatable: true },
    { key: 'colorB', label: 'Bottom colour', group: 'Fill', type: 'color', default: '#ff2d95', paletteRole: 'accent', visibleWhen: { param: 'fillMode', equals: 'gradient' } },

    { key: 'strokeWidth', label: 'Outline', group: 'Outline', type: 'float', default: 0, min: 0, max: 0.3, softMax: 0.12, unit: 'em', modulatable: false },
    { key: 'strokeColor', label: 'Outline colour', group: 'Outline', type: 'color', default: '#000000' },

    // On by default: thin bright type over a busy visual is the classic illegible combination (lyrics-spec §7).
    { key: 'shadow', label: 'Shadow', group: 'Shadow', type: 'float', default: 0.45, min: 0, max: 1, modulatable: true },
    { key: 'shadowColor', label: 'Shadow colour', group: 'Shadow', type: 'color', default: '#000000', paletteRole: 'textShadow' },
    { key: 'shadowDistance', label: 'Distance', group: 'Shadow', type: 'float', default: 0.04, min: 0, max: 0.5, unit: 'em' },
    { key: 'shadowAngle', label: 'Angle', group: 'Shadow', type: 'float', default: 120, min: 0, max: 360, unit: '°', advanced: true },
    { key: 'shadowSoftness', label: 'Softness', group: 'Shadow', type: 'float', default: 0.08, min: 0, max: 0.5, unit: 'em' },

    { key: 'glow', label: 'Glow', group: 'Glow', type: 'float', default: 0, min: 0, max: 3, softMax: 1.5, modulatable: true },
    { key: 'glowColor', label: 'Glow colour', group: 'Glow', type: 'color', default: '#ff2d95', paletteRole: 'glow' },
    { key: 'glowRadius', label: 'Radius', group: 'Glow', type: 'float', default: 0.25, min: 0.02, max: 1, unit: 'em' },

    // Slices of the same masks, marched in the shader, so depth can follow the beat without a new raster.
    { key: 'depth', label: 'Depth', group: 'Extrude', type: 'float', default: 0, min: 0, max: 1, softMax: 0.5, unit: 'em', modulatable: true, description: 'Pulls a solid side out of the letters, for a 3D look' },
    { key: 'depthAngle', label: 'Direction', group: 'Extrude', type: 'float', default: 45, min: 0, max: 360, unit: '°', modulatable: true, description: 'Where the side falls: 0 is right, 90 down' },
    { key: 'depthColor', label: 'Side colour', group: 'Extrude', type: 'color', default: '#555555', description: 'At the front edge; the side darkens away from it' },

    { key: 'plate', label: 'Plate', group: 'Plate', type: 'bool', default: false, description: 'A rounded panel behind the text' },
    { key: 'plateColor', label: 'Plate colour', group: 'Plate', type: 'color', default: '#000000', visibleWhen: { param: 'plate', equals: true } },
    { key: 'plateOpacity', label: 'Plate opacity', group: 'Plate', type: 'float', default: 0.55, min: 0, max: 1, visibleWhen: { param: 'plate', equals: true } },
    { key: 'platePadding', label: 'Padding', group: 'Plate', type: 'float', default: 0.35, min: 0, max: 2, unit: 'em', visibleWhen: { param: 'plate', equals: true } },
    { key: 'plateRadius', label: 'Corner', group: 'Plate', type: 'float', default: 0.2, min: 0, max: 2, unit: 'em', visibleWhen: { param: 'plate', equals: true } },

    // 'none' by default, deliberately: with a fade-in the layer is fully transparent *at* its in
    // point, so a text layer added to a stopped preview looked broken until you scrubbed.
    { key: 'animIn', label: 'In', group: 'Animation', type: 'enum', default: 'none', options: TEXT_ANIMATIONS, modulatable: false },
    { key: 'animOut', label: 'Out', group: 'Animation', type: 'enum', default: 'none', options: TEXT_ANIMATIONS, modulatable: false },
    { key: 'animSeconds', label: 'Duration', group: 'Animation', type: 'float', default: 0.6, min: 0, max: 10, softMax: 3, unit: 's', description: 'Timed from the layer’s in and out points' },
  ],
};

const easeOut = (x: number) => 1 - (1 - x) ** 3;

const MAX_SLICES = 64;

/** Scripts whose letters change shape with their neighbours, which vertical text cannot give them. */
const JOINED_SCRIPT = /[\p{Script=Arabic}\p{Script=Syriac}\p{Script=Nko}\p{Script=Mongolian}]/u;

export interface AnimationState {
  readonly opacity: number;
  /** Vertical offset in em (y down). */
  readonly offsetEm: number;
  readonly scale: number;
  /** Mip level added to every mask sample. */
  readonly blurLod: number;
  /** Per-word visibility 0..1, or null when neither animation is per word. */
  readonly words: Float32Array | null;
}

/**
 * Entry and exit animation at time `t`, closed form (CLAUDE.md #1). In is timed from the layer's
 * in point, out *ends* at its out point; with no out point there is no exit. Two animations
 * combine by multiplying opacity and scale and adding offset and blur, so "slide up in, fade out"
 * needs no special case.
 */
export function textAnimation(
  t: number,
  layer: { readonly inSeconds: number; readonly outSeconds: number | null },
  animIn: string,
  animOut: string,
  seconds: number,
  wordCount: number,
): AnimationState {
  const pIn = seconds <= 0 ? 1 : clamp01((t - layer.inSeconds) / seconds);
  const pOut = seconds <= 0 || layer.outSeconds === null ? 1 : clamp01((layer.outSeconds - t) / seconds);
  let opacity = 1;
  let offsetEm = 0;
  let scale = 1;
  let blurLod = 0;
  const perWord = (a: string) => a === 'typewriter' || a === 'stagger';
  const words = perWord(animIn) || perWord(animOut) ? new Float32Array(Math.max(1, wordCount)).fill(1) : null;

  const apply = (animation: string, progress: number, entering: boolean) => {
    const v = easeOut(progress);
    switch (animation) {
      case 'fade':
        opacity *= v;
        break;
      case 'slide-up':
        // Enters rising from below; leaves rising further.
        offsetEm += (entering ? 1 : -1) * (1 - v) * 0.6;
        opacity *= v;
        break;
      case 'slide-down':
        offsetEm += (entering ? -1 : 1) * (1 - v) * 0.6;
        opacity *= v;
        break;
      case 'scale':
        scale *= 0.75 + 0.25 * v;
        opacity *= v;
        break;
      case 'blur':
        blurLod += (1 - v) * 5;
        opacity *= v;
        break;
      case 'typewriter':
      case 'stagger': {
        if (words === null) break;
        const n = Math.max(1, wordCount);
        for (let i = 0; i < n; i += 1) {
          // The same slots both ways: exit progress runs 1 → 0, so the last word goes first and
          // text un-types rather than vanishing from the front.
          const w = animation === 'typewriter'
            ? clamp01(progress * n - i)
            : easeOut(clamp01((progress * (n + 2) - i) / 3));
          words[i] = (words[i] ?? 1) * w;
        }
        break;
      }
      default:
        break;
    }
  };
  apply(animIn, pIn, true);
  apply(animOut, pOut, false);
  return { opacity, offsetEm, scale, blurLod, words };
}

const FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 u_canvas;
uniform sampler2D u_mask;   // RG: fill, outline — mipmapped, per-word visibility already applied
uniform vec2 u_bitmap;      // bitmap size, px
uniform vec2 u_origin;      // bitmap top-left on the canvas, px, y down
uniform vec4 u_content;     // content box inside the bitmap: x, y, w, h
uniform vec3 u_colorA;      // linear
uniform vec3 u_colorB;      // linear
uniform int u_gradient;
uniform vec3 u_strokeColor;
uniform vec4 u_shadow;      // dx, dy (px), lod, opacity
uniform vec3 u_shadowColor;
uniform vec3 u_glowColor;
uniform vec2 u_glow;        // intensity, lod
uniform vec3 u_plateColor;
uniform vec3 u_plate;       // opacity, padding px, radius px
uniform vec4 u_anim;        // offset y px, scale, blur lod, opacity
uniform sampler2D u_emoji;  // colour glyphs, sRGB-decoded on read; alpha 0 everywhere else
uniform int u_hasEmoji;
uniform vec4 u_extrude;     // dx, dy (px), slices, lod
uniform vec3 u_extrudeColor;
out vec4 outColor;

${TEXT_SAMPLING_GLSL}
void main() {
  vec2 p = vec2(gl_FragCoord.x, u_canvas.y - gl_FragCoord.y);
  vec2 center = u_origin + u_content.xy + u_content.zw * 0.5;
  // The animation moves and scales the whole block about its centre.
  vec2 q = center + (p - center - vec2(0.0, u_anim.x)) / u_anim.y;
  vec2 uv = (q - u_origin) / u_bitmap;
  float blur = u_anim.z;

  vec2 m = blur > 0.0 ? vec2(coverage(uv, blur)) * sign(maskAt(uv, blur)) : maskAt(uv, 0.0);
  float fillA = m.r;
  float strokeA = m.g;
  float g = clamp((q.y - u_origin.y - u_content.y) / max(u_content.w, 1.0), 0.0, 1.0);
  vec3 fillColor = u_gradient == 1 ? mix(u_colorA, u_colorB, g) : u_colorA;
  if (u_hasEmoji == 1) {
    vec4 e = textureLod(u_emoji, uv, 0.0);
    if (e.a > 0.0 && inside(uv) > 0.0) fillColor = e.rgb;
  }
  vec4 glyph = vec4(fillColor * fillA, fillA) + vec4(u_strokeColor * strokeA, strokeA) * (1.0 - fillA);

  vec4 color = vec4(0.0);
  if (u_plate.x > 0.0) {
    vec2 half_ = u_content.zw * 0.5 + u_plate.y;
    float d = roundedBox(p - center, half_ * u_anim.y, u_plate.z * u_anim.y);
    float a = (1.0 - smoothstep(-0.75, 0.75, d)) * u_plate.x;
    color = vec4(u_plateColor * a, a);
  }
  if (u_shadow.w > 0.0) {
    float s = coverage(uv - u_shadow.xy / u_bitmap, max(u_shadow.z, blur)) * u_shadow.w;
    color = vec4(u_shadowColor * s, s) + color * (1.0 - s);
  }
  if (u_glow.x > 0.0) {
    // Light, not paint: added to colour without covering what is behind it.
    float halo = coverage(uv, u_glow.y) * 0.6 + coverage(uv, u_glow.y + 1.5) * 0.4;
    color.rgb += u_glowColor * halo * u_glow.x;
    color.a = min(1.0, color.a + halo * u_glow.x * 0.25);
  }
  if (u_extrude.z > 0.0) {
    // Furthest slice first, each covering the one behind it, darkening with distance from the face.
    vec2 reach = u_extrude.xy / u_anim.y / u_bitmap;
    vec4 side = vec4(0.0);
    for (float i = u_extrude.z; i >= 1.0; i -= 1.0) {
      float f = i / u_extrude.z;
      vec2 s = maskAt(uv - reach * f, u_extrude.w + blur);
      float a = max(s.r, s.g);
      side = vec4(u_extrudeColor * mix(1.0, 0.3, f) * a, a) + side * (1.0 - a);
    }
    color = side + color * (1.0 - side.a);
  }
  color = glyph + color * (1.0 - glyph.a);
  outColor = color * u_anim.w;
}
`;

function createText(gl: WebGL2RenderingContext): ModuleInstance {
  const program = createProgram(gl, textManifest.id, FULLSCREEN_VERT, FRAG);
  const maskPass = createWordMaskPass(gl, textManifest.id);
  const names = [
    'u_canvas', 'u_mask', 'u_bitmap', 'u_origin', 'u_content', 'u_colorA', 'u_colorB', 'u_gradient', 'u_strokeColor',
    'u_shadow', 'u_shadowColor', 'u_glowColor', 'u_glow', 'u_plateColor', 'u_plate', 'u_anim', 'u_extrude', 'u_extrudeColor', 'u_emoji', 'u_hasEmoji',
  ] as const;
  const u = Object.fromEntries(names.map((name) => [name, uniformLocation(gl, program, name)])) as Record<(typeof names)[number], WebGLUniformLocation>;
  const vao = gl.createVertexArray();
  let uploaded: UploadedText | undefined;

  const release = () => {
    if (uploaded === undefined) return;
    releaseTextRaster(gl, uploaded);
    uploaded = undefined;
  };

  const upload = (key: string, raster: TextRaster, strokePx: number): UploadedText => {
    release();
    uploaded = uploadTextRaster(gl, key, raster, strokePx);
    return uploaded;
  };

  return {
    resize() {},

    render(ctx: RenderContext, params: ParamValues) {
      const rasterizer = ctx.text;
      if (rasterizer === undefined) {
        ctx.warn('text: this renderer has no text rasteriser, so text layers cannot be drawn');
        return;
      }
      if (!rasterizer.ready) {
        ctx.warn('text: fonts are still loading');
        return;
      }
      const raw = str(params, 'text');
      const casing = str(params, 'case');
      const text = casing === 'upper' ? raw.toUpperCase() : casing === 'lower' ? raw.toLowerCase() : raw;
      if (text.trim() === '') return;

      const font = ctx.font(str(params, 'font'));
      if (font.missing !== undefined) ctx.warn(`text: ${font.missing}; drawing with the default font`);

      const em = Math.min(4000, Math.max(1, num(params, 'size') * ctx.canvas.referenceScale));
      const strokePx = num(params, 'strokeWidth') * em;
      const glowRadiusPx = num(params, 'glowRadius') * em;
      const shadowDistancePx = num(params, 'shadowDistance') * em;
      const shadowSoftPx = num(params, 'shadowSoftness') * em;
      const glowOn = num(params, 'glow') > 0;
      const shadowOn = num(params, 'shadow') > 0;
      // Room for the halo and the shadow inside the bitmap; blur-in reaches ~32 px at lod 5.
      const paddingPx = Math.ceil(Math.min(em * 3, Math.max(
        strokePx + 2,
        glowOn ? glowRadiusPx * 3 : 0,
        shadowOn ? shadowDistancePx + shadowSoftPx * 3 : 0,
        48,
      )));

      const vertical = str(params, 'direction') === 'vertical';
      if (vertical && JOINED_SCRIPT.test(text)) ctx.warn('text: vertical text draws each character apart, so these letters do not join');
      const request: TextRequest = {
        text,
        fontHash: font.hash,
        sizePx: em,
        letterSpacingPx: num(params, 'letterSpacing') * em,
        lineHeight: num(params, 'lineHeight'),
        align: str(params, 'align') as TextRequest['align'],
        maxWidthPx: num(params, 'maxWidth') * ctx.canvas.width,
        strokePx,
        paddingPx,
        ...(vertical ? { vertical: { maxHeightPx: num(params, 'maxWidth') * ctx.canvas.height } } : {}),
        ...(params['colorEmoji'] === true ? { colorEmoji: true as const } : {}),
      };
      const key = JSON.stringify(request);
      const current = uploaded?.key === key ? uploaded : upload(key, rasterizer.rasterize(request), strokePx);
      const { raster } = current;
      if (!raster.fontFound && font.missing === undefined) ctx.warn(`text: font "${font.name}" could not be used; drawing with the default font`);
      if (raster.missingGlyphs !== undefined && raster.missingGlyphs.length > 0) ctx.warn(`text: no font has ${raster.missingGlyphs.join(' ')}; drawn as a box. Choose a font that does`);
      if (raster.colorEmojiMissing === true) ctx.warn('text: colour emoji are not installed (Settings, Components); drawing them in the text colour');
      if (raster.clamped) ctx.warn('text: the text block is larger than the maximum texture size and was scaled down');

      const animation = textAnimation(ctx.time.t, ctx.layer, str(params, 'animIn'), str(params, 'animOut'), num(params, 'animSeconds'), raster.words.length);
      // Pass 1 writes into the layer's own mask; the host's output target is restored after.
      const mask = animation.words !== null ? maskPass.apply(current, animation.words) : current.base;
      // Always, not only after the mask pass: uploading a new raster creates a framebuffer too, and
      // that unbinds the host's target — static text once drew into the void because of it.
      gl.bindFramebuffer(gl.FRAMEBUFFER, ctx.outputTarget.framebuffer);
      gl.viewport(0, 0, ctx.outputTarget.width, ctx.outputTarget.height);

      // The block is centred on the canvas; the layer transform places it.
      const contentCx = raster.content.x + raster.content.width / 2;
      const contentCy = raster.content.y + raster.content.height / 2;
      const originX = Math.round(ctx.canvas.width / 2 - contentCx);
      const originY = Math.round(ctx.canvas.height / 2 - contentCy);
      const angle = (num(params, 'shadowAngle') * Math.PI) / 180;
      const lodFor = (px: number) => Math.max(0, Math.log2(Math.max(1, px)));

      const a = linearHex(str(params, 'color'), '#ffffff');
      const b = linearHex(str(params, 'colorB'), '#ff2d95');
      const sc = linearHex(str(params, 'strokeColor'), '#000000');
      const shc = linearHex(str(params, 'shadowColor'), '#000000');
      const gc = linearHex(str(params, 'glowColor'), '#ff2d95');
      const pc = linearHex(str(params, 'plateColor'), '#000000');
      const dc = linearHex(str(params, 'depthColor'), '#555555');
      const depthPx = num(params, 'depth') * em;
      const depthAngle = (num(params, 'depthAngle') * Math.PI) / 180;
      // One slice a pixel, up to a limit; past it, slices come from a softer mip so no gaps show.
      const slices = depthPx > 0 ? Math.min(MAX_SLICES, Math.ceil(depthPx)) : 0;

      gl.disable(gl.BLEND);
      gl.useProgram(program);
      gl.uniform2f(u.u_canvas, ctx.canvas.width, ctx.canvas.height);
      gl.uniform2f(u.u_bitmap, raster.width, raster.height);
      gl.uniform2f(u.u_origin, originX, originY);
      gl.uniform4f(u.u_content, raster.content.x, raster.content.y, raster.content.width, raster.content.height);
      gl.uniform3f(u.u_colorA, a[0], a[1], a[2]);
      gl.uniform3f(u.u_colorB, b[0], b[1], b[2]);
      gl.uniform1i(u.u_gradient, str(params, 'fillMode') === 'gradient' ? 1 : 0);
      gl.uniform3f(u.u_strokeColor, sc[0], sc[1], sc[2]);
      gl.uniform4f(u.u_shadow, Math.cos(angle) * shadowDistancePx, Math.sin(angle) * shadowDistancePx, lodFor(shadowSoftPx), num(params, 'shadow'));
      gl.uniform3f(u.u_shadowColor, shc[0], shc[1], shc[2]);
      gl.uniform3f(u.u_glowColor, gc[0], gc[1], gc[2]);
      gl.uniform2f(u.u_glow, num(params, 'glow'), lodFor(glowRadiusPx));
      gl.uniform3f(u.u_plateColor, pc[0], pc[1], pc[2]);
      gl.uniform3f(u.u_plate, params['plate'] === true ? num(params, 'plateOpacity') : 0, num(params, 'platePadding') * em, num(params, 'plateRadius') * em);
      gl.uniform4f(u.u_anim, animation.offsetEm * em, Math.max(0.01, animation.scale), animation.blurLod, animation.opacity);
      gl.uniform4f(u.u_extrude, Math.cos(depthAngle) * depthPx, Math.sin(depthAngle) * depthPx, slices, slices > 0 ? lodFor(depthPx / slices) : 0);
      gl.uniform3f(u.u_extrudeColor, dc[0], dc[1], dc[2]);
      bindTexture(gl, 0, mask, u.u_mask);
      // Something valid on the unit either way; the uniform decides whether it is read.
      bindTexture(gl, 1, current.color ?? mask, u.u_emoji);
      gl.uniform1i(u.u_hasEmoji, current.color === null ? 0 : 1);
      drawFullscreenTriangle(gl, vao);
      unbindTextures(gl, 2);
      gl.useProgram(null);
    },

    dispose() {
      release();
      maskPass.dispose();
      gl.deleteProgram(program);
      gl.deleteVertexArray(vao);
    },
  };
}

export const textModule: ModuleDefinition = { manifest: textManifest, create: createText };
