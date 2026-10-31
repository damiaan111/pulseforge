// Studio state (ui-spec §10, §13).
//
// Two rules shape this file:
//
//  1. **Every project mutation goes through the command stack.** The `History` instance is the
//     source of truth for the document; the store mirrors it so React can render, and bumps
//     `version` so components re-render. There is no path that edits the document directly —
//     if there were, undo would develop holes.
//  2. **Selection and panel state never enter history.** Undoing a selection change is
//     maddening (ui-spec §10), so they live here and only here.
//
// The preview loop and the WebGL context are deliberately *not* in this store. Re-rendering a
// React tree per frame is the standard way these tools become sluggish (ui-spec §13), so the
// host owns its own rAF loop and pushes a throttled summary in.

import { milkdropIndex } from './milkdrop.ts';
import { create } from 'zustand';

import { decodeAnalysis } from '../analysis/container.ts';
import { decodePeaks, type PeakPyramid } from '../analysis/peaks.ts';
import { stemsForModel } from '../analysis/stem-models.ts';
import type { AnalysisSet } from '../engine/core/analysis.ts';
import type { Section as AnalysisSection } from '../analysis/sections.ts';
import { withAbsolutePaths, withStoredPaths } from '../project/asset-paths.ts';
import { setBeatRefinement,
  addAsset, addLayer, findAssetByHash, relinkAsset, renameProject, sequence, setStemModel, type EditTarget,
} from '../project/commands.ts';
import { createDocument, createModuleLayer } from '../project/create.ts';
import { timelineDurationTicks, toRenderProject } from '../project/snapshot.ts';
import { frameCount } from '../engine/core/time.ts';
import { videoFramesNeeded } from '../engine/modules/video.ts';
import type { AssetRef, ModulationBinding, ProjectDocument } from '../project/document.ts';
import type { DecodedImage } from '../engine/core/image.ts';
import { newId } from '../project/ids.ts';
import { History, type Command } from '../project/history.ts';
import { loadDocument } from '../project/load.ts';
import { ProjectFormatError, ProjectVersionError, type DocumentIssue } from '../project/parse.ts';
import { stringifyDocument } from '../project/serialize.ts';
import type { AnalysisPayload, ImageBytes, LibraryListing, PresetLibraryListing, RecoveryCandidate, RenderJob, StemProgressEvent } from '../shell/ipc.ts';
import type { ShaderModuleSource } from '../engine/modules/shader-module.ts';
import { detectLyricsFormat, exportLyrics as exportLyricsText, importLyricsFile, type LyricsExportFormat } from '../lyrics/formats.ts';
import type { TapSession } from '../lyrics/tap.ts';
import type { BeatRefinementState } from '../analysis/beat-refinement.ts';
import type { LoopState } from './loop-region.ts';
import { extendSelection } from './layer-selection.ts';
import { applyAlignment, importLyrics, lyricsToText, setLyricsText, setTranscribedLyrics } from '../project/lyrics-commands.ts';
import { detectVocalSegments, uncoveredSinging } from '../lyrics/vocal-segments.ts';
import { TICKS_PER_SECOND, sourceToTimelineSeconds } from '../engine/core/time.ts';
import type { LyricsAlignMode, LyricsAlignProgress, UserSettings } from '../shell/ipc.ts';
import type { BatchStatus, QueueFinishedEvent } from '../shell/ipc.ts';
import type { GpuFrameTimings } from '../engine/render/gpu-profiler.ts';
import type { ModuleFolderProblem } from '../modules-folder/scan.ts';
import { loadTemplates as loadTemplateLibrary, type LoadedTemplate, type TemplateProblem } from '../director/template-library.ts';
import type { DirectorLock } from '../project/document.ts';
import type { PreviewStats, Transport } from './clock.ts';
import type { LiveModulation } from './preview/host.ts';

/** The one history for the open project. Module-level: there is exactly one document. */
export const history = new History(createDocument({ name: 'Untitled' }));

/** A structural section of the loaded track, as analysed (sections.ts): label and mean energy. */
export type Section = AnalysisSection;

export interface AudioState {
  readonly path: string;
  /** Blob URL for the audio element. Revoked when replaced. */
  readonly url: string;
  readonly durationSeconds: number;
}

export type AnalysisState = 'idle' | 'working' | 'ready' | 'error';

export interface Toast {
  readonly text: string;
  readonly kind: 'ok' | 'warn' | 'bad';
}

/** The loaded track's stems (M5), as the Audio panel shows them. */
export interface StemsState {
  /** none: never separated · running: separating now · ready: all four · failed: last attempt failed. */
  readonly state: 'none' | 'running' | 'ready' | 'failed';
  readonly ready: readonly string[];
  readonly fraction: number;
  readonly stage: StemProgressEvent['stage'] | null;
  readonly detail: string | null;
  /** Why the last attempt failed, or which stems are missing. */
  readonly message: string | null;
}

const NO_STEMS: StemsState = { state: 'none', ready: [], fraction: 0, stage: null, detail: null, message: null };

/** The mix's analysis with every ready stem merged in, so stem bindings and `source` params work. */
function analysisFromPayload(payload: AnalysisPayload): AnalysisSet {
  const { analysis } = decodeAnalysis(payload.container);
  if (payload.stems.length === 0) return analysis;
  const sources = new Map(analysis.sources);
  for (const stem of payload.stems) {
    for (const [name, source] of decodeAnalysis(stem.container).analysis.sources) sources.set(name, source);
  }
  return { ...analysis, sources };
}

function stemsFromPayload(payload: AnalysisPayload, model: string): StemsState {
  const ready = payload.stems.map((s) => s.name);
  const complete = stemsForModel(model).every((stem) => ready.includes(stem));
  const failed = Object.entries(payload.stemStatus).filter(([, entry]) => entry.state === 'failed');
  const pending = Object.values(payload.stemStatus).some((entry) => entry.state === 'pending');
  if (complete) return { ...NO_STEMS, state: 'ready', ready };
  if (failed.length > 0) {
    return { ...NO_STEMS, state: 'failed', ready, message: failed.map(([name, entry]) => `${name}: ${entry.error ?? 'failed'}`).join('; ') };
  }
  // "pending" in the cache with nothing running here means a separation was interrupted.
  return { ...NO_STEMS, state: 'none', ready, message: pending ? 'A previous separation did not finish.' : null };
}

export interface StudioState {
  /** Bumped on every document mutation; components read it to know they must re-render. */
  version: number;
  document: ProjectDocument;
  path: string | null;
  issues: readonly DocumentIssue[];
  migratedFrom: number | null;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | undefined;
  redoLabel: string | undefined;

  // UI-only, never undoable.
  /** The layer the inspector edits. */
  selectedLayerId: string | null;
  /** Everything selected, the inspector's layer among them. May hold ids since undone: check against the document. */
  selectedLayerIds: readonly string[];
  /** Ctrl and Shift on a layer; `order` is the list as it is shown. */
  extendLayerSelection(id: string, mode: 'toggle' | 'range', order: readonly string[]): void;
  /** Which aspect edits are written to (D44). 'base' edits the layer itself. */
  editTarget: EditTarget;
  /** Render scale for the preview, 0.25-1. Lower is grainier, never different (ui-spec §0.4). */
  previewScale: number;
  toast: Toast | null;

  audio: AudioState | null;
  analysis: AnalysisSet | null;
  peaks: PeakPyramid | null;
  sections: readonly Section[];
  /** Detected onsets of the loaded track, source seconds (the director's drop placement). */
  onsetTimes: readonly number[];
  analysisState: AnalysisState;
  analysisMessage: string | null;

  // Mirrored from the preview host, throttled.
  transport: Transport;
  timelineSeconds: number;
  stats: PreviewStats | null;

