// core.source.video — a video background layer (M39, M14, D4, compositor-spec §8).
//
// The module draws **one already-decoded frame**, chosen by `videoSourceFrame`. It never decodes,
// never seeks and never touches a clock: the host extracts the clip to stills at the project's fps
// and pushes the right frame in before each render, so preview and export cannot disagree and a
// scrubbed frame is the frame that would be exported.
//
// Fit modes and dim match the image background, so swapping a still for a clip changes nothing
// else about the layer.

import { parseHexColor, srgbToLinear } from '../core/color.ts';
import type { ModuleDefinition, ModuleInstance, ModuleManifest } from '../core/module.ts';
import { num, str, type ParamValues } from '../core/params.ts';
import { videoSourceFrame } from '../core/video.ts';
import { walkRenderModules, type RenderProject } from '../core/project.ts';
import { FULLSCREEN_VERT, createProgram, drawFullscreenTriangle, uniformLocation } from '../render/gl.ts';

const FITS = { cover: 0, contain: 1, stretch: 2 } as const;

export const videoManifest: ModuleManifest = {
  id: 'core.source.video',
  version: '0.1.0',
  kind: 'source',
  name: 'Video',
  description: 'A video clip as a layer, played from a deterministic frame cache at the project’s fps',
  category: 'background',
  tags: ['video', 'background', 'clip'],
  capabilities: { needsAnalysis: false, needsInput: false, supportsAspect: true, stateful: false, gpuCost: 'low' },
  paramsSchemaVersion: 1,
  params: [
    { key: 'video', label: 'Clip', group: 'Video', type: 'asset', accept: 'video', default: '' },
    {
      key: 'fit', label: 'Fit', group: 'Video', type: 'enum', default: 'cover',
      options: [{ value: 'cover', label: 'Cover' }, { value: 'contain', label: 'Contain' }, { value: 'stretch', label: 'Stretch' }],
    },
    { key: 'background', label: 'Bars', group: 'Video', type: 'color', default: '#000000', paletteRole: 'background', visibleWhen: { param: 'fit', equals: 'contain' } },
    { key: 'dim', label: 'Dim', group: 'Video', type: 'float', default: 0, min: 0, max: 1, modulatable: true, description: 'Darkens the clip — for legibility of what sits on top' },

    // Playback is decided before the frame is decoded, so none of these can be modulated: the host
    // has to know which frame to fetch, and a per-frame modulated speed has no fixed answer.
    { key: 'speed', label: 'Speed', group: 'Playback', type: 'float', default: 1, min: 0.1, max: 4, softMax: 2, unit: '×', modulatable: false },
    { key: 'loop', label: 'Loop', group: 'Playback', type: 'bool', default: true, modulatable: false },
    { key: 'startSeconds', label: 'Start at', group: 'Playback', type: 'float', default: 0, min: 0, max: 600, softMax: 60, unit: 's', modulatable: false, description: 'Trim: where in the clip playback begins' },
  ],
};

/** Playback settings as the host must read them too, defaults applied. */
export function videoPlayback(params: Readonly<Record<string, unknown>>, fps: { num: number; den: number }): {
  speed: number;
  loop: boolean;
  startFrame: number;
} {
  const speed = typeof params['speed'] === 'number' ? params['speed'] : 1;
  const loop = typeof params['loop'] === 'boolean' ? params['loop'] : true;
  const startSeconds = typeof params['startSeconds'] === 'number' ? params['startSeconds'] : 0;
  return {
    speed: Math.min(4, Math.max(0.1, speed)),
    loop,
    startFrame: Math.max(0, Math.round((startSeconds * fps.num) / fps.den)),
  };
}

/**
 * How many stills of one clip a render can consume: the timeline at each using layer's speed, from
 * its trim point. Extraction stops there, so a ten-minute clip under a thirty-second video is not
 * decoded whole; a looping layer wraps within what was extracted.
 */
export function videoFramesNeeded(project: RenderProject, assetId: string, timelineFrames: number): number {
  let needed = 1;
  for (const layer of walkRenderModules(project.layers)) {
    if (layer.module !== videoManifest.id || layer.params['video'] !== assetId) continue;
    const playback = videoPlayback(layer.params, project.canvas.fps);
    needed = Math.max(needed, playback.startFrame + Math.ceil(timelineFrames * playback.speed) + 1);
  }
  return needed;
}

const FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 u_canvas;
uniform sampler2D u_frame;
uniform vec2 u_size;     // the clip's pixel size
uniform int u_fit;
uniform float u_dim;
uniform vec3 u_bars;     // linear, behind a contained clip
uniform bool u_missing;
out vec4 outColor;

