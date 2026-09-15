// Preview clock (M31, PROJECT.md §8.12, export-spec §3).
//
// The audio is the master. Each tick the preview asks where the audio has reached and renders
// *that* frame; it never advances time itself. A slow frame therefore skips frames and cannot
// drift — audio and visuals stay locked by construction rather than by periodic correction.
//
// Wall-clock time enters this file for two things only: statistics, and the silent stretches
// where there is no audio to follow (§ lead-in below). It never reaches the engine. The engine
// still receives time as a parameter (CLAUDE.md constraint 1); this module is the one place
// allowed to ask "where are we now", and it answers from the audio wherever audio exists.
//
// Frames are snapped to the project's frame grid by default, so the preview shows exactly the
// frames an export would write — "preview is honest about being a preview" (ui-spec §0.4) means
// lower resolution, not different moments in time.

import {
  frameCount,
  frameTimeSeconds,
  secondsToTicks,
  sourceToTimelineSeconds,
  TICKS_PER_SECOND,
  ticksToSeconds,
  timelineToSourceSeconds,
  type AudioPlacement,
  type Rational,
} from '../engine/core/time.ts';

export type Transport = 'stopped' | 'playing' | 'paused';

export interface PreviewClockOptions {
  readonly fps: Rational;
  /** Full timeline duration, lead-in and lead-out included. */
  readonly durationTicks: number;
  readonly placement: AudioPlacement;
  /** Length of the audible clip, i.e. how much of the timeline actually has sound. */
  readonly audioDurationTicks: number;
  /** Injected for tests; milliseconds, monotonic. Statistics and silent stretches only. */
  readonly now?: () => number;
  /** Snap rendered times to the frame grid (default true). */
  readonly snapToFrameGrid?: boolean;
  /** Rolling window for the rendered-fps figure (default 1000 ms). */
  readonly statsWindowMs?: number;
}

/** What the caller observed on the audio element this tick. */
export interface AudioReading {
  /**
   * Playback position **in the source file**, in seconds — an `<audio>` element's `currentTime`,
   * which counts from the start of the file, not from the clip's in-point. `timelineSeconds`
   * differs from it by both the lead-in and the trim, so never compare the two directly.
   */
  readonly positionSeconds: number;
  /** True only while the element is actually producing sound. */
  readonly playing: boolean;
}

export interface PreviewFrame {
  readonly timelineSeconds: number;
  readonly frameIndex: number;
  /** Frames skipped since the previous rendered frame. Non-zero means the preview fell behind. */
  readonly dropped: number;
  /** Where this frame's time came from — useful in diagnostics when sync looks wrong. */
  readonly source: 'audio' | 'silence' | 'seek';
}

export interface PreviewTick {
  /** Null when there is nothing new to draw: the caller keeps the frame already on screen. */
  readonly frame: PreviewFrame | null;
  /** Set the audio element to this clip position before the next tick (loop wrap, seek). */
  readonly seekAudioTo?: number;
  /** Stop the audio element: the playhead has left the audible stretch, or reached the end. */
  readonly pauseAudio?: boolean;
}

export interface PreviewStats {
  /** Frames actually drawn per second, over the rolling window. */
  readonly renderedFps: number;
  readonly droppedTotal: number;
  /** Dropped within the rolling window — what the UI indicator should show. */
  readonly droppedRecent: number;
  readonly transport: Transport;
}

export interface LoopRegion {
  readonly startSeconds: number;
  readonly endSeconds: number;
}

export class PreviewClock {
  private readonly fps: Rational;
  private readonly placement: AudioPlacement;
  private readonly now: () => number;
  private readonly snap: boolean;
  private readonly statsWindowMs: number;
  private readonly totalFrames: number;
  private readonly durationSeconds: number;
  private readonly audioStartSeconds: number;
  private readonly audioEndSeconds: number;

  private transportState: Transport = 'stopped';
  private position = 0;
  private lastFrameIndex = -1;
  private pendingSeek: number | null = null;
  private loop: LoopRegion | null = null;

  // Wall-clock anchor, re-synced from the audio on every audible tick so that handing over to it
  // at the end of the audio is seamless rather than a jump.
  private anchorWallMs = 0;
  private anchorTimeline = 0;