  /**
   * Decoded image assets by content hash, for the preview. Not in the document: the document
   * records which file, this holds the pixels, and the pixels are never undoable state.
   */
  images: ReadonlyMap<string, DecodedImage>;
  /** Per asset id: loaded, missing, changed on disk, or unreadable — shown, never silent (M40). */
  assetStatus: Readonly<Record<string, AssetStatus>>;
  /** Font file bytes by content hash, for the preview's text rasteriser. */
  fonts: ReadonlyMap<string, Uint8Array>;
  /** .cube texts by content hash (S11), registered into the preview by the host. */
  luts: ReadonlyMap<string, string>;
  importLut(): Promise<AssetRef | null>;
  /** The bundled default typeface; null until loaded at startup. */
  defaultFont: { readonly hash: string; readonly bytes: Uint8Array } | null;
  /** The preview's loop region (I, O, L), which is not part of the project. */
  loop: LoopState | null;
  setLoop(loop: LoopState | null): void;
  /** Stems drawn on the timeline. */
  stemRows: boolean;
  setStemRows(on: boolean): void;
  /** The stem heard instead of the song in the preview, and its audio. Never reaches a render. */
  soloStem: string | null;
  soloUrl: string | null;
  toggleSolo(stem: string): Promise<void>;
  /** Bindings on the clipboard, with the document they came from, which names their effects. */
  copiedBindings: { readonly document: ProjectDocument; readonly bindings: readonly ModulationBinding[] } | null;
  setCopiedBindings(copied: { readonly document: ProjectDocument; readonly bindings: readonly ModulationBinding[] } | null): void;
  /** What became of the project's refined grid (S16) at the last analysis. */
  beatRefinementState: BeatRefinementState;
  refiningBeats: boolean;
  /** Tracks the open song with librosa and stores the result as one undoable edit. */
  refineBeats(): Promise<void>;
  cancelRefineBeats(): Promise<void>;
  /** Analyses the open song again: the settings it reads have changed. */
  reanalyse(): Promise<void>;
  /** The bundled fallback chain (S17), in order; empty until loaded. */
  fallbackFonts: readonly { readonly hash: string; readonly bytes: Uint8Array }[];
  loadDefaultFont(): Promise<void>;
  /** Loads every image and font the document references that is not loaded yet. `recheck` retries failed ones. */
  loadAssets(recheck?: boolean): Promise<void>;
  /** Picks and decodes an image, keeping its pixels; the caller records the asset in the document. */
  importImage(): Promise<AssetRef | null>;
  /** Picks a font file, keeping its bytes; the caller records the asset in the document. */
  importFont(): Promise<AssetRef | null>;
  /** Picks a video; the caller records the asset, and its preview proxy extracts in the background. */
  importVideo(): Promise<AssetRef | null>;
  /**
   * Prepared preview proxies by clip hash (M39). `capped` means extraction stopped at what the
   * timeline needed, so a longer timeline must extract again; `fps` is what it was extracted at.
   */
  videos: ReadonlyMap<string, VideoProxy>;
  /** Progress from the main process while a clip extracts. */
  reportVideoProgress(hash: string, frames: number): void;
  /** Picks a replacement file for one asset and relinks it (asks first if the content differs). */
  relink(assetId: string): Promise<void>;
  /** Asks for a folder and relinks every missing asset found in it, by content. */
  findMissing(): Promise<void>;
  /** "Collect files": the project and its media copied into one folder. */
  collectFiles(): Promise<void>;

  /** Drop-in modules from modules/ (M35), and the folders that could not load, with why. */
  userModules: readonly ShaderModuleSource[];
  moduleProblems: readonly ModuleFolderProblem[];
  modulesFolder: string | null;
  loadModules(): Promise<void>;

  /** The preset library (S8): the user's own, favourites marked; null until listed. */
  presets: PresetLibraryListing | null;
  /** The Save preset dialog, open for a scope, or closed. */
  presetDialog: 'layer' | 'project' | null;
  loadPresets(): Promise<void>;
  setPresets(listing: PresetLibraryListing): void;
  setPresetDialog(scope: 'layer' | 'project' | null): void;
  deletePreset(scope: 'layer' | 'project', slug: string): Promise<void>;
  setPresetFavourite(scope: 'layer' | 'project', slug: string, on: boolean): Promise<void>;

  /** The managed library folder (M40, D6); null until first listed. */
  library: LibraryListing | null;
  loadLibrary(): Promise<void>;
  addToLibrary(category: string): Promise<void>;
  /** A library image as a new background layer at the bottom of the stack. */
  useLibraryImage(path: string): Promise<void>;

  /** The render queue, pushed from the main process (M24). */
  renders: readonly RenderJob[];
  exportOpen: boolean;
  queueOpen: boolean;
  setRenders(jobs: readonly RenderJob[]): void;
  setExportOpen(open: boolean): void;
  setQueueOpen(open: boolean): void;

  /** Batch mode (S13): the dialog, the tracks it holds, and the running batch pushed from main. */
  batchOpen: boolean;
  batchTracks: readonly string[];
  batch: BatchStatus | null;
  /** Opens the dialog, adding `tracks` (a drop, say) to what it already holds. */
  openBatch(tracks?: readonly string[]): void;
  setBatchOpen(open: boolean): void;
  setBatchTracks(tracks: readonly string[]): void;
  setBatch(status: BatchStatus | null): void;
  /** "Shut down when done" (export-spec §12), as main holds it. */
  shutdownWhenDone: boolean;
  setShutdownWhenDone(on: boolean): Promise<void>;
  /** A shutdown is scheduled: when it was announced, in seconds of grace; null when none. */
  shutdownPending: number | null;
  queueFinished(event: QueueFinishedEvent): void;
  cancelShutdown(): Promise<void>;

  run(command: Command, options?: { seal?: boolean }): void;
  undo(): void;
  redo(): void;
  jumpTo(index: number): void;
  select(layerId: string | null): void;
  setEditTarget(target: EditTarget): void;
  setPreviewScale(scale: number): void;
  notify(toast: Toast | null): void;
  newProject(): void;
  /**
   * Opens a project from its text. `recovered` marks an autosave being restored (M1): it opens as
   * unsaved, under the file it came from, and the toast says what happened.
   */
  adopt(file: { path: string | null; text: string }, options?: { readonly recovered?: string }): void;
  /** Snapshots the project for crash recovery if it has unsaved changes (M1). */
  autosave(reason: string): Promise<void>;
  /** Earlier runs that crashed with an autosave; shown on start (M1). */
  recovery: readonly RecoveryCandidate[];
  loadRecovery(): Promise<void>;
  restoreRecovery(candidate: RecoveryCandidate): Promise<void>;
  discardRecovery(sessionId: string): Promise<void>;
  openProject(): Promise<void>;
  save(): Promise<void>;
  saveAs(): Promise<void>;
  loadAudio(path: string): Promise<void>;
  reportPreview(transport: Transport, timelineSeconds: number, stats: PreviewStats): void;
  /** Stem separation for the loaded track (M5): what exists, and what is running. */
  stems: StemsState;
  separateStems(): Promise<void>;
  cancelStems(): Promise<void>;
  reportStemsProgress(progress: StemProgressEvent): void;
  /** Live modulation from the preview (M13): rendered values, binding levels, compile issues. */
  liveModulation: LiveModulation;
  reportModulation(live: LiveModulation): void;
  /** The performance HUD (S12): open, and the latest GPU times the preview measured. */
  hudOpen: boolean;
  /** Draft mode (S18): the preview at a fixed low resolution with expensive effects approximated. */
  draft: boolean;
  setDraft(on: boolean): void;
  /** The "Paste a Shadertoy" dialog (S2). */
  shadertoyOpen: boolean;
  setShadertoyOpen(open: boolean): void;
  setHudOpen(open: boolean): void;
  gpuTimings: GpuFrameTimings | null;
  /** Null until the preview has said whether timer queries exist here. */
  gpuAvailable: boolean | null;
  reportGpuTimings(timings: GpuFrameTimings | null, available: boolean): void;
  /** The binding whose editor is expanded, in the inspector and the matrix. */
  openBinding: string | null;
  setOpenBinding(id: string | null): void;
  /** The modulation matrix panel (ui-spec §6). */
  matrixOpen: boolean;
  setMatrixOpen(open: boolean): void;

  /** The auto-director's drawer (M21, M22, D9: offered on import, always available). */
  autoOpen: boolean;
  setAutoOpen(open: boolean): void;
  /** The template library, parsed; problems are files that did not parse. */
  templates: readonly LoadedTemplate[];
  /** The MilkDrop presets installed here, for the director. */
  milkdropPresets: readonly string[];
  templateProblems: readonly TemplateProblem[];
  templatesFolder: string | null;
  loadTemplates(): Promise<void>;
  /** What Surprise me keeps (auto-director-spec §9) and whether it may change the template. */
  autoLocks: readonly DirectorLock[];
  setAutoLocks(locks: readonly DirectorLock[]): void;
  autoRoulette: boolean;
  setAutoRoulette(on: boolean): void;
  /** Thumbnails of director rolls for the history strip, by roll key; drawn per session. */
  rollThumbs: Readonly<Record<string, string>>;
  /** A track was just imported into an empty project: offer to generate one (D9). */
  autoOffer: boolean;
  dismissAutoOffer(): void;

