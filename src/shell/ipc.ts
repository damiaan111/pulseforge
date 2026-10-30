// The contract between the Electron main process and the renderer.
//
// Shared by main, preload and the UI so all three agree by construction: a channel added here
// without a handler is a type error, not a silent no-op at runtime.
//
// **Only the main process touches the filesystem.** The renderer sends and receives project
// *text*; it parses and serialises with `src/project/`, which is pure. That split keeps the
// renderer sandboxed (no Node, no `fs`) and keeps the file on disk the single source of truth,
// rather than a structured-clone of an object graph that has been through IPC.

// Type-only: the queue and render service are main-process code, but the renderer needs their
// shapes. `import type` is erased, so none of their Node imports reach the browser bundle.
import type { JobStatus, RenderJob } from '../export/queue.ts';
import type { RenderRequest } from './render-service.ts';
import type { ModuleScan } from '../modules-folder/scan.ts';
import type { Preset } from '../project/presets.ts';
import type { TemplateFile } from '../director/template-library.ts';
import type { CacheCategory, CacheInventory } from '../cache/cache-store.ts';
import type { Section } from '../analysis/sections.ts';
import type { ProjectAnalysisSettings } from '../analysis/project-settings.ts';
import type { Component } from '../../setup/components.ts';
import type { BeatRefinement, BeatRefinementState } from '../analysis/beat-refinement.ts';

