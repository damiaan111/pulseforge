// The live preview: a WebGL2 canvas, the engine, the preview clock and the audio element,
// running their own loop (ui-spec §13, PROJECT.md §8.12).
//
// Kept out of React on purpose. Parameter changes reach the engine through the project
// snapshot, and only a throttled summary — transport, time, dropped frames — goes back to the
// store for display. Re-rendering a React tree per frame is the standard way a tool like this
// becomes sluggish.
//
// **The audio is the master clock.** Each tick asks the audio element where it has reached and
// renders that frame. A slow frame skips frames rather than advancing by one, so the preview
// can drop but cannot drift. Everything about that lives in `PreviewClock`; this file is the
// part that talks to the DOM and the GPU.

import { analysisFrameCount } from '../../analysis/spectrum.ts';
import type { AnalysisSet } from '../../engine/core/analysis.ts';
import type { RenderProject } from '../../engine/core/project.ts';
import { frameTimeSeconds, secondsToTicks, ticksToSeconds } from '../../engine/core/time.ts';
import { createEngine, type Engine } from '../../engine/engine.ts';
import { RenderSetupError, ShaderCompileError } from '../../engine/render/gl.ts';
import { toRenderProject, timelineDurationTicks } from '../../project/snapshot.ts';
import type { ProjectDocument } from '../../project/document.ts';
import { PreviewClock, type PreviewStats, type Transport } from '../clock.ts';

/** An analysis set with nothing in it, so the preview runs before any audio is loaded. */
const EMPTY_ANALYSIS: AnalysisSet = { sources: new Map() };

export interface PreviewCallbacks {
  /** Throttled to ~10 Hz: this drives the transport readout, not the render. */
  readonly onStatus: (transport: Transport, timelineSeconds: number, stats: PreviewStats) => void;
  /** A render failure the user must see — a shader that will not compile, a lost context. */
  readonly onError: (message: string) => void;
  /** Warnings and notes from the frame report, deduplicated. */
  readonly onNotes: (notes: readonly string[]) => void;
}

const STATUS_INTERVAL_MS = 100;

export class PreviewHost {
  private readonly canvas: HTMLCanvasElement;
  private readonly audio: HTMLAudioElement;
  private readonly callbacks: PreviewCallbacks;
  private gl: WebGL2RenderingContext | null = null;
  private engine: Engine | null = null;
  private clock: PreviewClock | null = null;

  private document: ProjectDocument | null = null;
  private project: RenderProject | null = null;
  private analysis: AnalysisSet = EMPTY_ANALYSIS;
  private scale = 1;

  private running = false;
  private rafHandle = 0;
  private lastStatus = 0;
  private lastNotes = '';
  private failed = false;
  /**
   * Forces one redraw even though the clock has nothing new to give.
   *
   * The clock only yields a frame when time has moved, which is right for playback and wrong
   * for everything else: a paused editor would show a black canvas until you pressed play, and
   * dragging a slider would change nothing on screen. Editing *is* the common case, so any
   * change to the document, the analysis or the scale sets this.
   */
  private needsRedraw = true;

  constructor(canvas: HTMLCanvasElement, audio: HTMLAudioElement, callbacks: PreviewCallbacks) {
    this.canvas = canvas;
    this.audio = audio;
    this.callbacks = callbacks;
  }

  start(): void {
    if (this.running) return;
    try {
      this.gl = createContext(this.canvas);
      this.engine = createEngine(this.gl, {
        quality: 'preview',
        // flipY off: the blit to screen wants GL's own bottom-up orientation. Export flips,
        // because video wants rows top-down.
        output: { transfer: 'srgb', dither: true, flipY: false, bitDepth: 8 },
      });
    } catch (error) {
      this.failed = true;
      this.callbacks.onError(explain(error));
      return;
    }
    this.running = true;
    this.loop();
  }

  dispose(): void {
    this.running = false;
    if (this.rafHandle !== 0) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = 0;
    this.engine?.dispose();
    this.engine = null;
    this.gl = null;
  }

  /**
   * Hands the host a new document. The snapshot is rebuilt here rather than per frame: it is
   * pure, but it walks every layer, and the engine caches its compiled modulation on the
   * snapshot's identity — so rebuilding each frame would recompile the bindings each frame.
   */
  setDocument(document: ProjectDocument, analysis: AnalysisSet | null): void {
    const analysisChanged = analysis !== null && analysis !== this.analysis;
    if (analysis !== null) this.analysis = analysis;
    const durationChanged = this.document === null
      || timelineDurationTicks(this.document) !== timelineDurationTicks(document)
      || this.document.canvas.fps.num !== document.canvas.fps.num
      || this.document.canvas.fps.den !== document.canvas.fps.den
      || this.document.audio.leadInTicks !== document.audio.leadInTicks
      || this.document.audio.clipInTicks !== document.audio.clipInTicks;

    this.document = document;
    this.project = toRenderProject(document).project;
    this.needsRedraw = true;
    if (durationChanged || this.clock === null || analysisChanged) this.rebuildClock(document);
  }

