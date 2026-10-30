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
import type { DecodedImage } from '../../engine/core/image.ts';
import { CanvasTextRasterizer } from '../../text/canvas-rasterizer.ts';
import { VideoFrameFeeder } from '../../video/frame-feeder.ts';
import type { RenderProject } from '../../engine/core/project.ts';
import { frameCount, frameTimeSeconds, secondsToTicks, TICKS_PER_SECOND, ticksToSeconds } from '../../engine/core/time.ts';
import { createEngine, type Engine } from '../../engine/engine.ts';
import { MilkdropRenderer } from '../../milkdrop/renderer.ts';
import { loadPreset } from '../milkdrop.ts';
import type { ModuleDefinition } from '../../engine/core/module.ts';
import type { ModulationIssue } from '../../engine/core/modulation.ts';
import type { ParamValue } from '../../engine/core/params.ts';
import { RenderSetupError, ShaderCompileError } from '../../engine/render/gl.ts';
import { toRenderProject, timelineDurationTicks } from '../../project/snapshot.ts';
import type { ProjectDocument } from '../../project/document.ts';
import { PreviewClock, type PreviewStats, type Transport } from '../clock.ts';
import type { GpuFrameTimings } from '../../engine/render/gpu-profiler.ts';
import { parseCube } from '../../engine/core/lut.ts';
import { previewRenderSize } from './render-size.ts';
import { clipLevel } from '../../project/audio-clip.ts';

/** An analysis set with nothing in it, so the preview runs before any audio is loaded. */
const EMPTY_ANALYSIS: AnalysisSet = { sources: new Map() };

export interface PreviewCallbacks {
  /** Throttled to ~10 Hz: this drives the transport readout, not the render. */
  readonly onStatus: (transport: Transport, timelineSeconds: number, stats: PreviewStats) => void;
  /** A render failure the user must see — a shader that will not compile, a lost context. Null clears it. */
  readonly onError: (message: string | null) => void;
  /** Warnings and notes from the frame report, deduplicated. */
  readonly onNotes: (notes: readonly string[]) => void;
  /**
   * What modulation is doing, from the last rendered frame: each modulated parameter's rendered
   * value, each binding's live level, and the bindings that could not be compiled. Throttled with
   * `onStatus` — this drives meters, not the render (ui-spec §13).
   */
  readonly onModulation?: (live: LiveModulation) => void;
  /**
   * The performance HUD (S12): GPU time per top-level layer, from the latest frame whose times are
   * in, while profiling is on. Throttled with `onStatus`. `available` false: timer queries are not
   * exposed here, and the HUD says so.
   */
  readonly onGpuTimings?: (timings: GpuFrameTimings | null, available: boolean) => void;
}

export interface LiveModulation {
  readonly values: ReadonlyMap<string, ParamValue>;
  readonly levels: ReadonlyMap<string, number>;
  readonly issues: readonly ModulationIssue[];
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
  private draft = false;
  private images: ReadonlyMap<string, DecodedImage> = new Map();
  /**
   * Glyph rasterisation for text layers. Created here and handed to the engine at startup, because
   * `createEngine` takes it once; fonts are registered into it as their bytes arrive, and a text
   * layer says "fonts are still loading" until the default one is in.
   */
  private readonly text = new CanvasTextRasterizer();
  private readonly milkdrop = new MilkdropRenderer();
  private loopRegion: { readonly startSeconds: number; readonly endSeconds: number } | null = null;
  private readonly registeredFonts = new Set<string>();
  /**
   * Video frames (M39), read from the preview proxy over IPC. Created with the engine. A frame the
   * feeder has not uploaded yet is never faked: the loop holds the previous picture and redraws
   * when it arrives, so the preview shows late frames but never wrong ones.
   */
  private feeder: VideoFrameFeeder | null = null;
  private videoSequences: readonly { hash: string; frameCount: number }[] = [];
  private fetching: Promise<void> | null = null;
  private userModules: readonly ModuleDefinition[] = [];
  /** A second engine on the same context for stills — preset thumbnails (S8). Created on first use. */
  private stills: Engine | null = null;