/** Channel names. Namespaced so a future channel cannot collide with Electron's own. */
export const IPC = {
  projectInitial: 'pf:project:initial',
  projectOpen: 'pf:project:open',
  projectRead: 'pf:project:read',
  projectSave: 'pf:project:save',
  projectPickSavePath: 'pf:project:pick-save-path',
  projectCollect: 'pf:project:collect',
  assetFindInFolder: 'pf:asset:find-in-folder',
  assetReveal: 'pf:asset:reveal',
  libraryList: 'pf:library:list',
  libraryAdd: 'pf:library:add',
  libraryThumbnail: 'pf:library:thumbnail',
  libraryReveal: 'pf:library:reveal',
  audioPick: 'pf:audio:pick',
  audioRead: 'pf:audio:read',
  audioAnalyze: 'pf:audio:analyze',
  stemAudio: 'pf:audio:stem',
  beatsRefine: 'pf:beats:refine',
  beatsCancel: 'pf:beats:cancel',
  recoveryWrite: 'pf:recovery:write',
  recoveryClear: 'pf:recovery:clear',
  recoveryList: 'pf:recovery:list',
  recoveryDiscard: 'pf:recovery:discard',
  settingsGet: 'pf:settings:get',
  settingsUpdate: 'pf:settings:update',
  settingsInfo: 'pf:settings:info',
  cacheInventory: 'pf:cache:inventory',
  cacheAction: 'pf:cache:action',
  revealCache: 'pf:cache:reveal',
  /** Main → renderer: the cache ceiling evicted something, or the disk is low (M33). */
  cacheNotice: 'pf:cache:notice',
  pickFolder: 'pf:pick-folder',
  logInfo: 'pf:log:info',
  revealLogs: 'pf:log:reveal',
  copyDiagnostics: 'pf:diagnostics:copy',
  revealPath: 'pf:reveal-path',
  setupRun: 'pf:setup:run',
  setupCancel: 'pf:setup:cancel',
  /** Main → renderer: one line of setup's output. */
  setupOutput: 'pf:setup:output',
  lyricsOpen: 'pf:lyrics:open',
  lyricsSave: 'pf:lyrics:save',
  lyricsAlignAvailable: 'pf:lyrics:align-available',
  lyricsAlign: 'pf:lyrics:align',
  lyricsAlignCancel: 'pf:lyrics:align-cancel',
  /** Main → renderer: how far the running alignment has got. */
  lyricsAlignProgress: 'pf:lyrics:align-progress',
  stemsSeparate: 'pf:stems:separate',
  stemsCancel: 'pf:stems:cancel',
  /** Main → renderer: how far the running separation has got. */
  stemsProgress: 'pf:stems:progress',
  modulesList: 'pf:modules:list',
  modulesReveal: 'pf:modules:reveal',
  modulesAddShadertoy: 'pf:modules:add-shadertoy',
  /** Main → renderer: something in modules/ changed on disk; list again. */
  modulesChanged: 'pf:modules:changed',
  presetsList: 'pf:presets:list',
  presetsSave: 'pf:presets:save',
  presetsDelete: 'pf:presets:delete',
  presetsFavourite: 'pf:presets:favourite',
  presetsThumbnail: 'pf:presets:thumbnail',
  presetsStoreThumbnail: 'pf:presets:store-thumbnail',
  presetsReveal: 'pf:presets:reveal',
  templatesList: 'pf:templates:list',
  templatesReveal: 'pf:templates:reveal',
  videoImport: 'pf:video:import',
  videoPrepare: 'pf:video:prepare',
  videoFrame: 'pf:video:frame',
  /** Main → renderer: frames extracted so far for a clip being prepared. */
  videoProgress: 'pf:video:progress',
  fontImport: 'pf:font:import',
  lutImport: 'pf:lut:import',
  lutLoad: 'pf:lut:load',
  fontLoad: 'pf:font:load',
  fontDefault: 'pf:font:default',
  fontFallbacks: 'pf:font:fallbacks',
  imageImport: 'pf:image:import',
  imageLoad: 'pf:image:load',
  environment: 'pf:app:environment',
  renderPickOutput: 'pf:render:pick-output',
  renderEnqueue: 'pf:render:enqueue',
  componentsInfo: 'pf:setup:components',
  milkdropIndex: 'pf:milkdrop:index',
  renderReadiness: 'pf:render:readiness',
  renderList: 'pf:render:list',
  renderCancel: 'pf:render:cancel',
  renderRetry: 'pf:render:retry',
  renderRemove: 'pf:render:remove',
  renderClearFinished: 'pf:render:clear-finished',
  renderReveal: 'pf:render:reveal',
  /** Main → renderer: the queue changed. */
  renderChanged: 'pf:render:changed',
  batchPickTracks: 'pf:batch:pick-tracks',
  batchStart: 'pf:batch:start',
  batchCancel: 'pf:batch:cancel',
  batchStatus: 'pf:batch:status',
  /** Main → renderer: the batch's status changed. */
  batchChanged: 'pf:batch:changed',
  queueSetShutdown: 'pf:queue:set-shutdown',
  queueCancelShutdown: 'pf:queue:cancel-shutdown',
  /** Main → renderer: every queued render and batch is finished. */
  queueFinished: 'pf:queue:finished',
} as const;

/** Pushed when all work is finished (export-spec §12): how it went, and a shutdown if one was asked for. */
export interface QueueFinishedEvent {
  readonly done: number;
  readonly failed: number;
  /** Seconds until the computer shuts down; null when "shut down when done" was off. */
  readonly shutdownInSeconds: number | null;
}

export type { RenderJob, JobStatus, RenderRequest, ModuleScan };
export type { BatchRequest, BatchStatus, BatchTrackStatus } from './batch-service.ts';
import type { BatchRequest, BatchStatus } from './batch-service.ts';
export type { Settings as UserSettings } from './settings-store.ts';
export type { LyricsAlignResult, LyricsAlignProgress, LyricsAlignMode } from '../ml/lyrics-align.ts';
import type { LyricsAlignMode, LyricsAlignProgress, LyricsAlignResult } from '../ml/lyrics-align.ts';

export interface LyricsAlignRequest {
  readonly audioPath: string;
  readonly settings: ProjectAnalysisSettings;
  readonly language: string;
  readonly mode: LyricsAlignMode;
  readonly lines: readonly { readonly id: string; readonly text: string }[];
  readonly placement: { readonly leadInTicks: number; readonly clipInTicks: number };
  /** Singing on the vocal stem, timeline seconds, for the sanity pass. */
  readonly vocalSegments?: readonly { readonly start: number; readonly end: number }[];
}
import type { Settings as UserSettings } from './settings-store.ts';

