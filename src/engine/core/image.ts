// Images as the engine sees them (compositor-spec §2, module-spec §7 rule 4).
//
// The engine never touches a file. The host decodes an image — through the vendored FFmpeg, so the
// preview and the export get the same pixels — and registers it by content hash. A project refers
// to images by asset id; the snapshot maps each id to its hash. Keying the pixels by hash rather
// than by id or path is what lets a relinked or renamed file keep working, and what makes two
// layers using the same picture share one texture.

/** 8-bit RGBA, straight alpha, sRGB-encoded, top row first. Exactly as decoded. */
export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

/** What `RenderProject.assets` records for an image: enough to find its pixels, nothing about files. */
export interface ImageAssetRef {
  readonly kind: 'image';
  /** SHA-256 of the file's bytes; the key the host registers the decoded pixels under. */
  readonly hash: string;
  /** For messages only. */
  readonly name: string;
}

/** A GPU texture for an image, as a module receives it. sRGB-decoded on sample: values are linear. */
export interface ImageTexture {
  readonly texture: WebGLTexture;
  readonly width: number;
  readonly height: number;
}

/** Throws a message naming the problem rather than letting a short buffer upload garbage. */
export function validateDecodedImage(image: DecodedImage): void {
  if (!Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width <= 0 || image.height <= 0) {
    throw new RangeError(`image has an invalid size ${image.width}×${image.height}`);
  }
  if (image.pixels.length !== image.width * image.height * 4) {
    throw new RangeError(`image is ${image.width}×${image.height} but carries ${image.pixels.length} bytes, expected ${image.width * image.height * 4}`);
  }
}
