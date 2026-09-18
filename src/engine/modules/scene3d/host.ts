// Three.js inside the engine (M37, compositor-spec §7).
//
// The three rules this file exists to keep, and what goes wrong without each:
//
//  1. **One context.** Three is constructed over the engine's own WebGL2 context, never its own:
//     two contexts would mean copying every scene across a context boundary every frame. One
//     renderer per context, shared by every scene layer on it and reference-counted.
//  2. **State hygiene.** Three keeps a cache of the GL state it believes is set, and changes blend,
//     depth, cull, framebuffers, vertex arrays and pixel-store state freely. The engine changes the
//     same state behind its back between scene renders. So every scene render is bracketed by
//     `resetState()` — before, so Three's cache matches the GL it is handed; after, so the next 2D
//     layer does not draw with whatever Three left behind — and the module then rebinds the
//     engine's own target explicitly. Skipping either half is the "random, layer-order-dependent
//     corruption" the spec warns about.
//  3. **No clock.** Nothing here reads time. A scene is posed from `ctx.time` and the analysis on
//     every frame, from scratch, so frame n is the same whether it was played to or jumped to.
//     Three's own conveniences that break this — `Clock`, animation loops, `EffectComposer` —
//     are not used; post-processing is the engine's effect chain, so it composes with 2D layers.
//
// A scene renders into its own multisampled half-float target (linear light, like every engine
// intermediate) with a depth texture, and is then copied into the layer's target. The depth
// texture outlives the copy, which is how a depth-of-field effect on the layer can read it.

import {
  DepthTexture, FloatType, HalfFloatType, LinearSRGBColorSpace, NearestFilter, NoToneMapping, RGBAFormat,
  WebGLRenderTarget, WebGLRenderer, type Camera, type Scene, type Texture,
} from 'three';
import type { LayerDepth } from '../../core/module.ts';
import { FULLSCREEN_VERT, createProgram, drawFullscreenTriangle, uniformLocation } from '../../render/gl.ts';

interface SharedRenderer {
  readonly renderer: WebGLRenderer;
  users: number;
  /** The most recent shader failure Three reported, for the layer to warn with. */
  shaderError: string | null;
}

const renderers = new WeakMap<WebGL2RenderingContext, SharedRenderer>();

function acquire(gl: WebGL2RenderingContext): SharedRenderer {
  const existing = renderers.get(gl);
  if (existing !== undefined) {
    existing.users += 1;
    return existing;
  }
  const renderer = new WebGLRenderer({
    // Three reads attributes and listens for context loss on the canvas; it never resizes it,
    // because `setSize` is never called — scenes draw into their own targets.
    canvas: gl.canvas as HTMLCanvasElement,
    context: gl,
    antialias: false,
    alpha: true,
    premultipliedAlpha: true,
    stencil: false,
  });
  // Linear in, linear out: the engine tone-maps and encodes once, at the end (compositor-spec §2).
  renderer.outputColorSpace = LinearSRGBColorSpace;
  renderer.toneMapping = NoToneMapping;
  renderer.autoClear = true;
  renderer.setClearColor(0x000000, 0);
  const shared: SharedRenderer = { renderer, users: 1, shaderError: null };
  // A shader that fails to build must be reported with its log, not become a black layer.
  renderer.debug.onShaderError = (context, program, vertexShader, fragmentShader) => {
    const logs = [context.getProgramInfoLog(program), context.getShaderInfoLog(vertexShader), context.getShaderInfoLog(fragmentShader)]
      .map((log) => (log ?? '').replaceAll(String.fromCharCode(0), '').trim())
      .filter((log) => log !== '');
    shared.shaderError = logs.join(' | ') || 'a 3D shader failed to compile';
  };
  renderer.resetState();
  renderers.set(gl, shared);
  return shared;
}

function release(gl: WebGL2RenderingContext, shared: SharedRenderer): void {
  shared.users -= 1;
  if (shared.users > 0) return;
  shared.renderer.dispose();
  renderers.delete(gl);
}

const COPY_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_scene;
out vec4 outColor;
void main() {
  // Same size, same orientation: a straight texel copy. Three wrote premultiplied linear light.
  outColor = texelFetch(u_scene, ivec2(gl_FragCoord.xy), 0);
}
`;

/** MSAA for the scene's geometry edges; resolved by Three before the copy reads it. */
const SAMPLES = 4;

/**
 * One layer's view of the shared renderer: its render target, the copy into the engine, and the
 * depth it leaves behind for the layer's effects.
 */
export class SceneRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly shared: SharedRenderer;
  private readonly target: WebGLRenderTarget;
  private readonly copyProgram: WebGLProgram;
  private readonly copyScene: WebGLUniformLocation;
  private readonly vao: WebGLVertexArrayObject;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.shared = acquire(gl);
    this.target = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType,
      format: RGBAFormat,
      colorSpace: LinearSRGBColorSpace,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      generateMipmaps: false,
      depthBuffer: true,
      stencilBuffer: false,
      samples: SAMPLES,
      resolveDepthBuffer: true,
      depthTexture: new DepthTexture(1, 1, FloatType),
    });
    this.copyProgram = createProgram(gl, 'scene3d.copy', FULLSCREEN_VERT, COPY_FRAG);
    this.copyScene = uniformLocation(gl, this.copyProgram, 'u_scene');
    this.vao = gl.createVertexArray();
  }

  /** Three's renderer, for modules that need capabilities or to upload ahead of time. */
  get three(): WebGLRenderer {
    return this.shared.renderer;
  }

  /**
   * Renders `scene` from `camera` and copies the result into `output`, which is then bound again
   * with the engine's state. Returns the scene's depth, or a reason it could not be drawn.
   */
  render(
    scene: Scene,
    camera: Camera & { near: number; far: number; fov: number },
    output: { framebuffer: WebGLFramebuffer; width: number; height: number },
  ): { depth: LayerDepth | null; error: string | null } {
    const gl = this.gl;
    const renderer = this.shared.renderer;
    const { width, height } = output;
    if (this.target.width !== width || this.target.height !== height) this.target.setSize(width, height);

    this.shared.shaderError = null;
    renderer.resetState();
    renderer.setRenderTarget(this.target);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.resetState();
    const error = this.shared.shaderError;

    const colour = this.webglTexture(this.target.texture);
    const depthTexture = this.target.depthTexture === null ? undefined : this.webglTexture(this.target.depthTexture);

    // Back to the engine: its framebuffer, its viewport, known state.
    gl.bindFramebuffer(gl.FRAMEBUFFER, output.framebuffer);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    if (colour !== undefined) {
      gl.useProgram(this.copyProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, colour);
      gl.uniform1i(this.copyScene, 0);
      drawFullscreenTriangle(gl, this.vao);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.useProgram(null);
    }
    return {
      depth: depthTexture === undefined ? null : { texture: depthTexture, near: camera.near, far: camera.far, fov: camera.fov },
      error: colour === undefined ? 'the 3D scene produced no image' : error,
    };
  }

  dispose(): void {
    this.target.depthTexture?.dispose();
    this.target.dispose();
    this.gl.deleteProgram(this.copyProgram);
    this.gl.deleteVertexArray(this.vao);
    release(this.gl, this.shared);
  }

  /** The GL texture behind a Three texture, once Three has created it. */
  private webglTexture(texture: Texture): WebGLTexture | undefined {
    return (this.shared.renderer.properties.get(texture) as { __webglTexture?: WebGLTexture }).__webglTexture;
  }
}
