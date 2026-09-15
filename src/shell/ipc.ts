// The contract between the Electron main process and the renderer.
//
// Shared by main, preload and the UI so all three agree by construction: a channel added here
// without a handler is a type error, not a silent no-op at runtime.
//
// **Only the main process touches the filesystem.** The renderer sends and receives project
// *text*; it parses and serialises with `src/project/`, which is pure. That split keeps the
// renderer sandboxed (no Node, no `fs`) and keeps the file on disk the single source of truth,
// rather than a structured-clone of an object graph that has been through IPC.

/** Channel names. Namespaced so a future channel cannot collide with Electron's own. */
export const IPC = {
  projectInitial: 'pf:project:initial',
  projectOpen: 'pf:project:open',
  projectRead: 'pf:project:read',
  projectSave: 'pf:project:save',
  projectSaveAs: 'pf:project:save-as',
  audioPick: 'pf:audio:pick',
  audioRead: 'pf:audio:read',
  audioAnalyze: 'pf:audio:analyze',
  environment: 'pf:app:environment',
} as const;

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
  /** Shows a save dialog. Resolves to null when the user cancels. */
  saveProjectAs(text: string, suggestedName: string): Promise<SaveResult | null>;
  /** Shows an open dialog for audio. Resolves to null when the user cancels. */
  pickAudio(): Promise<string | null>;
  /** Raw file bytes, for a Blob URL the `<audio>` element can play. */
  readAudio(path: string): Promise<AudioBytes>;
  /** Decode + analyse through the shared cache. Slow on a miss, instant on a hit. */
  analyzeAudio(path: string): Promise<AnalysisPayload>;
  environment(): Promise<EnvironmentReport>;
}

declare global {
  interface Window {
    readonly pulseforge: PulseforgeApi;
  }
}