  private renderedAt: number[] = [];
  private droppedAt: number[] = [];
  private droppedTotalCount = 0;

  constructor(options: PreviewClockOptions) {
    this.fps = options.fps;
    this.placement = options.placement;
    this.now = options.now ?? (() => performance.now());
    this.snap = options.snapToFrameGrid ?? true;
    this.statsWindowMs = options.statsWindowMs ?? 1000;
    this.totalFrames = Math.max(1, frameCount(options.durationTicks, options.fps));
    this.durationSeconds = ticksToSeconds(options.durationTicks);
    this.audioStartSeconds = ticksToSeconds(options.placement.leadInTicks);
    this.audioEndSeconds = this.audioStartSeconds + ticksToSeconds(options.audioDurationTicks);
  }

  get transport(): Transport {
    return this.transportState;
  }

  /** Current playhead in timeline seconds. */
  get timelineSeconds(): number {
    return this.position;
  }

  get stats(): PreviewStats {
    const cutoff = this.now() - this.statsWindowMs;
    const rendered = this.renderedAt.filter((at) => at >= cutoff);
    const dropped = this.droppedAt.filter((at) => at >= cutoff);
    return {
      renderedFps: (rendered.length * 1000) / this.statsWindowMs,
      droppedTotal: this.droppedTotalCount,
      droppedRecent: dropped.length,
      transport: this.transportState,
    };
  }

  /**
   * Clip position for a timeline position — where to put the audio element on a seek.
   * Negative inside the lead-in, past the clip during the lead-out; callers use
   * `audioAudibleAt` to decide whether the element should be playing at all.
   */
  audioPositionFor(timelineSeconds: number): number {
    return timelineToSourceSeconds(timelineSeconds, this.placement);
  }

  audioAudibleAt(timelineSeconds: number): boolean {
    return timelineSeconds >= this.audioStartSeconds && timelineSeconds < this.audioEndSeconds;
  }

  setLoop(loop: LoopRegion | null): void {
    this.loop = loop;
  }

  play(): PreviewTick {
    if (this.transportState === 'playing') return { frame: null };
    // Restart from the top when play is pressed at the end, rather than sitting on the last frame.
    if (this.position >= this.durationSeconds) this.position = 0;
    this.transportState = 'playing';
    this.reanchor(this.position);
    return { seekAudioTo: this.audioPositionFor(this.position), frame: null };
  }

  pause(): PreviewTick {
    if (this.transportState === 'playing') this.transportState = 'paused';
    return { frame: null, pauseAudio: true };
  }

  stop(): PreviewTick {
    this.transportState = 'stopped';
    return this.seek(0);
  }

  /**
   * Move the playhead and render exactly one frame there. Used by the transport, the timeline
   * and scrubbing alike — scrubbing is just a rapid sequence of seeks (ui-spec §3).
   */
  seek(timelineSeconds: number): PreviewTick {
    const clamped = Math.min(Math.max(timelineSeconds, 0), this.durationSeconds);
    this.position = clamped;
    this.pendingSeek = clamped;
    this.reanchor(clamped);
    return {
      seekAudioTo: this.audioPositionFor(clamped),
      pauseAudio: !this.audioAudibleAt(clamped) || this.transportState !== 'playing',
      frame: null,
    };
  }

  /** Step whole frames — arrow keys, frame-accurate checking. */
  stepFrames(delta: number): PreviewTick {
    const index = Math.min(
      Math.max((this.lastFrameIndex < 0 ? this.frameIndexFor(this.position) : this.lastFrameIndex) + delta, 0),
      this.totalFrames - 1,
    );
    return this.seek(frameTimeSeconds(index, this.fps));
  }

