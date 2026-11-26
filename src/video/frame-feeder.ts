// Feeding video frames to the engine (M39).
//
// The engine draws whatever frame it was last given, and `videoSourceFrame` says which one that
// should be. This is the piece in between: for a given timeline frame it works out every clip's
// source frame, fetches the still from the frame cache, decodes it and uploads it.
//
// It is host-agnostic on purpose — `readFrame` is injected. In the export renderer that reads the
// file directly; in the sandboxed studio it goes over IPC. Both then share this decode, upload and
// caching behaviour, so preview and export cannot drift apart in what they show.
//
// Decoding uses `createImageBitmap`, which is asynchronous. Export **awaits** it before rendering,
// so the exported frame is always the right one. The preview cannot await inside its render loop,
// so it asks `ready()` first and holds the previous picture until the frames arrive — showing a
// stale frame would be a preview that lies about content, which is worse than a late one.

import type { Engine } from '../engine/engine.ts';
import type { AnyLayerSpec, RenderProject } from '../engine/core/project.ts';
import { isGroupSpec } from '../engine/core/project.ts';
import { videoSourceFrame } from '../engine/core/video.ts';
import { videoPlayback } from '../engine/modules/video.ts';
import { ticksToSeconds } from '../engine/core/time.ts';

export interface VideoSequenceRef {
  readonly hash: string;
  readonly frameCount: number;
}

export interface FrameRequest {
  readonly hash: string;
  readonly sourceFrame: number;
}

/** Reads one still from the frame cache: JPEG bytes as stored. */
export type ReadFrame = (hash: string, sourceFrame: number) => Promise<Uint8Array>;

/**
 * Which source frame every video layer needs for this timeline frame. Walks groups too, and
 * de-duplicates: two layers using one clip at the same moment need one decode, not two.
 */
export function videoRequests(
  project: RenderProject,
  frameIndex: number,
  frameCountOf: (hash: string) => number,
): FrameRequest[] {
  const { fps } = project.canvas;
  const requests = new Map<string, FrameRequest>();

  const visit = (layers: readonly AnyLayerSpec[]): void => {
    for (const layer of layers) {
      if (!layer.enabled) continue;
      if (isGroupSpec(layer)) {
        visit(layer.children);
        continue;
      }
      if (layer.module !== 'core.source.video') continue;
      const assetId = layer.params['video'];
      if (typeof assetId !== 'string' || assetId === '') continue;
      const ref = project.assets?.[assetId];
      if (ref === undefined || ref.kind !== 'video') continue;
      const frameCount = frameCountOf(ref.hash);
      if (frameCount <= 0) continue;

      const playback = videoPlayback(layer.params, fps);
      const sourceFrame = videoSourceFrame({
        frameIndex,
        inFrame: layer.timeRange === undefined ? 0 : Math.round((ticksToSeconds(layer.timeRange.inTicks) * fps.num) / fps.den),
        startFrame: playback.startFrame,
        speed: playback.speed,
        loop: playback.loop,
        frameCount,
      });
      requests.set(`${ref.hash}:${sourceFrame}`, { hash: ref.hash, sourceFrame });
    }
  };
  visit(project.layers);
  return [...requests.values()];
}

/** Decoded and uploaded frames, so scrubbing back and forth within a window costs nothing. */
const CACHE_LIMIT = 8;

export class VideoFrameFeeder {
  private readonly engine: Engine;
  private readonly readFrame: ReadFrame;
  private readonly counts = new Map<string, number>();
  /** `hash:frame` → the decode in flight or finished; bounded, oldest evicted. */
  private readonly decoded = new Map<string, Promise<ImageBitmap>>();
  /** What is currently uploaded per clip, so the same frame is not re-uploaded every render. */
  private readonly uploaded = new Map<string, number>();

  constructor(engine: Engine, readFrame: ReadFrame) {
    this.engine = engine;
    this.readFrame = readFrame;
  }

  /** Declares the extracted sequences. Call before rendering; the engine needs the lengths. */
  setSequences(sequences: readonly VideoSequenceRef[]): void {
    for (const sequence of sequences) {
      this.counts.set(sequence.hash, sequence.frameCount);
      this.engine.setVideoSequence(sequence.hash, sequence.frameCount);
    }
  }

  frameCount(hash: string): number {
    return this.counts.get(hash) ?? 0;
  }

  requestsFor(project: RenderProject, frameIndex: number): FrameRequest[] {
    return videoRequests(project, frameIndex, (hash) => this.frameCount(hash));
  }

  /** True when every clip already has the right frame on the GPU — nothing to wait for. */
  ready(project: RenderProject, frameIndex: number): boolean {
    return this.requestsFor(project, frameIndex).every((r) => this.uploaded.get(r.hash) === r.sourceFrame);
  }

  /** Fetches, decodes and uploads everything this timeline frame needs. Export awaits this. */
  async ensure(project: RenderProject, frameIndex: number): Promise<void> {
    for (const request of this.requestsFor(project, frameIndex)) {
      if (this.uploaded.get(request.hash) === request.sourceFrame) continue;
      const bitmap = await this.decode(request);
      this.engine.setVideoFrame(request.hash, request.sourceFrame, bitmap);
      this.uploaded.set(request.hash, request.sourceFrame);
    }
  }

  /** Starts decoding the frames the next `count` timeline frames will need. Fire and forget. */
  prefetch(project: RenderProject, frameIndex: number, count: number): void {
    for (let i = 0; i < count; i += 1) {
      for (const request of this.requestsFor(project, frameIndex + i)) {
        void this.decode(request).catch(() => {
          // A failed prefetch is retried by `ensure`, which reports it properly.
        });
      }
    }
  }

  private decode(request: FrameRequest): Promise<ImageBitmap> {
    const key = `${request.hash}:${request.sourceFrame}`;
    const existing = this.decoded.get(key);
    if (existing !== undefined) return existing;
    const pending = this.readFrame(request.hash, request.sourceFrame)
      .then(async (bytes) => createImageBitmap(new Blob([bytes as unknown as BlobPart])));
    this.decoded.set(key, pending);
    // Bounded: a long render would otherwise hold every frame it ever decoded.
    while (this.decoded.size > CACHE_LIMIT) {
      const oldest = this.decoded.keys().next().value;
      if (oldest === undefined) break;
      const dropped = this.decoded.get(oldest);
      this.decoded.delete(oldest);
      void dropped?.then((bitmap) => bitmap.close()).catch(() => {});
    }
    return pending;
  }

  dispose(): void {
    for (const pending of this.decoded.values()) void pending.then((b) => b.close()).catch(() => {});
    this.decoded.clear();
    this.uploaded.clear();
  }
}