void main() {
  vec2 p = vec2(gl_FragCoord.x, u_canvas.y - gl_FragCoord.y) / u_canvas; // 0..1, y down
  float aspect = u_canvas.x / u_canvas.y;

  if (u_missing) {
    // The same visibly-wrong checkerboard the image background uses for a missing file.
    vec2 cell = floor(p * vec2(aspect, 1.0) * 12.0);
    outColor = vec4(mix(vec3(0.02), vec3(0.06), mod(cell.x + cell.y, 2.0)), 1.0);
    return;
  }

  float clipAspect = u_size.x / u_size.y;
  vec2 uv = p;
  if (u_fit == 0) {
    if (aspect > clipAspect) uv.y = (p.y - 0.5) * clipAspect / aspect + 0.5;
    else uv.x = (p.x - 0.5) * aspect / clipAspect + 0.5;
  } else if (u_fit == 1) {
    if (aspect > clipAspect) uv.x = (p.x - 0.5) * aspect / clipAspect + 0.5;
    else uv.y = (p.y - 0.5) * clipAspect / aspect + 0.5;
  }

  // Sampled outside any per-pixel branch: derivatives are undefined in non-uniform control flow.
  vec4 texel = texture(u_frame, uv);
  bool outside = uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0;
  vec3 rgb = texel.rgb * (1.0 - u_dim);
  vec4 clip = vec4(rgb * texel.a, texel.a);
  vec4 bars = vec4(u_bars, 1.0);
  outColor = outside ? bars : clip + bars * (1.0 - clip.a);
}
`;

function createVideo(gl: WebGL2RenderingContext): ModuleInstance {
  const program = createProgram(gl, videoManifest.id, FULLSCREEN_VERT, FRAG);
  const u = {
    canvas: uniformLocation(gl, program, 'u_canvas'),
    frame: uniformLocation(gl, program, 'u_frame'),
    size: uniformLocation(gl, program, 'u_size'),
    fit: uniformLocation(gl, program, 'u_fit'),
    dim: uniformLocation(gl, program, 'u_dim'),
    bars: uniformLocation(gl, program, 'u_bars'),
    missing: uniformLocation(gl, program, 'u_missing'),
  };
  const vao = gl.createVertexArray();
  const blank = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, blank);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
  gl.bindTexture(gl.TEXTURE_2D, null);

  return {
    resize() {},

    render(ctx, params: ParamValues) {
      const assetId = str(params, 'video');
      const clip = assetId === '' ? undefined : ctx.video(assetId);
      if (clip === undefined) {
        ctx.warn(assetId === ''
          ? 'video: no clip chosen'
          : `video: clip "${assetId}" has no extracted frames yet (missing file, or the frame cache is still building)`);
      } else {
        const { fps } = ctx.time;
        const playback = videoPlayback(params, fps);
        const wanted = videoSourceFrame({
          frameIndex: ctx.time.frameIndex,
          inFrame: Math.round((ctx.layer.inSeconds * fps.num) / fps.den),
          startFrame: playback.startFrame,
          speed: playback.speed,
          loop: playback.loop,
          frameCount: clip.frameCount,
        });
        // The host decodes ahead; if it is behind, say which frame is on screen rather than
        // pretending. Export waits for the right frame, so this only ever fires in preview.
        if (clip.frameIndex !== wanted) {
          ctx.warn(`video: showing frame ${clip.frameIndex} while frame ${wanted} decodes`);
        }
      }

      const bars = parseHexColor(str(params, 'background')) ?? { r: 0, g: 0, b: 0, a: 1 };
      gl.disable(gl.BLEND);
      gl.useProgram(program);
      gl.uniform2f(u.canvas, ctx.canvas.width, ctx.canvas.height);
      gl.uniform2f(u.size, clip?.width ?? 1, clip?.height ?? 1);
      gl.uniform1i(u.fit, FITS[str(params, 'fit') as keyof typeof FITS] ?? FITS.cover);
      gl.uniform1f(u.dim, num(params, 'dim'));
      gl.uniform3f(u.bars, srgbToLinear(bars.r), srgbToLinear(bars.g), srgbToLinear(bars.b));
      gl.uniform1i(u.missing, clip === undefined ? 1 : 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, clip?.texture ?? blank);
      gl.uniform1i(u.frame, 0);
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

export const videoModule: ModuleDefinition = { manifest: videoManifest, create: createVideo };