export interface ProjectFile {
  readonly path: string;
  readonly text: string;
}

export interface SaveRequest {
  readonly path: string;
  readonly text: string;
  /**
   * The schema version the file was stored at, when this save is the first after a migration.
   * The main process writes `name.v3.bak` before overwriting (data-formats §2.2), so a bad
   * migration is recoverable.
   */
  readonly backupFromVersion?: number;
}

export interface SaveResult {
  readonly path: string;
  /** Set when a pre-migration copy was written. */
  readonly backupPath?: string;
}


export interface AudioBytes {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/**
 * Everything the studio needs from an analysed track. The analysis is computed in the **main**
 * process through the same FFmpeg decode and on-disk cache the exporter uses, then handed over
 * as the binary container — so the preview reacts to exactly the numbers the export will,
 * rather than to whatever Chromium's own decoder produced. Playback is a separate concern and
 * may use the browser decoder, because the clock reads positions, not samples.
 */
export interface AnalysisPayload {
  /** `src/analysis/container.ts` bytes: spectrum, bands, features and the beat grid. */
  readonly container: Uint8Array;
  /** `src/analysis/peaks.ts` bytes: the waveform pyramid for the timeline. */
  readonly peaks: Uint8Array;
  /** With each section's mean energy: the director's drops are boundaries into much louder sections. */
  readonly sections: readonly Section[];
  /** What became of the project's refined grid (S16). */
  readonly beatRefinement: BeatRefinementState;
  /** Detected onsets in source seconds: the director puts drop impulses exactly on them. */
  readonly onsetTimes: readonly number[];
  readonly durationSeconds: number;
  readonly fromCache: boolean;
  /** The ready stems (M5), one container each — merged into the mix's analysis by the studio. */
  readonly stems: readonly { readonly name: string; readonly container: Uint8Array }[];
  /** Every stem's state in the cache: ready, pending (being separated) or failed with why. */
  readonly stemStatus: Readonly<Record<string, { readonly state: 'ready' | 'pending' | 'failed'; readonly error?: string }>>;
}

export interface LogInfo {
  readonly path: string;
  readonly level: 'error' | 'warn' | 'info' | 'debug';
  readonly bytes: number;
}

export type CacheAction =
  | { readonly kind: 'remove'; readonly ids: readonly string[] }
  | { readonly kind: 'clear'; readonly category: CacheCategory | 'all' }
  | { readonly kind: 'keepRecent'; readonly keep: number }
  | { readonly kind: 'clearLegacy' };

export interface CacheListing extends CacheInventory {
  /** Unit ids the studio is using now: never removed, by any action. */
  readonly inUse: readonly string[];
  readonly ceilingBytes: number;
  readonly lowDiskBytes: number;
  /** The analysis cache's old location (before the one cache root), when anything is left there. */
  readonly legacy: { readonly path: string; readonly bytes: number } | null;
}

export interface CacheActionResult {
  readonly removed: number;
  readonly freedBytes: number;
  /** Units left because they are in use. */
  readonly skipped: number;
  readonly listing: CacheListing;
}

export interface SettingsInfo {
  readonly stemModels: readonly string[];
  readonly whisperModels: readonly string[];
  /** The optional models (D8), each installable from Settings. */
  /** Languages with word alignment installed. */
  readonly alignLanguages: readonly string[];
  /** Chromium picks the GPU; this is the one in use, shown rather than chosen (ROADMAP §4). */
  readonly gpu: string;
  readonly paths: {
    readonly settings: string;
    readonly userData: string;
    readonly defaultCacheRoot: string;
    readonly presets: string;
    readonly templates: string;
  };
  readonly environment: EnvironmentReport;
}

export interface TemplateListing {
  readonly files: readonly TemplateFile[];
  /** The user templates folder, for "Open folder". */
  readonly folder: string;
}

/** A session that ended without a clean quit and left an autosave behind (M1). */
export interface RecoveryCandidate {
  readonly sessionId: string;
  readonly projectPath: string | null;
  readonly projectName: string;
  readonly savedAt: string;
  readonly reason: string;
  /** The newest autosave, as project text. */
  readonly text: string;
  /** The project file as it is on disk now, for the diff summary; null if never saved or unreadable. */
  readonly savedText: string | null;
}

/** Stem separation progress, pushed while it runs (M5). */
export interface StemProgressEvent {
  readonly stage: 'queued' | 'decoding' | 'separating' | 'analysing';
  readonly fraction: number;
  readonly detail?: string;
}

/** One preset as the browser shows it (S8). */
export interface PresetListing {
  readonly slug: string;
  readonly name: string;
  readonly scope: 'layer' | 'project';
  readonly tags: readonly string[];
  /** The module a layer preset is for; null for project presets. */
  readonly moduleId: string | null;
  readonly preset: Preset;
  readonly favourite: boolean;
  /** Names the cached animation strip; changes when the preset or the engine changes. */
  readonly thumbnailKey: string;
}

export interface PresetLibraryListing {
  readonly entries: readonly PresetListing[];
  /** Files that could not be read, with why — shown, never silently skipped. */
  readonly problems: readonly { readonly path: string; readonly message: string }[];
  /** Where user presets are saved. */
  readonly folder: string;
}

/**
 * A decoded image, from the main process. Decoded there, by the vendored FFmpeg, for the same
 * reason as the analysis: the export decodes the same way, so preview and export see the same
 * pixels. RGBA8, straight alpha, sRGB, top row first.
 */
export interface ImageBytes {
  readonly path: string;
  /** SHA-256 of the file bytes: the asset hash. */
  readonly hash: string;
  /** File size in bytes. */
  readonly size: number;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

/** Loading an image the project references: the pixels, or why not — distinguishable, for the asset panel. */
export type ImageLoadResult =
  | { readonly status: 'ok'; readonly image: ImageBytes }
  | { readonly status: 'missing'; readonly path: string }
  | { readonly status: 'error'; readonly path: string; readonly message: string };

/** A font file's bytes, for the preview's text rasteriser. Registered by `hash`, never looked up by name. */
export interface FontBytes {
  readonly path: string;
  readonly hash: string;
  readonly size: number;
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** A .cube LUT (S11): its text (parsed and checked by the main process on the way in) and identity. */
export interface LutFile {
  readonly path: string;
  readonly hash: string;
  readonly size: number;
  readonly name: string;
  readonly text: string;
  /** "3D, 33 points" — shown in the inspector. */
  readonly description: string;
}

export type LutLoadResult =
  | { readonly status: 'ok'; readonly lut: LutFile }
  | { readonly status: 'missing'; readonly path: string }
  | { readonly status: 'error'; readonly path: string; readonly message: string };

export type FontLoadResult =
  | { readonly status: 'ok'; readonly font: FontBytes }
  | { readonly status: 'missing'; readonly path: string }
  | { readonly status: 'error'; readonly path: string; readonly message: string };

/** A video file chosen for import: identified and measured, not yet extracted (M39). */
export interface VideoFile {
  readonly path: string;
  /** SHA-256 of the file's bytes: the asset hash and the frame-cache key. */
  readonly hash: string;
  readonly size: number;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly durationSeconds: number;
}

/** A clip's preview proxy, extracted and ready to read frames from. */
export interface VideoPrepared {
  readonly hash: string;
  readonly frameCount: number;
  readonly width: number;
  readonly height: number;
}

export type VideoPrepareResult =
  | { readonly status: 'ok'; readonly sequence: VideoPrepared }
  | { readonly status: 'missing'; readonly path: string }
  | { readonly status: 'error'; readonly path: string; readonly message: string };

/** A missing asset to look for, by content (src/assets/find-in-folder.ts). */
export interface WantedAsset {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly hash: string;
}

export interface FoundAsset {
  readonly id: string;
  readonly path: string;
  readonly size: number;
  readonly name: string;
  readonly hash: string;
}

export interface FolderSearchResult {
  readonly folder: string;
  readonly found: readonly FoundAsset[];
  readonly filesListed: number;
  readonly truncated: boolean;
}

export interface CollectSummary {
  readonly projectPath: string;
  readonly copied: number;
  readonly bytes: number;
  readonly problems: readonly string[];
}

/** One file in the managed library (M40, D6). */
export interface LibraryItem {
  readonly path: string;
  readonly name: string;
  readonly size: number;
  /** `backgrounds`, `logos`, … — the sub-folder it sits in; '' at the top level. */
  readonly category: string;
}

export interface LibraryListing {
  readonly folder: string;
  readonly items: readonly LibraryItem[];
}

/** The startup environment report (PROJECT.md M34, §8.15). */
export interface EnvironmentReport {
  readonly appVersion: string;
  readonly electronVersion: string;
  readonly chromeVersion: string;
  readonly nodeVersion: string;
  readonly platform: string;
  readonly arch: string;
  /** Absolute paths to the vendored binaries, and whether they are actually present. */
  readonly vendor: {
    readonly ffmpeg: { readonly path: string; readonly present: boolean };
    readonly ffprobe: { readonly path: string; readonly present: boolean };
    readonly python: { readonly path: string; readonly present: boolean };
  };
}

/**
 * What `contextBridge` exposes on `window.pulseforge`. Deliberately small: every entry is a
 * capability the renderer would otherwise not have, so the list is the security review.
 */
export interface RenderReadiness {
  /** Null when the encoders have not been checked: FFmpeg is missing. */
  readonly codecs: Readonly<Record<'h264' | 'hevc', { readonly available: boolean; readonly reason: string | null; readonly encoder: 'nvenc' | 'software' }>> | null;
  /** On the output file's drive; null with no output chosen, or when it cannot be read. */
  readonly freeBytes: number | null;
}

/** A component the chooser offers (setup/components.ts), and whether it is on this PC. */
export type ComponentRow = Component & { readonly installed: boolean };

export interface ComponentsInfo {
  readonly components: readonly ComponentRow[];
  /** Null: no NVIDIA card or driver answered. */
  readonly driver: { readonly name: string; readonly version: string; readonly major: number } | null;
  /** On the drive this folder is on; null when it cannot be read. */
  readonly freeBytes: number | null;
  readonly nonCommercialNotice: string;
}

export interface PulseforgeApi {
  /** The installed MilkDrop library, and the URL its scripts load from; null when not installed. */
  milkdropIndex(): Promise<{ readonly baseUrl: string; readonly presets: readonly { readonly name: string; readonly file: string }[] } | null>;
  /** What can be installed, and what this PC can run. */
  componentsInfo(): Promise<ComponentsInfo>;
  /**
   * The project named on the command line (`pulseforge song.pvproj`), or by a double-click
   * once the file type is associated. Null when the app was started with nothing to open.
   * Asked for by the renderer on boot rather than pushed, so there is no race with rendering.
   */
  initialProject(): Promise<ProjectFile | null>;
  /** Shows an open dialog. Resolves to null when the user cancels. */
  openProject(): Promise<ProjectFile | null>;
  /** Reads a known path — for recent files and the crash-recovery flow. */
  readProject(path: string): Promise<ProjectFile>;
  saveProject(request: SaveRequest): Promise<SaveResult>;
  /**
   * Shows a save dialog and only returns the path. The document is serialised *after*, against
   * that path, because paths inside the project folder are stored relative to it.
   */
  pickProjectSavePath(suggestedName: string): Promise<string | null>;
  /** "Collect files": asks for a folder, copies the project's media into it, writes the project there. */
  collectProject(text: string): Promise<CollectSummary | null>;
  /** Asks for a folder and searches it for the given missing files, by content. */
  findAssetsInFolder(wanted: readonly WantedAsset[]): Promise<FolderSearchResult | null>;
  /** Opens the OS file manager at a file, if it exists. */
  revealAsset(path: string): Promise<void>;
  /** The managed library folder's image files. Creates the folder on first use. */
  listLibrary(): Promise<LibraryListing>;
  /** Asks for image files and copies them into the library (optionally a category folder). */
  addToLibrary(category: string): Promise<LibraryListing>;
  /** A small decode of a library image, for the panel's thumbnail. */
  libraryThumbnail(path: string): Promise<ImageBytes>;
  revealLibrary(): Promise<void>;
  /** Shows an open dialog for audio. Resolves to null when the user cancels. */
  pickAudio(): Promise<string | null>;
  /** Raw file bytes, for a Blob URL the `<audio>` element can play. */
  readAudio(path: string): Promise<AudioBytes>;
  /** Decode + analyse through the shared cache. Slow on a miss, instant on a hit. */
  /**
   * `settings` is the project's `analysisSettings` (bands, onset sensitivity, tempo override): the
   * same mapping the exporter uses (analysis/project-settings.ts), so preview and export agree.
   */
  analyzeAudio(path: string, settings: ProjectAnalysisSettings): Promise<AnalysisPayload>;
  /** A separated stem's audio file, for soloing it in the preview. */
  readStemAudio(path: string, stem: string, stemModel: string): Promise<{ readonly bytes: Uint8Array }>;
  /** Tracks the beats with librosa (S16). Rejects with a sentence, including on cancel. */
  refineBeats(path: string, stemModel: string): Promise<BeatRefinement>;
  cancelRefineBeats(): Promise<void>;
  /**
   * Separates the track into stems with Demucs and analyses each (M5), through the GPU queue (M28).
   * Minutes on a long track the first time; the result lands in the analysis cache, so
   * `analyzeAudio` returns the stems from then on. Rejects with a sentence on failure or cancel.
   */
  separateStems(path: string, settings: ProjectAnalysisSettings): Promise<{ readonly stems: readonly string[]; readonly seconds: number }>;
  cancelStems(): Promise<void>;
  /**
   * Autosave (M1): a snapshot of the project for this run of the studio, kept until a clean quit or
   * a save clears it. `reason` says why it was taken ("every minute", "before applying a preset").
   */
  writeRecovery(snapshot: { readonly text: string; readonly projectPath: string | null; readonly projectName: string; readonly reason: string }): Promise<void>;
  /** Everything is saved: drop this run's autosaves. */
  clearRecovery(): Promise<void>;
  /** Earlier runs that ended without a clean quit and left an autosave, newest first. */
  listRecovery(): Promise<readonly RecoveryCandidate[]>;
  discardRecovery(sessionId: string): Promise<void>;
  /** User settings (data-formats §6), with any problems reading them. */
  getSettings(): Promise<{ readonly settings: UserSettings; readonly problems: readonly string[] }>;
  /** Merges and saves; resolves to the settings as saved. */
  updateSettings(patch: Partial<UserSettings>): Promise<UserSettings>;
  /** Everything in the cache, by unit, biggest first, with free space and the ceiling (M33). */
  cacheInventory(): Promise<CacheListing>;
  /** Removes units, clears a category, keeps the last N tracks, or clears the pre-0.x location. */
  cacheAction(action: CacheAction): Promise<CacheActionResult>;
  revealCache(): Promise<void>;
  /** The ceiling evicted something, or the disk is low. */
  onCacheNotice(listener: (text: string) => void): () => void;
  /** Where the log is, how big, at what level (M34). */
  logInfo(): Promise<LogInfo>;
  revealLogs(): Promise<void>;
  /** Environment, settings, cache, the log's tail — and a failed job's details — to the clipboard. */
  copyDiagnostics(options?: { readonly jobId?: string }): Promise<{ readonly lines: number; readonly text: string }>;
  /** A folder picker; null when cancelled. */
  pickFolder(title: string): Promise<string | null>;
  /** What the Settings screen offers: installed models, the GPU in use, where things live. */
  settingsInfo(): Promise<SettingsInfo>;
  /** Opens one of the app's own folders ('userData', 'settings') in the file manager. */
  revealPath(which: 'userData' | 'settings'): Promise<void>;
  /** Runs `npm run setup -- --verify` or `--tier <tier>`; output arrives through `onSetupOutput`. */
  runSetup(request: { readonly mode: 'verify' } | { readonly mode: 'rebuild-check' } | { readonly mode: 'components'; readonly components: readonly string[]; readonly acceptNonCommercial: boolean } | { readonly mode: 'repair'; readonly tier: 'core' | 'stems' | 'lyrics' | 'beats' | 'milkdrop' } | { readonly mode: 'extra'; readonly extra: string }): Promise<{ readonly code: number | null }>;
  cancelSetup(): Promise<void>;
  onSetupOutput(listener: (line: string) => void): () => void;
  /** Shows an open dialog for a lyrics file (.lrc, .srt, .vtt, .ttml, .txt). Null when cancelled. */
  openLyricsFile(): Promise<{ readonly name: string; readonly text: string } | null>;
  /** Shows a save dialog and writes exported lyrics. Resolves to the path, or null when cancelled. */
  saveLyricsFile(suggestedName: string, text: string): Promise<string | null>;
  /** Whether WhisperX alignment is installed (setup's lyrics tier), and for which languages. */
  lyricsAlignAvailable(): Promise<{ readonly available: boolean; readonly languages: readonly string[]; readonly reason: string | null }>;
  /**
   * Transcribes the track's vocal stem and aligns lyrics to it (M26), through the GPU queue.
   * `needs-stems` when the track has not been separated yet: alignment only runs on the vocals.
   */
  alignLyrics(request: LyricsAlignRequest): Promise<{ readonly status: 'ok'; readonly result: LyricsAlignResult } | { readonly status: 'needs-stems'; readonly message: string }>;
  cancelLyricsAlign(): Promise<void>;
  onLyricsAlignProgress(listener: (progress: LyricsAlignProgress) => void): () => void;
  onStemsProgress(listener: (progress: StemProgressEvent) => void): () => void;
  /** The drop-in modules folder, scanned now: loadable modules and per-folder problems (M35). */
  listModules(): Promise<ModuleScan>;
  /** Opens the modules folder in the file manager, creating it if needed. */
  revealModules(): Promise<void>;
  /**
   * Saves pasted Shadertoy code as `modules/<name>.glsl` (S2), never overwriting: a taken name gets
   * " 2", " 3"…. Resolves with the file name and the module id it will load under.
   */
  addShadertoy(request: { readonly name: string; readonly code: string }): Promise<{ readonly fileName: string; readonly id: string }>;
  /** Called when files in modules/ change, so the studio can reload without a restart. */
  onModulesChanged(listener: () => void): () => void;
  /** Built-in and user presets, favourites marked (S8). */
  listPresets(): Promise<PresetLibraryListing>;
  /** Saves into the user library; a name already taken gets a suffix, never an overwrite. */
  savePreset(preset: Preset): Promise<{ readonly slug: string; readonly library: PresetLibraryListing }>;
  /** Deletes a user preset. Built-ins refuse with a message saying so. */
  deletePreset(scope: 'layer' | 'project', slug: string): Promise<PresetLibraryListing>;
  setPresetFavourite(scope: 'layer' | 'project', slug: string, on: boolean): Promise<PresetLibraryListing>;
  /** A cached thumbnail strip (PNG), or null when it has not been rendered yet. */
  presetThumbnail(key: string): Promise<Uint8Array | null>;
  /** Caches a thumbnail strip the renderer drew. */
  storePresetThumbnail(key: string, png: Uint8Array): Promise<void>;
  /** Opens the user presets folder in the file manager. */
  revealPresets(): Promise<void>;
  /** The auto-director's templates as files, built-in and user (M21); the studio parses them. */
  listTemplates(): Promise<TemplateListing>;
  /** Opens the user templates folder in the file manager, creating it if needed. */
  revealTemplates(): Promise<void>;
  /** Shows an open dialog for a video and identifies it. Extraction is `prepareVideo`. */
  importVideo(): Promise<VideoFile | null>;
  /**
   * Extracts (or reuses) the preview proxy of a clip at the project's fps. Slow the first time;
   * progress arrives through `onVideoProgress`.
   */
  prepareVideo(request: { path: string; projectPath: string | null; hash: string; fps: { num: number; den: number }; maxFrames: number }): Promise<VideoPrepareResult>;
  /** One still of a prepared proxy, as JPEG bytes. */
  videoFrame(hash: string, fps: { num: number; den: number }, sourceFrame: number): Promise<Uint8Array>;
  onVideoProgress(listener: (hash: string, frames: number) => void): () => void;
  /** Shows an open dialog for a font file (starting in the bundled fonts). Null when cancelled. */
  importFont(): Promise<FontBytes | null>;
  /** Reads a font the project references; the path may be relative to `projectPath`. */
  loadFont(path: string, projectPath: string | null): Promise<FontLoadResult>;
  /** A .cube file chosen for a LUT effect (S11); null when cancelled. A malformed file is refused with its line. */
  importLut(): Promise<LutFile | null>;
  loadLut(path: string, projectPath: string | null): Promise<LutLoadResult>;
  /** The bundled default typeface (Inter Regular). */
  defaultFont(): Promise<FontBytes>;
  /** The bundled fallback chain (S17), in order. */
  fallbackFonts(): Promise<readonly { readonly hash: string; readonly bytes: Uint8Array }[]>;
  /** Shows an open dialog for an image and decodes it. Resolves to null when the user cancels. */
  importImage(): Promise<ImageBytes | null>;
  /** Decodes an asset the project already references; the path may be relative to `projectPath`. */
  loadImage(path: string, projectPath: string | null): Promise<ImageLoadResult>;
  environment(): Promise<EnvironmentReport>;