  /** The lyrics editor drawer (ui-spec §5 "Lyrics", lyrics-spec §5) and which tab it shows. */
  lyricsOpen: boolean;
  lyricsTab: 'text' | 'lines' | 'checks';
  setLyricsOpen(open: boolean, tab?: StudioState['lyricsTab']): void;
  /** Selected lyric lines (UI only, never undoable): punch-in range, bulk edits, word editing. */
  lyricsSelection: readonly string[];
  setLyricsSelection(ids: readonly string[]): void;
  /** Imports a lyrics file: timed formats replace the lines; plain text is read like a paste. */
  importLyricsFile(): Promise<void>;
  exportLyrics(format: LyricsExportFormat): Promise<void>;
  /**
   * What lyric edges snap to on the timeline (lyrics-spec §5): vocal onsets by default, the beat grid
   * when asked. Other lines' edges and the playhead always.
   */
  lyricSnap: { readonly onsets: boolean; readonly beats: boolean };
  setLyricSnap(patch: Partial<StudioState['lyricSnap']>): void;
  /** A running tap-to-sync session (lyrics-spec §3), or null. */
  tap: TapState | null;
  setTap(tap: TapState | null): void;

  /** WhisperX alignment (M26): whether it is installed, and the running job. */
  alignAvailability: { readonly available: boolean; readonly languages: readonly string[]; readonly reason: string | null } | null;
  loadAlignAvailability(): Promise<void>;
  aligning: LyricsAlignProgress | null;
  alignLyrics(mode: LyricsAlignMode): Promise<void>;
  cancelAlign(): Promise<void>;
  reportAlignProgress(progress: LyricsAlignProgress): void;

  /** User settings (data-formats §6); null until read. */
  settings: UserSettings | null;
  loadSettings(): Promise<void>;
  /** Saves a patch; returns why it was refused, or null. */
  updateSettings(patch: Partial<UserSettings>): Promise<string | null>;
  /** Switches the project's stem model (D8) and re-analyses the track under the new key. */
  setStemModel(model: string): Promise<void>;
  /** Selected keyframes (UI only, never undoable): the key editor and the timeline lanes share it. */
  keySelection: readonly string[];
  setKeySelection(ids: readonly string[]): void;
  /** The selected timeline marker (S9), for Delete and the editor. */
  markerSelection: string | null;
  setMarkerSelection(id: string | null): void;
  /** The Settings screen (M36). */
  settingsOpen: boolean;
  setSettingsOpen(open: boolean): void;
}

export interface TapState {
  readonly session: TapSession;
  /** Playback speed while tapping; taps are still recorded in timeline time. */
  readonly rate: number;
  /** Land taps on the nearest vocal-stem onset within 100 ms (on by default when there are stems). */
  readonly snapOnsets: boolean;
  /** Land taps on the beat grid instead (off by default: vocals rarely sit on it). */
  readonly snapBeats: boolean;
  /** How many taps this session has made, for the overlay. */
  readonly taps: number;
}

/** Everything derived from the history, recomputed after any command. */
function fromHistory() {
  return {
    document: history.current,
    dirty: history.dirty,
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    undoLabel: history.undoLabel,
    redoLabel: history.redoLabel,
  };
}

/** The store version last written as an autosave; -1 when none has been this session. */
let lastAutosaveVersion = -1;

/** Increments per `loadAudio` call; a response for an older call is dropped. */
let audioRequest = 0;

export interface AssetStatus {
  readonly state: 'loading' | 'ok' | 'missing' | 'changed' | 'error';
  readonly detail: string;
  /**
   * The path and hash this status was determined for. An undo, redo or relink changes an asset's
   * path or hash without touching its id; a status for other values is stale and is re-checked.
   */
  readonly path: string;
  readonly hash: string;
}

export interface VideoProxy {
  readonly frameCount: number;
  readonly fps: string;
  readonly capped: boolean;
}

const fpsKey = (fps: { num: number; den: number }) => `${fps.num}/${fps.den}`;

/** The preview proxy a clip needs for the document as it is now: its fps, and how many frames. */
function proxyNeeds(document: ProjectDocument, assetId: string): { fps: string; maxFrames: number } {
  const { project } = toRenderProject(document);
  const timeline = frameCount(timelineDurationTicks(document), document.canvas.fps);
  // With no audio yet the timeline is empty; a minute's worth keeps the preview useful meanwhile.
  const frames = Math.max(timeline, Math.round((60 * document.canvas.fps.num) / document.canvas.fps.den));
  return { fps: fpsKey(document.canvas.fps), maxFrames: videoFramesNeeded(project, assetId, frames) };
}

function imageOf(bytes: ImageBytes): DecodedImage {
  return { width: bytes.width, height: bytes.height, pixels: bytes.pixels };
}

/**
 * Asks before throwing away unsaved work. `window.confirm` is a real modal in Electron, and a
 * dialog of our own would be the same question with more code.
 */
function discardOk(action: string): boolean {
  return !history.dirty || window.confirm(`The project has unsaved changes. ${action} anyway and lose them?`);
}

/** Never a raw stack trace (ui-spec §11). */
function describeError(error: unknown, whileDoing: string): string {
  if (error instanceof ProjectVersionError) return error.message;
  if (error instanceof ProjectFormatError) return `That file is not a Pulseforge project. ${error.message}`;
  return `${whileDoing} failed. ${error instanceof Error ? error.message : String(error)}`;
}