  setScale(scale: number): void {
    this.scale = Math.min(1, Math.max(0.25, scale));
    this.needsRedraw = true;
  }

  get transport(): Transport {
    return this.clock?.transport ?? 'stopped';
  }

  play(): void {
    const tick = this.clock?.play();
    this.applyAudio(tick);
    if (this.audio.src !== '') void this.audio.play().catch(() => { /* no audio loaded yet */ });
  }

  pause(): void {
    this.applyAudio(this.clock?.pause());
    this.audio.pause();
  }

  stop(): void {
    this.applyAudio(this.clock?.stop());
    this.audio.pause();
  }

  seek(timelineSeconds: number): void {
    this.applyAudio(this.clock?.seek(timelineSeconds));
    this.needsRedraw = true;
  }

  private rebuildClock(document: ProjectDocument): void {
    const durationTicks = timelineDurationTicks(document);
    const clipEnd = document.audio.clipOutTicks ?? document.audio.durationTicks;
    this.clock = new PreviewClock({
      fps: document.canvas.fps,
      durationTicks: Math.max(1, durationTicks),
      placement: { leadInTicks: document.audio.leadInTicks, clipInTicks: document.audio.clipInTicks },
      audioDurationTicks: Math.max(0, clipEnd - document.audio.clipInTicks),
    });
  }

  private applyAudio(tick: { seekAudioTo?: number; pauseAudio?: boolean } | undefined): void {
    if (tick === undefined) return;
    if (tick.seekAudioTo !== undefined && Number.isFinite(tick.seekAudioTo)) {
      this.audio.currentTime = Math.max(0, tick.seekAudioTo);
    }
    if (tick.pauseAudio === true) this.audio.pause();
  }

  private loop = (): void => {
    if (!this.running) return;
    this.rafHandle = requestAnimationFrame(this.loop);
    if (this.failed) return;

    const { engine, gl, clock, project } = this;
    if (engine === null || gl === null || clock === null || project === null) return;

    const tick = clock.tick({ positionSeconds: this.audio.currentTime, playing: !this.audio.paused });
    this.applyAudio(tick);

    // The clock's frame when time moved; otherwise the frame the playhead is already parked on,
    // but only when something asked for a redraw. Idle with nothing changed costs nothing.
    const { fps } = project.canvas;
    const frameIndex = tick.frame !== null
      ? tick.frame.frameIndex
      : Math.max(0, Math.round((clock.timelineSeconds * fps.num) / fps.den));

    if (tick.frame !== null || this.needsRedraw) {
      this.needsRedraw = false;
      try {
        this.renderFrame(engine, gl, project, frameIndex);
      } catch (error) {
        // One bad frame must not become a thousand error toasts a second.
        this.failed = true;
        this.callbacks.onError(explain(error));
        return;
      }
    }

    const now = performance.now();
    if (now - this.lastStatus >= STATUS_INTERVAL_MS) {
      this.lastStatus = now;
      this.callbacks.onStatus(clock.transport, clock.timelineSeconds, clock.stats);
    }
  };

  private renderFrame(engine: Engine, gl: WebGL2RenderingContext, project: RenderProject, frameIndex: number): void {
    // Preview resolution is the project's, scaled. Even dimensions keep it comparable with the
    // export path, which cannot encode an odd one.
    const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
    const scaled: RenderProject = this.scale === 1
      ? project
      : {
        ...project,
        canvas: {
          ...project.canvas,
          width: even(project.canvas.width * this.scale),
          height: even(project.canvas.height * this.scale),
        },
      };

    const report = engine.renderFrame(scaled, this.analysis, frameIndex);

    const notes = [
      ...report.warnings,
      ...report.modulationIssues.map((issue) => `${issue.problem}: ${issue.detail}`),
      ...report.paramIssues.flatMap((p) => p.issues.map((i) => `${p.layerId}.${i.key}: ${i.detail}`)),
    ];
    const key = notes.join('\n');
    if (key !== this.lastNotes) {
      this.lastNotes = key;
      this.callbacks.onNotes(notes);
    }

    // Match the drawing buffer to the element's real pixel size before presenting, or the
    // preview is resampled twice and looks soft for no reason.
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    engine.present(width, height);
  }
}

function createContext(canvas: HTMLCanvasElement): WebGL2RenderingContext {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
  });
  if (gl === null) {
    throw new RenderSetupError(
      'This machine could not create a WebGL2 context.\n\n' +
      'Try:\n• Update the GPU driver\n• On a hybrid-GPU laptop, make sure the NVIDIA GPU is used',
    );
  }
  return gl;
}

/** Shader errors carry the offending source line; never swallow that (PROJECT.md §14). */
function explain(error: unknown): string {
  if (error instanceof ShaderCompileError) return error.message;
  if (error instanceof RenderSetupError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/** Frames the preview can show for a document, for the timeline's extent. */
export function previewFrameCount(document: ProjectDocument): number {
  const seconds = ticksToSeconds(timelineDurationTicks(document));
  const { fps } = document.canvas;
  return Math.max(1, Math.ceil((seconds * fps.num) / fps.den));
}

export { analysisFrameCount, frameTimeSeconds, secondsToTicks };