  /** Shows a save dialog for a render's output. Resolves to null when the user cancels. */
  pickRenderOutput(suggestedName: string): Promise<string | null>;
  /** Can this machine encode, and how much room is there where the file would go (export-spec §14). */
  renderReadiness(outputPath: string | null): Promise<RenderReadiness>;
  /** Snapshots the document as it is now and queues it (export-spec §12). */
  enqueueRender(request: RenderRequest): Promise<RenderJob>;
  listRenders(): Promise<readonly RenderJob[]>;
  cancelRender(id: string): Promise<void>;
  retryRender(id: string): Promise<void>;
  removeRender(id: string): Promise<void>;
  clearFinishedRenders(): Promise<void>;
  /** Opens the OS file manager at a finished render. Only paths the queue itself produced. */
  revealRender(path: string): Promise<void>;
  /** Subscribes to queue changes; returns the unsubscribe function. */
  onRendersChanged(listener: (jobs: readonly RenderJob[]) => void): () => void;

  // Batch mode (S13).
  /** A multi-select open dialog for audio files; empty when cancelled. */
  pickBatchTracks(): Promise<readonly string[]>;
  /** The file-system path of a dropped file (Electron's webUtils); '' when it has none. */
  pathForFile(file: File): string;
  /** Plans and starts a batch; each track is queued for rendering as soon as it is directed. */
  startBatch(request: BatchRequest): Promise<BatchStatus>;
  /** Stops directing further tracks; queued renders stay in the queue. */
  cancelBatch(): Promise<void>;
  batchStatus(): Promise<BatchStatus | null>;
  onBatchChanged(listener: (status: BatchStatus) => void): () => void;
  /** "Shut down when done" (export-spec §12, ui-spec §7). */
  setShutdownWhenDone(on: boolean): Promise<boolean>;
  /** Aborts a shutdown that has been scheduled. */
  cancelShutdown(): Promise<void>;
  onQueueFinished(listener: (event: QueueFinishedEvent) => void): () => void;
}

declare global {
  interface Window {
    readonly pulseforge: PulseforgeApi;
  }
}