  /**
   * One preview tick — call from the render loop with what the audio element currently reports.
   * Returns the frame to draw, or null when the playhead has not reached a new frame yet.
   */
  tick(reading: AudioReading): PreviewTick {
    const wallMs = this.now();

    if (this.pendingSeek !== null) {
      const target = this.pendingSeek;
      this.pendingSeek = null;
      return { frame: this.emit(target, 'seek', wallMs, true) };
    }

    if (this.transportState !== 'playing') return { frame: null };

    let timeline = this.playheadFor(reading, wallMs);
    let seekAudioTo: number | undefined;

    if (this.loop && timeline >= this.loop.endSeconds) {
      timeline = this.loop.startSeconds;
      this.reanchor(timeline);
      seekAudioTo = this.audioPositionFor(timeline);
    } else if (timeline >= this.durationSeconds) {
      // The end is a hard stop on the last frame, not a fade into nothing.
      this.transportState = 'stopped';
      this.position = this.durationSeconds;
      return { frame: this.emit(this.durationSeconds, 'silence', wallMs, true), pauseAudio: true };
    }

    this.position = timeline;
    const source = reading.playing ? 'audio' : 'silence';
    const frame = this.emit(timeline, source, wallMs, false);
    return seekAudioTo === undefined ? { frame } : { frame, seekAudioTo };
  }

  /**
   * Where the playhead is. While the audio sounds, it is the authority and the wall anchor is
   * re-synced to it. During the lead-in and lead-out there is no audio to follow — nothing can
   * drift against silence — so the wall clock carries the playhead, and because the anchor was
   * kept fresh the handover in either direction is continuous.
   */
  private playheadFor(reading: AudioReading, wallMs: number): number {
    if (reading.playing) {
      const timeline = sourceToTimelineSeconds(reading.positionSeconds, this.placement);
      this.reanchor(timeline, wallMs);
      return timeline;
    }
    return this.anchorTimeline + (wallMs - this.anchorWallMs) / 1000;
  }

  private reanchor(timelineSeconds: number, wallMs = this.now()): void {
    this.anchorTimeline = timelineSeconds;
    this.anchorWallMs = wallMs;
  }

  /**
   * Frame containing a playhead position, via integer ticks.
   *
   * The obvious `floor(t · fps)` is float-fragile exactly where it matters: at t = 3 + 1/60,
   * `t * 60` is 180.99999999999997, so a position sitting precisely on a frame boundary lands
   * one frame low and the tick renders nothing. Rounding to ticks first (1/48000 s, ~800× finer
   * than a 60 fps frame) puts the position on the grid before the division, so boundaries are
   * exact and the arithmetic is integer — the same reasoning as export-spec §2, one level up.
   */
  private frameIndexFor(timelineSeconds: number): number {
    const ticks = secondsToTicks(timelineSeconds);
    const raw = Math.floor((ticks * this.fps.num) / (TICKS_PER_SECOND * this.fps.den));
    return Math.min(Math.max(raw, 0), this.totalFrames - 1);
  }

  /**
   * Turn a playhead position into a frame to draw, or null when it is the frame already on
   * screen. `dropped` counts the frames stepped over — the preview never renders them, which is
   * the whole point: falling behind costs frames, never sync.
   */
  private emit(
    timelineSeconds: number,
    source: PreviewFrame['source'],
    wallMs: number,
    force: boolean,
  ): PreviewFrame | null {
    const frameIndex = this.frameIndexFor(timelineSeconds);
    if (!force && frameIndex === this.lastFrameIndex) return null;

    const dropped = force || this.lastFrameIndex < 0 ? 0 : Math.max(0, frameIndex - this.lastFrameIndex - 1);
    this.lastFrameIndex = frameIndex;

    this.renderedAt.push(wallMs);
    for (let i = 0; i < dropped; i += 1) this.droppedAt.push(wallMs);
    this.droppedTotalCount += dropped;
    this.trimStats(wallMs);

    return {
      timelineSeconds: this.snap ? frameTimeSeconds(frameIndex, this.fps) : timelineSeconds,
      frameIndex,
      dropped,
      source,
    };
  }

  private trimStats(wallMs: number): void {
    const cutoff = wallMs - this.statsWindowMs;
    if (this.renderedAt.length > 0 && this.renderedAt[0]! < cutoff) {
      this.renderedAt = this.renderedAt.filter((at) => at >= cutoff);
    }
    if (this.droppedAt.length > 0 && this.droppedAt[0]! < cutoff) {
      this.droppedAt = this.droppedAt.filter((at) => at >= cutoff);
    }
  }
}
