// Video as the engine sees it (M39, D4, compositor-spec §8).
//
// The engine never decodes anything. A video reaches it as *one already-decoded frame at a time*,
// registered by the host under the video's content hash, plus the length of the extracted
// sequence. Which frame that should be is decided by `videoSourceFrame` — a pure function of the
// timeline frame index, so the host (which must decode ahead) and the module (which draws) agree
// by construction rather than by two implementations that drift.

/** What `RenderProject.assets` records for a video. */
export interface VideoAssetRef {
  readonly kind: 'video';
  readonly hash: string;
  readonly name: string;
}

/** A video's current frame, as a module receives it. sRGB-decoded on sample: values are linear. */
export interface VideoTexture {
  readonly texture: WebGLTexture;
  readonly width: number;
  readonly height: number;
  /** Which frame of the extracted sequence this texture holds. */
  readonly frameIndex: number;
  readonly frameCount: number;
}

export interface VideoTiming {
  /** The timeline frame being rendered. */
  readonly frameIndex: number;
  /** The frame the layer starts on, so a clip begins when its layer does. */
  readonly inFrame: number;
  /** Trim: the first frame of the sequence to use. */
  readonly startFrame: number;
  /** 1 is real time. Faster skips frames; slower repeats them. */
  readonly speed: number;
  readonly loop: boolean;
  readonly frameCount: number;
}

/**
 * Which frame of the extracted sequence belongs on this timeline frame.
 *
 * Integer in, integer out, no accumulation: frame 900 maps to the same source frame whether it was
 * scrubbed to or played through, which is the whole reason videos are pre-extracted (§8).
 */
export function videoSourceFrame(timing: VideoTiming): number {
  const { frameCount } = timing;
  if (frameCount <= 0) return 0;
  const elapsed = Math.max(0, timing.frameIndex - timing.inFrame);
  const start = Math.min(Math.max(0, Math.trunc(timing.startFrame)), frameCount - 1);
  // floor, not round: a frame is shown from the moment it begins, as in every other NLE.
  const advanced = Math.floor(elapsed * timing.speed);
  const raw = start + advanced;
  if (!timing.loop) return Math.min(Math.max(0, raw), frameCount - 1);
  const wrapped = raw % frameCount;
  return wrapped < 0 ? wrapped + frameCount : wrapped;
}