  private running = false;
  private rafHandle = 0;
  private lastStatus = 0;
  private live: LiveModulation | null = null;
  private liveSent: LiveModulation | null = null;
  private profiling = false;
  private luts: ReadonlyMap<string, string> = new Map();
  private timingsSent: GpuFrameTimings | null = null;
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
  private rate = 1;

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
        text: this.text,
        milkdrop: this.milkdrop,
        // flipY off: the blit to screen wants GL's own bottom-up orientation. Export flips,
        // because video wants rows top-down.
        output: { transfer: 'srgb', dither: true, flipY: false, bitDepth: 8 },
      });
    } catch (error) {
      this.failed = true;
      this.callbacks.onError(explain(error));
      return;
    }
    this.feeder = new VideoFrameFeeder(this.engine, (hash, sourceFrame) =>
      window.pulseforge.videoFrame(hash, this.document?.canvas.fps ?? { num: 60, den: 1 }, sourceFrame));
    this.feeder.setSequences(this.videoSequences);
    this.engine.addModules(this.userModules);
    this.engine.setProfiling(this.profiling);
    this.engine.setQuality(this.draft ? 'draft' : 'preview');
    this.registerLuts();
    this.running = true;
    this.uploadImages();
    this.loop();
  }

  dispose(): void {
    this.running = false;
    if (this.rafHandle !== 0) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = 0;
    this.feeder?.dispose();
    this.feeder = null;
    this.stills?.dispose();
    this.stills = null;
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
    // A frame that failed stopped the loop for good, so undoing the edit that broke it left the
    // preview dead until a restart. A changed document gets another try (a context that could
    // not be created at all is a different failure and stays failed — there is no engine).
    if (this.failed && this.engine !== null) {
      this.failed = false;
      this.callbacks.onError(null);
    }
    if (durationChanged || this.clock === null || analysisChanged) this.rebuildClock(document);
  }

  /**
   * Decoded image assets by hash. Uploaded once each; the engine keeps them across documents, so
   * undoing an image change back and forth never re-uploads. Applied again on start, in case the
   * images arrived before the context did.
   */
  setImages(images: ReadonlyMap<string, DecodedImage>): void {
    this.images = images;
    this.uploadImages();
  }

  private uploadImages(): void {
    const { engine } = this;
    if (engine === null) return;
    let added = false;
    for (const [hash, image] of this.images) {
      if (engine.hasImage(hash)) continue;
      try {
        engine.setImage(hash, image);
        added = true;
      } catch (error) {
        // Too large for this GPU, say: the layer shows its placeholder and the user is told why.
        this.callbacks.onError(explain(error));
      }
    }
    if (added) this.needsRedraw = true;
  }

  /**
   * Registers font bytes with the rasteriser. Asynchronous (a FontFace has to be parsed), so each
   * one asks for a redraw as it lands rather than blocking the preview loop.
   */
  setFonts(defaultFont: { hash: string; bytes: Uint8Array } | null, fonts: ReadonlyMap<string, Uint8Array>, fallbacks: readonly { readonly hash: string; readonly bytes: Uint8Array }[]): void {
    const register = async (hash: string, bytes: Uint8Array, kind: 'default' | 'font' | 'fallback') => {
      if (this.registeredFonts.has(hash)) return;
      this.registeredFonts.add(hash);
      try {
        if (kind === 'default') await this.text.setDefaultFont(hash, bytes);
        else if (kind === 'font') await this.text.addFont(hash, bytes);
        else await this.text.addFallbackFont(hash, bytes);
        this.needsRedraw = true;
      } catch (error) {
        this.registeredFonts.delete(hash);
        this.callbacks.onError(`A font could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    // The default last, in chain order before it: text is drawn from the moment the default is in,
    // and a line rasterised before its fallback landed would stay a row of boxes in the layer's cache.
    void (async () => {
      for (const font of fallbacks) await register(font.hash, font.bytes, 'fallback');
      if (defaultFont !== null) await register(defaultFont.hash, defaultFont.bytes, 'default');
    })();
    for (const [hash, bytes] of fonts) void register(hash, bytes, 'font');
  }

  /**
   * LUT assets (S11): each .cube text parsed once and registered under its hash. Kept, so an engine
   * made later (start) gets them too. A table that does not parse is reported, not dropped silently —
   * the LUT effect then says the LUT is not loaded and passes the picture through.
   */
  setLuts(luts: ReadonlyMap<string, string>): void {
    this.luts = luts;
    this.registerLuts();
  }

  private registerLuts(): void {
    const engine = this.engine;
    if (engine === null) return;
    for (const [hash, text] of this.luts) {
      if (engine.hasLut(hash)) continue;
      try {
        engine.setLut(hash, parseCube(text));
        this.needsRedraw = true;
      } catch (error) {
        this.callbacks.onError(`A LUT could not be read: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * Drop-in modules (M35). Registered with the engine, which replaces a module it already has — so
   * an edited shader recompiles on the next frame, and one that no longer compiles is skipped and
   * reported rather than taking the preview down.
   */
  setModules(definitions: readonly ModuleDefinition[]): void {
    this.userModules = definitions;
    this.engine?.addModules(definitions);
    this.stills?.addModules(definitions);
    this.needsRedraw = true;
  }

  /** The prepared proxies: which clips have frames, and how many. */
  setVideos(sequences: readonly { hash: string; frameCount: number }[]): void {
    this.videoSequences = sequences;
    this.feeder?.setSequences(sequences);
    this.needsRedraw = true;
  }

  /** The performance HUD (S12): time each layer on the GPU while it is open. */
  setProfiling(on: boolean): void {
    this.profiling = on;
    this.engine?.setProfiling(on);
    this.timingsSent = null;
    // A stopped preview must still render a frame for there to be anything to time.
    this.needsRedraw = true;
    if (on) this.callbacks.onGpuTimings?.(null, this.engine?.profiling.available ?? false);
  }

  /**
   * Draft mode (S18): a fixed low resolution and the engine's 'draft' quality, where expensive
   * modules approximate (fewer DOF samples, no MSAA on 3D scenes). Export is never affected.
   */
  setDraft(on: boolean): void {
    this.draft = on;
    this.engine?.setQuality(on ? 'draft' : 'preview');
    this.needsRedraw = true;
  }

  setScale(scale: number): void {
    this.scale = Math.min(1, Math.max(0.25, scale));
    this.needsRedraw = true;
  }

  get transport(): Transport {
    return this.clock?.transport ?? 'stopped';
  }

  play(): void {
    const clock = this.clock;
    const tick = clock?.play();
    this.applyAudio(tick);
    // Only when the playhead is inside the clip. In the lead-in the clock starts the element
    // itself when the clip begins (`playAudio`); starting it here skipped the silence.
    if (clock !== null && clock.audioAudibleAt(clock.timelineSeconds)) this.startAudio();
  }

  private startAudio(): void {
    if (this.audio.getAttribute('src') !== null) void this.audio.play().catch(() => { /* no audio loaded yet */ });
  }

  pause(): void {
    this.applyAudio(this.clock?.pause());
    this.audio.pause();
  }

  /** Loads the MilkDrop presets a document uses, and draws again as each lands. */
  needMilkdrop(names: Iterable<string>): void {
    for (const name of names) {
      if (this.milkdrop.hasPreset(name)) continue;
      void loadPreset(name).then((found) => {
        if (found) this.needsRedraw = true;
      });
    }
  }

  /** Kept, so a clock made later (a new track) loops too. */
  setLoop(loop: { readonly startSeconds: number; readonly endSeconds: number } | null): void {
    this.loopRegion = loop;
    this.clock?.setLoop(loop);
  }

  /** Playback speed for tapping (lyrics-spec §3). Pitch is preserved by the element. */
  setRate(rate: number): void {
    this.rate = Math.min(4, Math.max(0.1, rate));
    this.clock?.setRate(this.rate);
    this.audio.playbackRate = this.rate;
  }

  get playbackRate(): number {
    return this.rate;
  }

  /** The playhead now, unsnapped — what a tap measures against. */
  positionNow(): number {
    return this.clock?.positionAt({ positionSeconds: this.audio.currentTime, playing: !this.audio.paused }) ?? 0;
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
    const previous = this.clock;
    this.clock = new PreviewClock({
      fps: document.canvas.fps,
      durationTicks: Math.max(1, durationTicks),
      placement: { leadInTicks: document.audio.leadInTicks, clipInTicks: document.audio.clipInTicks },
      audioDurationTicks: Math.max(0, clipEnd - document.audio.clipInTicks),
    });
    this.clock.setRate(this.rate);
    this.clock.setLoop(this.loopRegion);
    if (previous !== null) {
      // A new clock starts stopped at 0. Keep the playhead where it was; a clock that was playing
      // is paused, with the element, rather than left "stopped" while the audio plays on.
      if (previous.transport === 'playing') this.audio.pause();
      this.applyAudio(this.clock.seek(previous.timelineSeconds));
    }
  }

  private applyAudio(tick: { seekAudioTo?: number; pauseAudio?: boolean; playAudio?: boolean } | undefined): void {
    if (tick === undefined) return;
    if (tick.seekAudioTo !== undefined && Number.isFinite(tick.seekAudioTo)) {
      this.audio.currentTime = Math.max(0, tick.seekAudioTo);
    }
    if (tick.pauseAudio === true) this.audio.pause();
    if (tick.playAudio === true) this.startAudio();
  }

  /**
   * The clip's gain and fades on the element (M29), from the same `clipLevel` the export multiplies
   * samples by, so the fade you hear is the fade that renders. An element's volume stops at 1, so a
   * gain above unity is exported but not previewed louder.
   */
  private applyLevel(): void {
    const audio = this.document?.audio;
    if (audio === undefined) return;
    const clipIn = audio.clipInTicks;
    const clipEnd = audio.clipOutTicks ?? audio.durationTicks;
    const clipSample = this.audio.currentTime * TICKS_PER_SECOND - clipIn;
    const volume = Math.min(1, Math.max(0, clipLevel(audio, clipSample, Math.max(0, clipEnd - clipIn))));
    // Only on change: assigning volume every frame is cheap but fires a volumechange each time.
    if (Math.abs(this.audio.volume - volume) > 1e-3) this.audio.volume = volume;
  }

  private loop = (): void => {
    if (!this.running) return;
    this.rafHandle = requestAnimationFrame(this.loop);
    if (this.failed) return;

    const { engine, gl, clock, project } = this;
    if (engine === null || gl === null || clock === null || project === null) return;

    const tick = clock.tick({ positionSeconds: this.audio.currentTime, playing: !this.audio.paused });
    this.applyAudio(tick);
    this.applyLevel();

    // The clock's frame when time moved; otherwise the frame the playhead is already parked on,
    // but only when something asked for a redraw. Idle with nothing changed costs nothing.
    // The parked frame uses the clock's own rule (floor on the tick grid, clamped to the last
    // frame). Rounding showed the *next* frame from the second half of a frame on, and at the
    // very end asked for a frame one past the timeline.
    const { fps } = project.canvas;
    const lastFrame = Math.max(0, frameCount(project.durationTicks ?? 0, fps) - 1);
    const frameIndex = tick.frame !== null
      ? tick.frame.frameIndex
      : Math.min(lastFrame, Math.max(0, Math.floor((secondsToTicks(clock.timelineSeconds) * fps.num) / (TICKS_PER_SECOND * fps.den))));

    // A clip's frame must be on the GPU before the frame that needs it is drawn. If it is not,
    // fetch it and skip this tick — during playback that is a dropped frame, which the preview is
    // allowed; drawing the wrong video frame is not.
    const feeder = this.feeder;
    if ((tick.frame !== null || this.needsRedraw) && feeder !== null && !feeder.ready(project, frameIndex)) {
      if (this.fetching === null) {
        this.fetching = feeder.ensure(project, frameIndex)
          .catch((error: unknown) => this.callbacks.onError(`A video frame could not be read: ${error instanceof Error ? error.message : String(error)}`))
          .finally(() => {
            this.fetching = null;
            this.needsRedraw = true;
          });
        if (clock.transport === 'playing') feeder.prefetch(project, frameIndex + 1, 12);
      }
      return;
    }

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
      if (this.live !== null && this.live !== this.liveSent) {
        this.liveSent = this.live;
        this.callbacks.onModulation?.(this.live);
      }
      if (this.profiling && engine !== null) {
        const timings = engine.gpuTimings();
        if (timings !== this.timingsSent) {
          this.timingsSent = timings;
          this.callbacks.onGpuTimings?.(timings, engine.profiling.available);
        }
      }
    }
  };

  /**
   * Renders frames of a separate project on this host's context — preset thumbnails (S8).
   *
   * A second engine, so nothing about the preview changes: its output, its compiled bindings and
   * its layer instances stay as they were. It shares what makes a picture right — the context, the
   * fonts, the decoded images and the drop-in modules — so a thumbnail draws exactly what the
   * preview would. Final quality, no dither, rows top-down. Null before the context exists.
   */
  renderStills(project: RenderProject, analysis: AnalysisSet, frames: readonly number[]): Uint8Array[] | null {
    if (this.gl === null || this.failed) return null;
    if (this.stills === null) {
      this.stills = createEngine(this.gl, {
        quality: 'final',
        text: this.text,
        // A final render replays MilkDrop from the first frame, which on this thread would freeze
        // the studio for a picture deep in a song. A still can jump and settle, as the preview does.
        milkdrop: {
          hasPreset: (name) => this.milkdrop.hasPreset(name),
          frame: (request) => this.milkdrop.frame({ ...request, exact: false }),
          release: (owner) => this.milkdrop.release(owner),
        },
        output: { transfer: 'srgb', dither: false, flipY: true, bitDepth: 8 },
      });
      this.stills.addModules(this.userModules);
    }
    const stills = this.stills;
    for (const [hash, image] of this.images) {
      if (!stills.hasImage(hash)) stills.setImage(hash, image);
    }
    const out: Uint8Array[] = [];
    for (const frame of frames) {
      stills.renderFrame(project, analysis, frame);
      const bytes = new Uint8Array(project.canvas.width * project.canvas.height * 4);
      stills.readOutputSync(bytes);
      out.push(bytes);
    }
    // The preview's own picture is untouched, but its canvas may need presenting again.
    this.needsRedraw = true;
    return out;
  }

  private renderFrame(engine: Engine, gl: WebGL2RenderingContext, project: RenderProject, frameIndex: number): void {
    // Preview resolution is the project's, scaled. Even dimensions keep it comparable with the
    // export path, which cannot encode an odd one.
    // The quality scale, capped in draft mode (S18) — render-size.ts, shared with the badge and HUD.
    const size = previewRenderSize(project.canvas, this.scale, this.draft);
    const scaled: RenderProject = size.width === project.canvas.width && size.height === project.canvas.height
      ? project
      : { ...project, canvas: { ...project.canvas, ...size } };

    const report = engine.renderFrame(scaled, this.analysis, frameIndex);
    this.live = { values: report.modulatedValues, levels: report.bindingLevels, issues: report.modulationIssues };

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
