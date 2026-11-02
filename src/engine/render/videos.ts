// The engine's video store: one texture per video, holding whichever frame the host last gave it.
//
// Unlike images, a video's pixels change every frame, so nothing is cached by content — the host
// decodes ahead from the frame cache (src/assets/video-cache.ts) and pushes each frame in before
// the engine renders it. One texture per video, re-uploaded in place: allocating per frame at
// 60 fps would fragment VRAM for no gain.
//
// Uploaded as SRGB8_ALPHA8 like images, so sampling and filtering happen in linear light
// (compositor-spec §2). No mipmaps: a video frame is replaced every frame, and rebuilding the
// chain each time costs more than the aliasing it would save on a fitted-down clip.

import type { DecodedImage } from '../core/image.ts';
import { validateDecodedImage } from '../core/image.ts';
import type { VideoTexture } from '../core/video.ts';
import { RenderSetupError } from './gl.ts';

/** What a host can hand over for one frame: decoded bytes, or anything WebGL can upload directly. */
export type VideoFrameSource = DecodedImage | ImageBitmap;

interface Entry {
  texture: WebGLTexture;
  width: number;
  height: number;
  frameIndex: number;
  frameCount: number;
}

function isDecoded(source: VideoFrameSource): source is DecodedImage {
  return (source as DecodedImage).pixels instanceof Uint8Array;
}

export class VideoStore {
  private readonly gl: WebGL2RenderingContext;
  private readonly entries = new Map<string, Entry>();

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
  }

  /** Declares how long a video's extracted sequence is; the module needs it to loop and clamp. */
  setSequence(hash: string, frameCount: number): void {
    const entry = this.entries.get(hash);
    if (entry !== undefined) {
      entry.frameCount = frameCount;
      return;
    }
    this.entries.set(hash, { texture: this.gl.createTexture(), width: 0, height: 0, frameIndex: -1, frameCount });
  }

  has(hash: string): boolean {
    return this.entries.has(hash);
  }

  /** Uploads one frame. `frameIndex` is which frame of the sequence it is, for the module to check. */
  setFrame(hash: string, frameIndex: number, source: VideoFrameSource): void {
    const gl = this.gl;
    let entry = this.entries.get(hash);
    if (entry === undefined) {
      this.setSequence(hash, 0);
      entry = this.entries.get(hash)!;
    }
    const width = isDecoded(source) ? source.width : source.width;
    const height = isDecoded(source) ? source.height : source.height;
    const max = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE));
    if (width > max || height > max) {
      throw new RenderSetupError(`a video frame of ${width}×${height} exceeds this GPU's ${max}px texture limit; extract it smaller`);
    }
    if (isDecoded(source)) validateDecodedImage(source);

    gl.bindTexture(gl.TEXTURE_2D, entry.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    if (isDecoded(source)) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, source.pixels);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);

    entry.width = width;
    entry.height = height;
    entry.frameIndex = frameIndex;
  }

  /** The current frame's texture, or undefined when nothing has been registered for this video. */
  get(hash: string): VideoTexture | undefined {
    const entry = this.entries.get(hash);
    if (entry === undefined || entry.width === 0) return undefined;
    return {
      texture: entry.texture,
      width: entry.width,
      height: entry.height,
      frameIndex: entry.frameIndex,
      frameCount: entry.frameCount,
    };
  }

  frameCount(hash: string): number {
    return this.entries.get(hash)?.frameCount ?? 0;
  }

  dispose(): void {
    for (const entry of this.entries.values()) this.gl.deleteTexture(entry.texture);
    this.entries.clear();
  }
}