export const useStudio = create<StudioState>((set, get) => ({
  version: 0,
  ...fromHistory(),
  path: null,
  issues: [],
  migratedFrom: null,

  selectedLayerId: null,
  selectedLayerIds: [],
  extendLayerSelection(id, mode, order) {
    const next = extendSelection({ primary: get().selectedLayerId, ids: get().selectedLayerIds }, id, mode, order);
    set({ selectedLayerId: next.primary, selectedLayerIds: next.ids });
  },
  editTarget: 'base',
  previewScale: 1,
  toast: null,

  audio: null,
  analysis: null,
  peaks: null,
  sections: [],
  onsetTimes: [],
  analysisState: 'idle',
  analysisMessage: null,

  transport: 'stopped',
  timelineSeconds: 0,
  stats: null,

  images: new Map(),
  fonts: new Map(),
  luts: new Map(),
  defaultFont: null,
  fallbackFonts: [],
  loop: null,
  setLoop(loop) {
    set({ loop });
  },
  stemRows: false,
  setStemRows(on) {
    set({ stemRows: on });
  },
  soloStem: null,
  soloUrl: null,
  async toggleSolo(stem) {
    const audio = get().audio;
    const previous = get().soloUrl;
    const off = get().soloStem === stem;
    try {
      const file = off || audio === null ? null : await window.pulseforge.readStemAudio(audio.path, stem, history.current.analysisSettings.stemModel);
      set({ soloStem: file === null ? null : stem, soloUrl: file === null ? null : URL.createObjectURL(new Blob([file.bytes as unknown as BlobPart])) });
      if (previous !== null) URL.revokeObjectURL(previous);
    } catch (error) {
      set({ toast: { text: describeError(error, 'Soloing the stem'), kind: 'bad' } });
    }
  },
  copiedBindings: null,
  setCopiedBindings(copied) {
    set({ copiedBindings: copied });
  },
  beatRefinementState: 'none',
  refiningBeats: false,

  async refineBeats() {
    const audio = get().audio;
    if (audio === null || get().refiningBeats) return;
    set({ refiningBeats: true });
    try {
      const refinement = await window.pulseforge.refineBeats(audio.path, history.current.analysisSettings.stemModel);
      if (get().audio?.path !== audio.path) return;
      get().run(setBeatRefinement(refinement));
      set({ toast: { text: `Beats refined: ${refinement.beats.length} beats, about ${refinement.bpm.toFixed(1)} bpm`, kind: 'ok' } });
    } catch (error) {
      const text = describeError(error, 'Refining the beats');
      set({ toast: { text, kind: /cancelled/i.test(text) ? 'warn' : 'bad' } });
    } finally {
      set({ refiningBeats: false });
    }
  },

  async cancelRefineBeats() {
    await window.pulseforge.cancelRefineBeats();
  },

  async reanalyse() {
    const audio = get().audio;
    if (audio === null) return;
    try {
      const payload = await window.pulseforge.analyzeAudio(audio.path, history.current.analysisSettings);
      if (get().audio?.path !== audio.path) return;
      set({
        analysis: analysisFromPayload(payload),
        sections: payload.sections,
        beatRefinementState: payload.beatRefinement,
      });
    } catch (error) {
      set({ toast: { text: describeError(error, 'Analysing the audio'), kind: 'bad' } });
    }
  },
  assetStatus: {},

  async loadAssets(recheck = false) {
    const document = history.current;
    const projectPath = get().path;
    for (const asset of document.assets) {
      // Another project was opened meanwhile: stop, rather than attach this one's problems to it.
      if (history.current.id !== document.id) return;
      if (asset.kind !== 'image' && asset.kind !== 'font' && asset.kind !== 'video' && asset.kind !== 'lut') continue;
      const setStatus = (state: AssetStatus['state'], detail: string) =>
        set({ assetStatus: { ...get().assetStatus, [asset.id]: { state, detail, path: asset.path, hash: asset.hash } } });
      const known = get().assetStatus[asset.id];
      const fresh = known !== undefined && known.path === asset.path && known.hash === asset.hash;
      const failed = known?.state === 'missing' || known?.state === 'error';
      // A video is also stale when the project's fps changed, or the timeline grew past a proxy
      // that was cut to the old length.
      const proxy = asset.kind === 'video' ? get().videos.get(asset.hash) : undefined;
      const needs = asset.kind === 'video' ? proxyNeeds(document, asset.id) : undefined;
      const videoStale = needs !== undefined && known?.state === 'ok'
        && (proxy === undefined || proxy.fps !== needs.fps || (proxy.capped && needs.maxFrames > proxy.frameCount));
      if (fresh && !(recheck && failed) && !videoStale) continue;
      setStatus('loading', asset.kind === 'video' ? 'Extracting preview frames…' : asset.path);

      if (asset.kind === 'video' && needs !== undefined) {
        try {
          const result = await window.pulseforge.prepareVideo({
            path: asset.path, projectPath, hash: asset.hash, fps: document.canvas.fps, maxFrames: needs.maxFrames,
          });
          if (history.current.id !== document.id) return;
          if (result.status === 'missing') {
            setStatus('missing', `Not found: ${result.path}`);
          } else if (result.status === 'error') {
            setStatus('error', result.message);
          } else {
            set({
              videos: new Map(get().videos).set(asset.hash, {
                frameCount: result.sequence.frameCount,
                fps: needs.fps,
                capped: result.sequence.frameCount >= needs.maxFrames,
              }),
            });
            setStatus('ok', `${result.sequence.frameCount} frames at ${needs.fps} fps`);
          }
        } catch (error) {
          setStatus('error', error instanceof Error ? error.message : String(error));
        }
        continue;
      }
      try {
        const result = asset.kind === 'image'
          ? await window.pulseforge.loadImage(asset.path, projectPath)
          : asset.kind === 'lut'
            ? await window.pulseforge.loadLut(asset.path, projectPath)
            : await window.pulseforge.loadFont(asset.path, projectPath);
        if (history.current.id !== document.id) return;
        if (result.status === 'missing') {
          setStatus('missing', `Not found: ${result.path}`);
          continue;
        }
        if (result.status === 'error') {
          setStatus('error', result.message);
          continue;
        }
        // Under the recorded hash, which is what the snapshot looks up; a changed file still draws.
        const loaded = 'image' in result ? result.image : 'lut' in result ? result.lut : result.font;
        if ('image' in result) {
          set({ images: new Map(get().images).set(asset.hash, imageOf(result.image)) });
        } else if ('lut' in result) {
          set({ luts: new Map(get().luts).set(asset.hash, result.lut.text) });
        } else {
          set({ fonts: new Map(get().fonts).set(asset.hash, result.font.bytes) });
        }
        if (loaded.hash === asset.hash) setStatus('ok', loaded.path);
        else setStatus('changed', `"${asset.name}" has changed on disk since it was chosen, so it may look different. Relink to accept the new file.`);
      } catch (error) {
        setStatus('error', error instanceof Error ? error.message : String(error));
      }
    }
  },

  async importImage() {
    try {
      const image = await window.pulseforge.importImage();
      if (image === null) return null;
      const images = new Map(get().images);
      images.set(image.hash, imageOf(image));
      set({ images });
      const id = newId();
      set({ assetStatus: { ...get().assetStatus, [id]: { state: 'ok', detail: image.path, path: image.path, hash: image.hash } } });
      return { id, kind: 'image', path: image.path, hash: image.hash, size: image.size, name: image.name, extra: {} };
    } catch (error) {
      set({ toast: { text: describeError(error, 'Importing the image'), kind: 'bad' } });
      return null;
    }
  },

  async importLut() {
    try {
      const lut = await window.pulseforge.importLut();
      if (lut === null) return null;
      const id = newId();
      set({
        luts: new Map(get().luts).set(lut.hash, lut.text),
        assetStatus: { ...get().assetStatus, [id]: { state: 'ok', detail: `${lut.path} (${lut.description})`, path: lut.path, hash: lut.hash } },
      });
      return { id, kind: 'lut', path: lut.path, hash: lut.hash, size: lut.size, name: lut.name, extra: {} };
    } catch (error) {
      set({ toast: { text: describeError(error, 'Choosing the LUT'), kind: 'bad' } });
      return null;
    }
  },

  async importFont() {
    try {
      const font = await window.pulseforge.importFont();
      if (font === null) return null;
      const id = newId();
      set({
        fonts: new Map(get().fonts).set(font.hash, font.bytes),
        assetStatus: { ...get().assetStatus, [id]: { state: 'ok', detail: font.path, path: font.path, hash: font.hash } },
      });
      return { id, kind: 'font', path: font.path, hash: font.hash, size: font.size, name: font.name, extra: {} };
    } catch (error) {
      set({ toast: { text: describeError(error, 'Choosing the font'), kind: 'bad' } });
      return null;
    }
  },

  videos: new Map(),

  reportVideoProgress(hash, frames) {
    const statuses = get().assetStatus;
    const updated: Record<string, AssetStatus> = { ...statuses };
    let changed = false;
    for (const [id, status] of Object.entries(statuses)) {
      if (status.hash !== hash || status.state !== 'loading') continue;
      updated[id] = { ...status, detail: `Extracting preview frames… ${frames}` };
      changed = true;
    }
    if (changed) set({ assetStatus: updated });
  },

  async importVideo() {
    try {
      const video = await window.pulseforge.importVideo();
      if (video === null) return null;
      // Extraction starts once the asset is in the document: loadAssets runs after the command.
      const asset: AssetRef = { id: newId(), kind: 'video', path: video.path, hash: video.hash, size: video.size, name: video.name, extra: {} };
      return asset;
    } catch (error) {
      set({ toast: { text: describeError(error, 'Importing the video'), kind: 'bad' } });
      return null;
    }
  },

  async loadDefaultFont() {
    if (get().defaultFont !== null) return;
    try {
      const [font, fallbackFonts] = await Promise.all([window.pulseforge.defaultFont(), window.pulseforge.fallbackFonts()]);
      set({ defaultFont: { hash: font.hash, bytes: font.bytes }, fallbackFonts });
    } catch (error) {
      // A fresh download has no fonts yet, and the setup screen is already on its way.
      const text = describeError(error, 'Loading the default font');
      if (!/default font is missing/.test(text)) set({ toast: { text, kind: 'bad' } });
    }
  },

  async relink(assetId) {
    const asset = history.current.assets.find((a) => a.id === assetId);
    if (asset === undefined) return;
    try {
      const picked = asset.kind === 'font'
        ? await window.pulseforge.importFont()
        : asset.kind === 'video'
          ? await window.pulseforge.importVideo()
          : await window.pulseforge.importImage();
      if (picked === null) return;
      // A different file is allowed — a re-export is often the point — but never silently
      // (data-formats §1.2): the look of every layer using it changes.
      if (asset.hash !== '' && picked.hash !== asset.hash
        && !window.confirm(`"${picked.name}" is not the same file as "${asset.name}" (the content differs). Use it anyway?`)) {
        return;
      }
      if ('pixels' in picked) set({ images: new Map(get().images).set(picked.hash, imageOf(picked)) });
      else if ('bytes' in picked) set({ fonts: new Map(get().fonts).set(picked.hash, picked.bytes) });
      // A relinked video has no proxy yet: leave its status for loadAssets, which extracts it.
      if (!('durationSeconds' in picked)) {
        set({ assetStatus: { ...get().assetStatus, [assetId]: { state: 'ok', detail: picked.path, path: picked.path, hash: picked.hash } } });
      }
      get().run(relinkAsset(assetId, { path: picked.path, hash: picked.hash, size: picked.size, name: picked.name }));
    } catch (error) {
      set({ toast: { text: describeError(error, 'Relinking'), kind: 'bad' } });
    }
  },

  async findMissing() {
    const { assetStatus } = get();
    const wanted = history.current.assets
      .filter((a) => assetStatus[a.id]?.state === 'missing')
      .map((a) => ({ id: a.id, name: a.name, size: a.size, hash: a.hash }));
    if (wanted.length === 0) return;
    try {
      const result = await window.pulseforge.findAssetsInFolder(wanted);
      if (result === null) return;
      if (result.found.length > 0) {
        get().run(sequence(
          `Relink ${result.found.length} file${result.found.length === 1 ? '' : 's'}`,
          result.found.map((f) => relinkAsset(f.id, { path: f.path, hash: f.hash, size: f.size, name: f.name })),
        ));
        await get().loadAssets(true);
      }
      const still = wanted.length - result.found.length;
      set({
        toast: {
          text: `Found ${result.found.length} of ${wanted.length} missing file${wanted.length === 1 ? '' : 's'} in ${result.folder}.`
            + (still > 0 ? ` ${still} still missing — only files with identical content are relinked automatically; use Relink… for a changed file.` : '')
            + (result.truncated ? ` The search stopped after ${result.filesListed} files; pick a narrower folder to look further.` : ''),
          kind: still > 0 ? 'warn' : 'ok',
        },
      });
    } catch (error) {
      set({ toast: { text: describeError(error, 'Searching for files'), kind: 'bad' } });
    }
  },

  async collectFiles() {
    try {
      const result = await window.pulseforge.collectProject(stringifyDocument(history.current));
      if (result === null) return;
      const megabytes = (result.bytes / 1_048_576).toFixed(1);
      set({
        toast: {
          text: `Collected ${result.copied} file${result.copied === 1 ? '' : 's'} (${megabytes} MB) and the project into\n${result.projectPath}`
            + (result.problems.length > 0 ? `\n\nNot collected:\n${result.problems.map((p) => `• ${p}`).join('\n')}` : ''),
          kind: result.problems.length > 0 ? 'warn' : 'ok',
        },
      });
    } catch (error) {
      set({ toast: { text: describeError(error, 'Collecting files'), kind: 'bad' } });
    }
  },

  userModules: [],
  moduleProblems: [],
  modulesFolder: null,

  async loadModules() {
    try {
      const scan = await window.pulseforge.listModules();
      set({ userModules: scan.modules, moduleProblems: scan.problems, modulesFolder: scan.root });
    } catch (error) {
      set({ toast: { text: describeError(error, 'Reading the modules folder'), kind: 'bad' } });
    }
  },

  presets: null,
  presetDialog: null,

  async loadPresets() {
    try {
      set({ presets: await window.pulseforge.listPresets() });
    } catch (error) {
      set({ toast: { text: describeError(error, 'Reading the presets'), kind: 'bad' } });
    }
  },

  setPresets(listing) {
    set({ presets: listing });
  },

  setPresetDialog(scope) {
    set({ presetDialog: scope });
  },

  async deletePreset(scope, slug) {
    try {
      set({ presets: await window.pulseforge.deletePreset(scope, slug) });
    } catch (error) {
      set({ toast: { text: describeError(error, 'Deleting the preset'), kind: 'bad' } });
    }
  },

  async setPresetFavourite(scope, slug, on) {
    try {
      set({ presets: await window.pulseforge.setPresetFavourite(scope, slug, on) });
    } catch (error) {
      set({ toast: { text: describeError(error, 'Starring the preset'), kind: 'bad' } });
    }
  },

  library: null,

  async loadLibrary() {
    try {
      set({ library: await window.pulseforge.listLibrary() });
    } catch (error) {
      set({ toast: { text: describeError(error, 'Reading the library'), kind: 'bad' } });
    }
  },

  async addToLibrary(category) {
    try {
      set({ library: await window.pulseforge.addToLibrary(category) });
    } catch (error) {
      set({ toast: { text: describeError(error, 'Adding to the library'), kind: 'bad' } });
    }
  },

  async useLibraryImage(path) {
    try {
      const result = await window.pulseforge.loadImage(path, null);
      if (result.status !== 'ok') {
        set({ toast: { text: result.status === 'missing' ? `Not found: ${result.path}` : result.message, kind: 'bad' } });
        void get().loadLibrary();
        return;
      }
      const { image } = result;
      const images = new Map(get().images);
      images.set(image.hash, imageOf(image));
      const existing = findAssetByHash(history.current, image.hash);
      const asset: AssetRef = existing ?? { id: newId(), kind: 'image', path: image.path, hash: image.hash, size: image.size, name: image.name, extra: {} };
      set({ images, assetStatus: { ...get().assetStatus, [asset.id]: { state: 'ok', detail: image.path, path: image.path, hash: image.hash } } });
      const layer = createModuleLayer('core.source.background', {
        id: newId(),
        name: image.name.replace(/\.[^.]+$/, ''),
        params: { mode: 'image', image: asset.id, fit: 'cover' },
      });
      // Just above the topmost existing background, and so below every visualizer. At the very
      // bottom it landed behind an opaque background already there and could not be seen.
      const layers = history.current.layers;
      let index = 0;
      layers.forEach((l, i) => {
        if (l.kind === 'module' && l.module === 'core.source.background') index = i + 1;
      });
      get().run(sequence(`Add background ${image.name}`, [
        ...(existing === undefined ? [addAsset(asset)] : []),
        addLayer(layer, { index }),
      ]));
      set({ selectedLayerId: layer.id, selectedLayerIds: [layer.id] });
    } catch (error) {
      set({ toast: { text: describeError(error, 'Using the library image'), kind: 'bad' } });
    }
  },

  renders: [],
  exportOpen: false,
  queueOpen: false,
  setRenders(jobs) {
    set({ renders: jobs });
  },
  setExportOpen(open) {
    set({ exportOpen: open });
  },
  setQueueOpen(open) {
    set(open ? { queueOpen: true, matrixOpen: false, lyricsOpen: false, autoOpen: false } : { queueOpen: false });
  },

  batchOpen: false,
  batchTracks: [],
  batch: null,
  openBatch(tracks = []) {
    set({ batchOpen: true, batchTracks: [...get().batchTracks, ...tracks] });
  },
  setBatchOpen(open) {
    set({ batchOpen: open });
  },
  setBatchTracks(tracks) {
    set({ batchTracks: tracks });
  },
  setBatch(status) {
    set({ batch: status });
  },
  shutdownWhenDone: false,
  async setShutdownWhenDone(on) {
    try {
      set({ shutdownWhenDone: await window.pulseforge.setShutdownWhenDone(on) });
    } catch (error) {
      set({ toast: { text: describeError(error, 'Setting shutdown when done'), kind: 'bad' } });
    }
  },
  shutdownPending: null,
  queueFinished(event) {
    // Main clears its flag once it has fired; the checkbox follows.
    set({
      shutdownWhenDone: false,
      shutdownPending: event.shutdownInSeconds,
      toast: { text: `All renders finished: ${event.done} done${event.failed > 0 ? `, ${event.failed} failed` : ''}.`, kind: event.failed > 0 ? 'warn' : 'ok' },
    });
  },
  async cancelShutdown() {
    try {
      await window.pulseforge.cancelShutdown();
      set({ shutdownPending: null, toast: { text: 'Shutdown cancelled.', kind: 'ok' } });
    } catch (error) {
      set({ toast: { text: describeError(error, 'Cancelling the shutdown'), kind: 'bad' } });
    }
  },

  run(command, options) {
    try {
      const before = history.current.assets;
      history.run(command);
      if (options?.seal !== false) history.seal();
      set((state) => ({ ...fromHistory(), version: state.version + 1 }));
      // Assets changed, or — for videos — the fps, the timeline or a clip's speed may have, any of
      // which can make a preview proxy stale. loadAssets returns at once when nothing is.
      if (history.current.assets !== before || history.current.assets.some((a) => a.kind === 'video')) void get().loadAssets();
    } catch (error) {
      // A command that cannot apply is a bug in the caller, but the user still needs a sentence
      // rather than a silently ignored click.
      set({ toast: { text: error instanceof Error ? error.message : String(error), kind: 'bad' } });
    }
  },

  undo() {
    history.undo();
    set((state) => ({ ...fromHistory(), version: state.version + 1 }));
    // An undone relink points an asset back at its old file; its status has to follow.
    void get().loadAssets();
  },

  redo() {
    history.redo();
    set((state) => ({ ...fromHistory(), version: state.version + 1 }));
    void get().loadAssets();
  },

  jumpTo(index) {
    history.jumpTo(index);
    set((state) => ({ ...fromHistory(), version: state.version + 1 }));
    void get().loadAssets();
  },

  select(layerId) {
    set({ selectedLayerId: layerId, selectedLayerIds: layerId === null ? [] : [layerId] });
  },

  setEditTarget(target) {
    set({ editTarget: target });
  },

  setPreviewScale(scale) {
    set({ previewScale: Math.min(1, Math.max(0.25, scale)) });
  },

  notify(toast) {
    set({ toast });
  },

  newProject() {
    if (!discardOk('Start a new project')) return;
    const fresh = createDocument({ name: 'Untitled' });
    // The stem model a new project starts with is a setting (M36, D8).
    const stemModel = get().settings?.stemModel ?? fresh.analysisSettings.stemModel;
    history.reset({ ...fresh, analysisSettings: { ...fresh.analysisSettings, stemModel } }, 'New project');
    void window.pulseforge.clearRecovery().catch(() => undefined);
    lastAutosaveVersion = -1;
    audioRequest += 1;
    const previous = get().audio;
    if (previous !== null) URL.revokeObjectURL(previous.url);
    set((state) => ({
      ...fromHistory(),
      version: state.version + 1,
      path: null,
      issues: [],
      migratedFrom: null,
      selectedLayerId: null,
      selectedLayerIds: [],
      toast: null,
      images: new Map(),
      fonts: new Map(),
      videos: new Map(),
      assetStatus: {},
      // A new project has no audio; keeping the old track made "New" still react to the last song.
      audio: null,
      analysis: null,
      peaks: null,
      sections: [],
      onsetTimes: [],
      autoOffer: false,
      analysisState: 'idle' as const,
      analysisMessage: null,
    }));
  },

  adopt(file, options = {}) {
    const loaded = loadDocument(file.text);
    // The studio holds absolute paths and writes them relative again on save, against whichever
    // file it saves to (asset-paths.ts) — so "Save as" into another folder cannot break links.
    const document = withAbsolutePaths(loaded.document, file.path);
    // Opening replaces the history: the previous project's undo steps do not apply here. A restored
    // autosave is not what the file on disk holds, so it opens as unsaved.
    if (options.recovered === undefined) history.reset(document, 'Opened');
    else history.resetUnsaved(document, 'Recovered');
    // This run's own autosaves belonged to the project being left behind. (A restore writes its own
    // snapshot straight after; clearing here too would race it.)
    if (options.recovered === undefined) void window.pulseforge.clearRecovery().catch(() => undefined);
    lastAutosaveVersion = -1;
    set((state) => ({
      ...fromHistory(),
      version: state.version + 1,
      path: file.path,
      issues: loaded.issues,
      migratedFrom: loaded.migratedFrom,
      selectedLayerId: null,
      selectedLayerIds: [],
      toast: options.recovered !== undefined
        ? { text: options.recovered, kind: 'warn' as const }
        : loaded.migratedFrom === null
          ? { text: `Opened ${file.path}`, kind: 'ok' as const }
          : { text: `Migrated from schema v${loaded.migratedFrom}. The original is backed up on the first save.`, kind: 'warn' as const },
    }));
    const audioPath = document.audio.path;
    if (audioPath !== '') {
      void get().loadAudio(audioPath);
    } else {
      // The previous project's track must not stay loaded under a project that has none.
      audioRequest += 1;
      const previous = get().audio;
      if (previous !== null) URL.revokeObjectURL(previous.url);
      set({ audio: null, analysis: null, peaks: null, sections: [], onsetTimes: [], analysisState: 'idle', analysisMessage: null });
    }
    set({ images: new Map(), fonts: new Map(), videos: new Map(), assetStatus: {} });
    void get().loadAssets();
  },

  async openProject() {
    if (!discardOk('Open another project')) return;
    try {
      const file = await window.pulseforge.openProject();
      if (file !== null) get().adopt(file);
    } catch (error) {
      set({ toast: { text: describeError(error, 'Opening the project'), kind: 'bad' } });
    }
  },

  async save() {
    const { path, migratedFrom } = get();
    if (path === null) {
      await get().saveAs();
      return;
    }
    try {
      const result = await window.pulseforge.saveProject({
        path,
        text: stringifyDocument(withStoredPaths(history.current, path)),
        ...(migratedFrom === null ? {} : { backupFromVersion: migratedFrom }),
      });
      history.markSaved();
      // Saved: the file is now the newest state, so this run's autosaves are no longer needed.
      void window.pulseforge.clearRecovery().catch(() => undefined);
      set((state) => ({
        ...fromHistory(),
        version: state.version + 1,
        migratedFrom: null,
        toast: {
          text: result.backupPath === undefined
            ? `Saved ${result.path}`
            : `Saved; the original is backed up at ${result.backupPath}`,
          kind: 'ok' as const,
        },
      }));
    } catch (error) {
      set({ toast: { text: describeError(error, 'Saving'), kind: 'bad' } });
    }
  },

  async saveAs() {
    try {
      const clean = history.current.name.replace(/[^\w\- ]+/g, '');
      const target = await window.pulseforge.pickProjectSavePath(`${clean === '' ? 'untitled' : clean}.pvproj`);
      if (target === null) return;
      // A project that never had a name takes the file's, or every render says "Untitled".
      if (history.current.name === 'Untitled') {
        const name = (target.split(/[\\/]/).pop() ?? '').replace(/\.pvproj$/i, '');
        if (name !== '') get().run(renameProject(name));
      }
      // Serialised only now, against the chosen file: that decides which paths become relative.
      const result = await window.pulseforge.saveProject({ path: target, text: stringifyDocument(withStoredPaths(history.current, target)) });
      history.markSaved();
      set((state) => ({
        ...fromHistory(),
        version: state.version + 1,
        path: result.path,
        migratedFrom: null,
        toast: { text: `Saved ${result.path}`, kind: 'ok' as const },
      }));
    } catch (error) {
      set({ toast: { text: describeError(error, 'Saving'), kind: 'bad' } });
    }
  },

  async loadAudio(path) {
    // Only the latest request may land. Opening project B while A's track is still analysing
    // otherwise shows B with A's audio and analysis once A finishes.
    const request = ++audioRequest;
    set({ analysisState: 'working', analysisMessage: 'Reading audio...' });
    let url: string | undefined;
    try {
      const file = await window.pulseforge.readAudio(path);
      // A solo belongs to the song it was made from.
      if (get().soloUrl !== null) URL.revokeObjectURL(get().soloUrl as string);
      set({ soloStem: null, soloUrl: null });
      if (request !== audioRequest) return;
      // A Blob URL, not file://: the page's CSP allows blob: media, and the sandboxed renderer
      // has no filesystem of its own to point an element at.
      url = URL.createObjectURL(new Blob([file.bytes as unknown as BlobPart]));

      set({ analysisMessage: 'Analysing...' });
      const payload = await window.pulseforge.analyzeAudio(path, history.current.analysisSettings);
      if (request !== audioRequest) {
        URL.revokeObjectURL(url);
        return;
      }
      const analysis = analysisFromPayload(payload);
      // Revoked only once the replacement is ready: revoking up front left a failed load with
      // the old track's element pointing at a dead URL.
      const previous = get().audio;
      if (previous !== null) URL.revokeObjectURL(previous.url);
      set({
        audio: { path, url, durationSeconds: payload.durationSeconds },
        analysis,
        peaks: decodePeaks(payload.peaks),
        sections: payload.sections,
        beatRefinementState: payload.beatRefinement,
        onsetTimes: payload.onsetTimes,
        // D9: a track in an empty project is the moment to offer a generated one — offered, never forced.
        autoOffer: history.current.layers.length === 0 && history.current.director === null,
        analysisState: 'ready',
        analysisMessage: payload.fromCache ? 'Analysis: cache hit' : 'Analysed and cached',
        stems: stemsFromPayload(payload, history.current.analysisSettings.stemModel),
      });
    } catch (error) {
      if (url !== undefined) URL.revokeObjectURL(url);
      if (request !== audioRequest) return;
      const text = describeError(error, 'Loading the audio');
      set({ analysisState: 'error', analysisMessage: text, toast: { text, kind: 'bad' } });
    }
  },

  reportPreview(transport, timelineSeconds, stats) {
    set({ transport, timelineSeconds, stats });
  },

  hudOpen: false,
  draft: false,
  setDraft(on) {
    set({ draft: on });
  },
  shadertoyOpen: false,
  setShadertoyOpen(open) {
    set({ shadertoyOpen: open });
  },
  setHudOpen(open) {
    set(open ? { hudOpen: true } : { hudOpen: false, gpuTimings: null });
  },
  gpuTimings: null,
  gpuAvailable: null,
  reportGpuTimings(timings, available) {
    set({ gpuTimings: timings, gpuAvailable: available });
  },

  async autosave(reason) {
    const { version, path, document } = get();
    // Only unsaved work, and only once per state: an idle studio writes nothing.
    if (!history.dirty || version === lastAutosaveVersion) return;
    lastAutosaveVersion = version;
    try {
      // Absolute paths, as the studio holds them: a restore needs no folder to resolve against.
      await window.pulseforge.writeRecovery({ text: stringifyDocument(history.current), projectPath: path, projectName: document.name, reason });
    } catch (error) {
      // Worth saying once, not a reason to stop working: the project itself is untouched.
      lastAutosaveVersion = -1;
      set({ toast: { text: describeError(error, 'Autosaving'), kind: 'warn' } });
    }
  },

  recovery: [],

  async loadRecovery() {
    try {
      set({ recovery: await window.pulseforge.listRecovery() });
    } catch {
      set({ recovery: [] });
    }
  },

  async restoreRecovery(candidate) {
    if (!discardOk('Restore the recovered project')) return;
    const when = new Date(candidate.savedAt).toLocaleString();
    get().adopt({ path: candidate.projectPath, text: candidate.text }, {
      recovered: `Restored the autosave from ${when}. It is not saved yet — save it to keep it.`,
    });
    // Snapshot it into this run at once, then let the old run go: from here on, a crash recovers
    // from this session instead.
    await get().autosave('restored from a crash');
    await window.pulseforge.discardRecovery(candidate.sessionId).catch(() => undefined);
    set({ recovery: get().recovery.filter((c) => c.sessionId !== candidate.sessionId) });
  },

  async discardRecovery(sessionId) {
    await window.pulseforge.discardRecovery(sessionId).catch(() => undefined);
    set({ recovery: get().recovery.filter((c) => c.sessionId !== sessionId) });
  },

  stems: NO_STEMS,

  async separateStems() {
    const audio = get().audio;
    if (audio === null || get().stems.state === 'running') return;
    set({ stems: { ...get().stems, state: 'running', fraction: 0, stage: 'queued', message: null } });
    try {
      const done = await window.pulseforge.separateStems(audio.path, history.current.analysisSettings);
      // The stems are in the cache now, so analysing again is a hit that brings them with it.
      const payload = await window.pulseforge.analyzeAudio(audio.path, history.current.analysisSettings);
      if (get().audio?.path !== audio.path) return;
      set({
        analysis: analysisFromPayload(payload),
        stems: stemsFromPayload(payload, history.current.analysisSettings.stemModel),
        toast: { text: `Stems ready: ${done.stems.join(', ')} (${done.seconds.toFixed(1)} s)`, kind: 'ok' },
      });
    } catch (error) {
      const text = describeError(error, 'Separating the stems');
      set({ stems: { ...get().stems, state: 'failed', message: text }, toast: { text, kind: /cancelled/i.test(text) ? 'warn' : 'bad' } });
    }
  },

  async cancelStems() {
    await window.pulseforge.cancelStems();
  },

  reportStemsProgress(progress) {
    if (get().stems.state !== 'running') return;
    set({ stems: { ...get().stems, fraction: progress.fraction, stage: progress.stage, detail: progress.detail ?? null } });
  },

  liveModulation: { values: new Map(), levels: new Map(), issues: [] },

  reportModulation(live) {
    set({ liveModulation: live });
  },

  openBinding: null,

  setOpenBinding(id) {
    set({ openBinding: id });
  },

  matrixOpen: false,

  setMatrixOpen(open) {
    // One drawer at a time on the right edge.
    set(open ? { matrixOpen: true, queueOpen: false, lyricsOpen: false, autoOpen: false } : { matrixOpen: false });
  },

  autoOpen: false,
  setAutoOpen(open) {
    set(open ? { autoOpen: true, queueOpen: false, matrixOpen: false, lyricsOpen: false, autoOffer: false } : { autoOpen: false });
  },
  templates: [],
  milkdropPresets: [],
  templateProblems: [],
  templatesFolder: null,
  async loadTemplates() {
    try {
      const [listing, milkdrop] = await Promise.all([window.pulseforge.listTemplates(), milkdropIndex()]);
      const { templates, problems } = loadTemplateLibrary(listing.files);
      set({ templates, templateProblems: problems, templatesFolder: listing.folder, milkdropPresets: milkdrop?.presets.map((p) => p.name) ?? [] });
    } catch (error) {
      set({ toast: { text: describeError(error, 'Reading the templates'), kind: 'bad' } });
    }
  },
  autoLocks: [],
  setAutoLocks(locks) {
    set({ autoLocks: locks });
  },
  autoRoulette: false,
  setAutoRoulette(on) {
    set({ autoRoulette: on });
  },
  rollThumbs: {},
  autoOffer: false,
  dismissAutoOffer() {
    set({ autoOffer: false });
  },

  lyricsOpen: false,
  lyricsTab: 'text',
  setLyricsOpen(open, tab) {
    set(open
      ? { lyricsOpen: true, queueOpen: false, matrixOpen: false, autoOpen: false, ...(tab === undefined ? {} : { lyricsTab: tab }) }
      : { lyricsOpen: false });
  },

  lyricsSelection: [],
  setLyricsSelection(ids) {
    set({ lyricsSelection: ids });
  },

  async importLyricsFile() {
    try {
      const file = await window.pulseforge.openLyricsFile();
      if (file === null) return;
      const format = detectLyricsFormat(file.name, file.text);
      if (format === null) {
        // Plain text is a paste from a file: lines and section markers, no times.
        const existing = history.current.lyrics.lines.length;
        if (existing > 0 && !window.confirm(`Replace the ${existing} lyric lines with the text of ${file.name}? Lines whose text is unchanged keep their timing.`)) return;
        get().run(setLyricsText(file.text));
        set({
          toast: {
            text: `Read ${history.current.lyrics.lines.length} lines from ${file.name}. `
              + (get().alignAvailability?.available === true ? 'Align the lyrics (Lyrics panel) times them from the vocals in about a minute, or tap to sync.' : 'Tap to sync to give them times.'),
            kind: 'ok',
          },
        });
        return;
      }
      const imported = importLyricsFile(file.name, file.text);
      if (imported.lines.length === 0) {
        set({ toast: { text: `${file.name} has no timed lines Pulseforge could read.${imported.warnings.length > 0 ? `\n${imported.warnings.join('\n')}` : ''}`, kind: 'warn' } });
        return;
      }
      const existing = history.current.lyrics.lines.length;
      if (existing > 0 && !window.confirm(`Replace the ${existing} lyric lines with the ${imported.lines.length} timed lines from ${file.name}? (Undo brings them back.)`)) return;
      get().run(importLyrics(imported));
      const words = imported.lines.filter((l) => l.words !== null).length;
      set({
        toast: {
          text: `Imported ${imported.lines.length} lines from ${file.name}${words > 0 ? `, ${words} with word timings` : ''}.`
            + (imported.format === 'lrc'
              ? ` LRC timings are often 0.2–0.5 s off: check a few lines${get().alignAvailability?.available === true ? ', or refine them with Align the lyrics in the Lyrics panel' : ''} before rendering.`
              : '')
            + (imported.warnings.length > 0 ? `\n${imported.warnings.slice(0, 5).join('\n')}` : ''),
          kind: imported.warnings.length > 0 ? 'warn' : 'ok',
        },
      });
    } catch (error) {
      set({ toast: { text: describeError(error, 'Importing the lyrics'), kind: 'bad' } });
    }
  },

  async exportLyrics(format) {
    const document = history.current;
    const text = exportLyricsText(document.lyrics, format, { title: document.name, canvas: { width: document.canvas.width, height: document.canvas.height } });
    if (text.trim() === '' || text.trim() === 'WEBVTT') {
      set({ toast: { text: 'No lyric line has a time yet, so there is nothing to export.', kind: 'warn' } });
      return;
    }
    const clean = document.name.replace(/[^\w\- ]+/g, '').trim() || 'lyrics';
    const extension = format === 'elrc' ? 'lrc' : format;
    try {
      const path = await window.pulseforge.saveLyricsFile(`${clean}.${extension}`, text);
      if (path !== null) set({ toast: { text: `Exported ${path}`, kind: 'ok' } });
    } catch (error) {
      set({ toast: { text: describeError(error, 'Exporting the lyrics'), kind: 'bad' } });
    }
  },

  lyricSnap: { onsets: true, beats: false },
  setLyricSnap(patch) {
    set({ lyricSnap: { ...get().lyricSnap, ...patch } });
  },

  tap: null,
  setTap(tap) {
    set({ tap });
  },

  alignAvailability: null,
  async loadAlignAvailability() {
    try {
      set({ alignAvailability: await window.pulseforge.lyricsAlignAvailable() });
    } catch {
      set({ alignAvailability: { available: false, languages: [], reason: 'Could not ask the main process whether alignment is installed.' } });
    }
  },

  aligning: null,
  async alignLyrics(mode) {
    const document = history.current;
    const audio = get().audio;
    if (audio === null || document.audio.path === '') {
      set({ toast: { text: 'Load the track first: alignment listens to its vocals.', kind: 'warn' } });
      return;
    }
    if (get().aligning !== null) return;
    const { lyrics } = document;
    // Locked lines are human-verified: they are never sent, so they can never change (lyrics-spec §4).
    const lines = lyrics.lines.filter((l) => !l.locked && l.text.trim() !== '').map((l) => ({ id: l.id, text: l.text }));
    if (mode === 'align' && lines.length === 0) {
      set({ toast: { text: lyrics.lines.length === 0 ? 'There is no text to align: paste the lyrics first, or transcribe the vocals.' : 'Every line is locked, so there is nothing to align.', kind: 'warn' } });
      return;
    }
    if (mode === 'transcribe' && lyrics.lines.length > 0
      && !window.confirm(`Replace the ${lyrics.lines.length} lyric lines with a transcription of the vocals? Transcriptions of singing have errors; they are a starting point to correct. (Undo brings the current lines back.)`)) {
      return;
    }
    // A risky operation (ui-spec §10): snapshot the work first.
    await get().autosave('before aligning lyrics');
    const placement = { leadInTicks: document.audio.leadInTicks, clipInTicks: document.audio.clipInTicks };
    const rms = get().analysis?.sources.get('vocals')?.features.get('rms');
    const vocalSegments = rms === undefined ? undefined : detectVocalSegments(rms.data, rms.rate).map((s) => ({
      start: sourceToTimelineSeconds(s.start, placement),
      end: sourceToTimelineSeconds(s.end, placement),
    }));
    const request = {
      audioPath: audio.path,
      settings: document.analysisSettings,
      language: lyrics.language,
      mode,
      lines,
      placement,
      ...(vocalSegments === undefined ? {} : { vocalSegments }),
    };
    set({ aligning: { stage: 'decoding', fraction: 0 } });
    try {
      let reply = await window.pulseforge.alignLyrics(request);
      if (reply.status === 'needs-stems') {
        set({ aligning: null });
        if (!window.confirm(`${reply.message}\n\nSeparate the stems now (about a minute on the GPU) and then align?`)) return;
        await get().separateStems();
        if (get().stems.state !== 'ready') return;
        set({ aligning: { stage: 'decoding', fraction: 0 } });
        reply = await window.pulseforge.alignLyrics(request);
        if (reply.status === 'needs-stems') throw new Error(reply.message);
      }
      const { result } = reply;
      // The project may have changed while the GPU worked; the command writes to what is there now
      // and skips lines that were locked, edited or deleted in the meantime.
      if (result.mode === 'align') {
        const command = applyAlignment(result.aligned);
        get().run(command);
        const low = result.aligned.filter((l) => l.confidence !== null && l.confidence < 0.5).length;
        const flagged = [...result.rejected.map((r) => r.lineId).filter((id): id is string => id !== null), ...result.unplaced];
        if (flagged.length > 0) set({ lyricsSelection: flagged });
        const parts = [
          `Aligned ${result.aligned.length - command.skipped()} line${result.aligned.length === 1 ? '' : 's'} to the vocals${low > 0 ? ` (${low} low-confidence — check them)` : ''}.`,
          result.rejected.length > 0 ? `${result.rejected.length} refused by the sanity check and left as they were: ${result.rejected.slice(0, 3).map((r) => `“${r.text.slice(0, 24)}” — ${r.reason}`).join('; ')}.` : '',
          result.unplaced.length > 0 ? `${result.unplaced.length} not found in the vocals (a repeat not sung, or text that differs).` : '',
          command.skipped() > 0 ? `${command.skipped()} changed while aligning and were left alone.` : '',
          flagged.length > 0 ? 'Those lines are selected in the Lines tab.' : '',
        ].filter((p) => p !== '');
        set({ toast: { text: parts.join('\n'), kind: flagged.length > 0 || low > 0 ? 'warn' : 'ok' } });
      } else {
        get().run(setTranscribedLyrics(result.created));
        const missed = uncoveredSinging(vocalSegments ?? [], result.created.map((l) => ({ start: l.startTicks / TICKS_PER_SECOND, end: l.endTicks / TICKS_PER_SECOND })));
        const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
        set({
          toast: {
            text: `Transcribed ${result.created.length} lines from the vocals (heard as “${result.detectedLanguage}”). Expect errors: correct the text in the Text tab — timings are kept where the words still match.`
              + (result.rejected.length > 0 ? `\n${result.rejected.length} lines have line timing only (their words could not be aligned).` : '')
              + (missed.length > 0 ? `\nSinging with no line, where Whisper heard no words: ${missed.slice(0, 5).map((m) => `${clock(m.start)}–${clock(m.end)}`).join(', ')}${missed.length > 5 ? ` and ${missed.length - 5} more` : ''}. If there are words there, paste them and align.` : ''),
            kind: missed.length > 0 ? 'warn' : 'ok',
          },
        });
      }
    } catch (error) {
      const text = describeError(error, 'Aligning the lyrics');
      set({ toast: { text, kind: /cancelled/i.test(text) ? 'warn' : 'bad' } });
    } finally {
      set({ aligning: null });
    }
  },
  async cancelAlign() {
    await window.pulseforge.cancelLyricsAlign();
  },
  reportAlignProgress(progress) {
    if (get().aligning !== null) set({ aligning: progress });
  },

  settings: null,
  async loadSettings() {
    try {
      const { settings, problems } = await window.pulseforge.getSettings();
      applyTheme(settings.theme);
      // The preview's starting quality is the setting; changing it later in a session is the
      // session's business.
      set({ settings, previewScale: settings.previewScale, ...(problems.length > 0 ? { toast: { text: `Settings: ${problems.join('; ')}`, kind: 'warn' as const } } : {}) });
    } catch (error) {
      set({ toast: { text: describeError(error, 'Reading the settings'), kind: 'bad' } });
    }
  },
  async updateSettings(patch) {
    try {
      const settings = await window.pulseforge.updateSettings(patch);
      set({ settings });
      applyTheme(settings.theme);
      return null;
    } catch (error) {
      const text = describeError(error, 'Saving the settings');
      set({ toast: { text, kind: 'bad' } });
      return text;
    }
  },

  async setStemModel(model) {
    if (history.current.analysisSettings.stemModel === model) return;
    get().run(setStemModel(model));
    const audio = get().audio;
    if (audio !== null) await get().loadAudio(audio.path);
  },

  markerSelection: null,
  setMarkerSelection(id) {
    // One selection at a time on the timeline: a marker and keys never both answer Delete.
    set(id === null ? { markerSelection: null } : { markerSelection: id, keySelection: [] });
  },
  keySelection: [],
  setKeySelection(ids) {
    set(ids.length === 0 ? { keySelection: ids } : { keySelection: ids, markerSelection: null });
  },

  settingsOpen: false,
  setSettingsOpen(open) {
    set({ settingsOpen: open });
  },
}));

/**
 * The studio's theme (M36). Dark is the default and the one ui-spec §12 is designed around; light
 * and "follow Windows" swap the chrome's tokens, never the canvas.
 */
export function applyTheme(theme: UserSettings['theme']): void {
  const resolved = theme === 'system' ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : theme;
  document.documentElement.dataset['theme'] = resolved;
}

/** The lyrics as the editor's text (section markers as `[label]`). */
export function lyricsEditorText(): string {
  return lyricsToText(history.current.lyrics);
}
