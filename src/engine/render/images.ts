// The engine's image store: decoded pixels registered by hash, uploaded to the GPU on first use.
//
// Uploaded as SRGB8_ALPHA8, so the GPU decodes to linear on every sample (compositor-spec §2:
// "textures are decoded to linear on upload, never used raw"). Doing the decode in the texture
// format rather than in a shader also means filtering happens in linear light, which is the
// correct thing to average — mipmaps included.

import { validateDecodedImage, type DecodedImage, type ImageTexture } from '../core/image.ts';
import { RenderSetupError } from './gl.ts';

interface Entry {
  readonly image: DecodedImage;
  texture: ImageTexture | undefined;
}

export class ImageStore {
  private readonly gl: WebGL2RenderingContext;
  private readonly entries = new Map<string, Entry>();

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
  }

  /** Registers pixels under a content hash. Registering the same hash again replaces nothing. */
  set(hash: string, image: DecodedImage): void {
    if (this.entries.has(hash)) return;
    validateDecodedImage(image);
    const max = Number(this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE));
    if (image.width > max || image.height > max) {
      throw new RenderSetupError(`an image of ${image.width}×${image.height} exceeds this GPU's ${max}px texture limit; decode it smaller`);
    }
    this.entries.set(hash, { image, texture: undefined });
  }

  has(hash: string): boolean {
    return this.entries.has(hash);
  }

  delete(hash: string): void {
    const entry = this.entries.get(hash);
    if (entry?.texture !== undefined) this.gl.deleteTexture(entry.texture.texture);
    this.entries.delete(hash);
  }

  /** The texture for a hash, uploading it the first time it is asked for. */
  texture(hash: string): ImageTexture | undefined {
    const entry = this.entries.get(hash);
    if (entry === undefined) return undefined;
    if (entry.texture !== undefined) return entry.texture;

    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    // Straight alpha as decoded; modules premultiply after linearising (premultiplying sRGB-encoded
    // values first would be the wrong order).
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, entry.image.width, entry.image.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, entry.image.pixels);
    // Mipmaps: a photo fitted down onto a smaller canvas otherwise aliases and shimmers under a
    // slow zoom, which is exactly the move a background makes.
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);

    entry.texture = { texture, width: entry.image.width, height: entry.image.height };
    return entry.texture;
  }

  dispose(): void {
    for (const hash of [...this.entries.keys()]) this.delete(hash);
  }
}
