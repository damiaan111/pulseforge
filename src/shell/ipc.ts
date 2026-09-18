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
  fontImport: 'pf:font:import',
  fontLoad: 'pf:font:load',
  fontDefault: 'pf:font:default',
  imageImport: 'pf:image:import',
  imageLoad: 'pf:image:load',
  environment: 'pf:app:environment',
  renderPickOutput: 'pf:render:pick-output',
  renderEnqueue: 'pf:render:enqueue',
  renderList: 'pf:render:list',
  renderCancel: 'pf:render:cancel',
  renderRetry: 'pf:render:retry',
  renderRemove: 'pf:render:remove',
  renderClearFinished: 'pf:render:clear-finished',
  renderReveal: 'pf:render:reveal',
  /** Main → renderer: the queue changed. The only channel pushed rather than asked for. */
  renderChanged: 'pf:render:changed',
} as const;

export type { RenderJob, JobStatus, RenderRequest };

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
  readonly sections: readonly { readonly startSeconds: number; readonly endSeconds: number; readonly label: string }[];
  readonly durationSeconds: number;
  readonly fromCache: boolean;
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

export type FontLoadResult =
  | { readonly status: 'ok'; readonly font: FontBytes }
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
export interface PulseforgeApi {
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
  analyzeAudio(path: string): Promise<AnalysisPayload>;
  /** Shows an open dialog for a font file (starting in the bundled fonts). Null when cancelled. */
  importFont(): Promise<FontBytes | null>;
  /** Reads a font the project references; the path may be relative to `projectPath`. */
  loadFont(path: string, projectPath: string | null): Promise<FontLoadResult>;
  /** The bundled default typeface (Inter Regular). */
  defaultFont(): Promise<FontBytes>;
  /** Shows an open dialog for an image and decodes it. Resolves to null when the user cancels. */
  importImage(): Promise<ImageBytes | null>;
  /** Decodes an asset the project already references; the path may be relative to `projectPath`. */
  loadImage(path: string, projectPath: string | null): Promise<ImageLoadResult>;
  environment(): Promise<EnvironmentReport>;

  /** Shows a save dialog for a render's output. Resolves to null when the user cancels. */
  pickRenderOutput(suggestedName: string): Promise<string | null>;
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
}

declare global {
  interface Window {
    readonly pulseforge: PulseforgeApi;
  }
}
