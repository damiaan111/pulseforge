// The Electron main process.
//
// This file is the app's security boundary, and it is written to be read as one. The spike
// renderer ran with `nodeIntegration: true` and `contextIsolation: false` because it was a
// measurement harness that only ever loaded its own bundle; the app must not, and STATUS has
// carried that as a known gap since P0. It is closed here.
//
// The posture, and why each part earns its place:
//
//  - **Sandboxed renderer, context isolation on, no Node integration.** The renderer runs
//    project files and, later, drop-in modules from `modules/` (module-spec §12). Those are
//    local files the user placed deliberately, but "trusted enough to run" is not "trusted
//    enough to have `fs`". Everything it needs arrives through the narrow API in ipc.ts.
//  - **Navigation and new windows are denied.** There is nowhere legitimate to navigate to:
//    the app is one local page. A layer that could navigate the window away is a layer that
//    could replace the app with something else.
//  - **Every non-local request is blocked at the session level.** PROJECT.md §3 makes "runs
//    fully offline after setup" a first-class requirement, not packaging polish. Enforcing it
//    here means a stray CDN link or a font fetch *fails visibly during development* rather
//    than working on this machine and breaking on a disconnected one.
//  - **A strict CSP** on top, so an injected script tag has nowhere to load from either.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, watch } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { BrowserWindow, app, dialog, ipcMain, session, shell } from 'electron';
import { DEFAULT_FONT_FILE, FFMPEG_EXE, FFPROBE_EXE, MODELS, MODULES_DIR, PYTHON_EXE, ROOT, VENDOR } from '../../setup/lib/paths.ts';
import { WAV2VEC2_EN } from '../../setup/manifest.ts';
import { ALIGN_LANGUAGES, LyricsNeedStemsError, alignLyrics, type LyricsAlignProgress } from '../ml/lyrics-align.ts';
import { FONT_EXTENSIONS } from '../assets/fonts.ts';
import { AnalysisCache } from '../analysis/cache.ts';
import { analyzeCached } from '../analysis/cached.ts';
import { readTemplateFiles } from '../director/template-store.ts';
import { CACHE_CATEGORIES, CacheStore, sizeOf, type CacheCategory } from '../cache/cache-store.ts';
import { synthesizeTestTrack } from '../analysis/reference-track.ts';
import { encodeWavFloat32 } from '../export/audio.ts';
import { cacheOptionsFor, parseProjectAnalysisSettings } from '../analysis/project-settings.ts';
import { encodeAnalysis } from '../analysis/container.ts';
import { decodeMono48k } from '../analysis/decode.ts';
import { encodePeaks } from '../analysis/peaks.ts';
import {
  IPC, type AnalysisPayload, type AudioBytes, type CollectSummary, type EnvironmentReport, type FolderSearchResult, type FontBytes, type FontLoadResult,
  type ImageBytes, type ImageLoadResult, type LibraryListing, type ProjectFile, type SaveRequest, type SaveResult, type VideoFile,
  type VideoPrepareResult, type WantedAsset, type PresetLibraryListing, type StemProgressEvent, type RecoveryCandidate, type LyricsAlignRequest, type TemplateListing, type SettingsInfo, type CacheListing, type CacheActionResult,
} from './ipc.ts';
import { IMAGE_EXTENSIONS, decodeImageFile } from '../assets/image-decode.ts';
import { resolveAssetPath } from '../assets/load-images.ts';
import { collectProject } from '../assets/collect-files.ts';
import { findFilesInFolder } from '../assets/find-in-folder.ts';
import { addToLibrary, listLibrary } from '../assets/library.ts';
import {
  PROXY_WIDTH, VIDEO_EXTENSIONS, extractSequence, framePath, hashVideoFile, probeVideo, sequenceDir,
} from '../assets/video-cache.ts';
import { loadDocument } from '../project/load.ts';
import { scanModules, type ModuleScan } from '../modules-folder/scan.ts';
import { BUILTIN_MODULES, ENGINE_VERSION } from '../engine/engine.ts';
import { SidecarSupervisor, spawnPythonSidecar } from '../ml/supervisor.ts';
import { StemsCancelledError, separateStems } from '../ml/stems.ts';
import { GpuJobCancelledError, GpuQueue } from '../node/gpu-queue.ts';
import { newId } from '../project/ids.ts';
import { RecoveryStore } from '../project/recovery-store.ts';
import { DEFAULT_SETTINGS, SettingsStore, validateSettingsPatch, type Settings as UserSettings } from './settings-store.ts';
import { pythonEnv } from '../../setup/lib/env.ts';
import { PresetStore, presetThumbnailKey } from '../project/preset-store.ts';
import { parsePreset } from '../project/presets.ts';
import { ProjectIoError, readProjectText, writeProjectText } from './project-io.ts';
import { RenderRequestError, createRenderService, type RenderRequest, type RenderService } from './render-service.ts';
import { createDocument, createModuleLayer } from '../project/create.ts';
import { stringifyDocument } from '../project/serialize.ts';

/** Library thumbnails: decoded this small, so a panel of fifty costs little. */
const THUMBNAIL_SIDE = 160;

/**
 * The one cache root (M33, PROJECT.md §8.14): analysis, stems, video proxies, preset thumbnails and
 * scratch all live under it, so the cache screen can account for every byte. A setting; by default
 * `<repo>/cache`, the same root the CLI and the contact sheet use, so a track analysed by one is a
 * cache hit for the others. Read per use, so changing it in Settings applies at once (what is
 * already cached stays where it was, and is rebuildable).
 */
function cacheRootPath(): string {
  return currentSettings.cacheRoot ?? join(ROOT, 'cache');
}

/** The analysis cache the preview and the render queue share, so a queued render is a cache hit. */
function analysisCacheRoot(): string {
  return cacheRootPath();
}

function scratchPath(): string {
  return currentSettings.scratchDir ?? join(cacheRootPath(), 'scratch');
}

/** Where analysis was cached before the one cache root (0.x): offered for clearing, never read. */
function legacyCachePath(): string {
  return join(app.getPath('userData'), 'cache');
}

function cacheStore(): CacheStore {
  return new CacheStore({ root: cacheRootPath() });
}

/**
 * Cache units the studio is using this session — the track last analysed, the videos prepared —
 * which the LRU ceiling never evicts. Main does not see the renderer's project, so it keeps what it
 * served: a ceiling that deleted the stems being listened to would look exactly like data loss.
 */
const cacheInUse = new Set<string>();
let lastTrackInUse: string | null = null;

let upkeepTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * After anything is written to the cache: enforce the ceiling (least recently used first) and check
 * the free space, a few seconds later so a burst of writes costs one scan. What it did is reported
 * to the studio (and the log) rather than done silently.
 */
function scheduleCacheUpkeep(): void {
  if (upkeepTimer !== null) clearTimeout(upkeepTimer);
  upkeepTimer = setTimeout(() => {
    upkeepTimer = null;
    void cacheUpkeep();
  }, 3000);
}

async function cacheUpkeep(): Promise<void> {
  const notices: string[] = [];
  try {
    const store = cacheStore();
    const ceiling = currentSettings.cacheCeilingGb * 1e9;
    if (ceiling > 0) {
      const result = await store.enforceCeiling(ceiling, cacheInUse);
      if (result.removed.length > 0) {
        const freed = result.removed.reduce((a, u) => a + u.bytes, 0);
        notices.push(`Cache over its ${currentSettings.cacheCeilingGb} GB ceiling: removed ${result.removed.length} least recently used item${result.removed.length === 1 ? '' : 's'} (${(freed / 1e9).toFixed(2)} GB) — ${result.removed.map((u) => u.label).slice(0, 3).join(', ')}${result.removed.length > 3 ? '…' : ''}. They are rebuilt when needed.`);
      }
      if (result.overBy > 0) notices.push(`The cache is over its ceiling by ${(result.overBy / 1e9).toFixed(2)} GB with only what is in use left in it.`);
    }
    const warn = currentSettings.lowDiskWarningGb * 1e9;
    if (warn > 0) {
      const free = (await store.inventory()).freeBytes;
      if (free !== null && free < warn) notices.push(`Only ${(free / 1e9).toFixed(1)} GB free on the cache drive (warning below ${currentSettings.lowDiskWarningGb} GB). Settings → Storage shows what can go.`);
    }
  } catch (error) {
    notices.push(`Checking the cache failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const text of notices) {
    console.warn(`[cache] ${text}`);
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send(IPC.cacheNotice, text);
  }
}

/**
 * The ML sidecar (M27): one resident Python, started on first use, stopped when idle so torch hands
 * its VRAM back, and stopped before every render by the GPU queue.
 */
let sidecarInstance: SidecarSupervisor | null = null;
function sidecar(): SidecarSupervisor {
  sidecarInstance ??= new SidecarSupervisor({
    spawn: spawnPythonSidecar(PYTHON_EXE, join(ROOT, 'python'), pythonEnv()),
    newId,
    idleTimeoutMs: 60_000,
    onLog: (message) => console.log(`[sidecar] ${message}`),
  });
  return sidecarInstance;
}

/**
 * Autosave and crash recovery (M1). This run's session id names its folder of snapshots; a clean
 * quit removes it, so a folder found at the next start is a run that crashed. `PULSEFORGE_RECOVERY`
 * moves the folder — the smoke check uses its own, so it never sees or touches the owner's.
 */
const recoverySessionId = newId();
/**
 * A clean quit: this run's autosaves are not needed at the next start. (A crash never gets here,
 * which is the whole mechanism.) If the user chose to quit with unsaved changes, they were asked
 * and said discard.
 */
function endRecoverySession(): void {
  try {
    recoveryStore().clearSync(recoverySessionId);
  } catch (error) {
    console.error(`[recovery] could not clear this session's autosaves: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** User settings (data-formats §6). `PULSEFORGE_SETTINGS` points it elsewhere — the smoke check does. */
function settingsStore(): SettingsStore {
  return new SettingsStore(settingsPath());
}

function recoveryStore(): RecoveryStore {
  return new RecoveryStore({ root: process.env['PULSEFORGE_RECOVERY'] ?? join(app.getPath('userData'), 'recovery') });
}

/**
 * The global GPU job queue (M28): renders and ML jobs take turns, renders first, and the sidecar's
 * models are freed before each render.
 */
const gpuQueue = new GpuQueue({
  beforeRender: async () => {
    await sidecarInstance?.stop();
  },
});

/** Where the bundled renderer lives, relative to the compiled main bundle. */
const RENDERER_DIR = join(import.meta.dirname, 'renderer');
const RENDERER_HTML = join(RENDERER_DIR, 'index.html');

const PROJECT_FILTERS = [
  { name: 'Pulseforge project', extensions: ['pvproj'] },
  { name: 'All files', extensions: ['*'] },
];

/**
 * The only schemes the renderer may load. `devtools:` is Chromium's own inspector, which is
 * not a network request; everything else — http, https, ws — is refused and logged.
 */
const ALLOWED_SCHEMES = new Set(['file:', 'devtools:', 'blob:', 'data:']);

function lockDownSession(): void {
  const current = session.defaultSession;

  current.webRequest.onBeforeRequest((details, callback) => {
    let scheme: string;
    try {
      scheme = new URL(details.url).protocol;
    } catch {
      callback({ cancel: true });
      return;
    }
    if (ALLOWED_SCHEMES.has(scheme)) {
      callback({});
      return;
    }
    // Loud on purpose. A blocked request here is a bug in the app — something reached for the
    // network — and finding it now beats discovering it on a machine with the cable pulled.
    console.error(`[offline] blocked a network request to ${details.url}\n` +
      '  Pulseforge must resolve everything from vendor/ or the user\'s disk (PROJECT.md §3).');
    callback({ cancel: true });
  });

  current.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
          "img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; " +
          "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        ],
      },
    });
  });

  // No permission the app needs is one the renderer should be able to ask for.
  current.setPermissionRequestHandler((_contents, permission, callback) => {
    console.error(`[security] denied a "${permission}" permission request from the renderer`);
    callback(false);
  });
}

function guardWebContents(): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (event, url) => {
      // The app is one local page; there is no legitimate navigation.
      if (url !== contents.getURL()) {
        event.preventDefault();
        console.error(`[security] blocked navigation to ${url}`);
      }
    });
    contents.setWindowOpenHandler(({ url }) => {
      // Documentation and "reveal in folder" go to the OS, never to an in-app window with
      // app privileges. Only obviously safe schemes, and only on an explicit user action.
      if (url.startsWith('https://') || url.startsWith('file://')) void shell.openExternal(url);
      return { action: 'deny' };
    });
    contents.on('will-attach-webview', (event) => {
      event.preventDefault();
    });
  });
}

let cachedPackageVersion: string | undefined;
function packageVersion(): string {
  if (cachedPackageVersion === undefined) {
    try {
      cachedPackageVersion = String((JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version?: unknown }).version ?? 'unknown');
    } catch {
      cachedPackageVersion = app.getVersion();
    }
  }
  return cachedPackageVersion;
}

function environmentReport(): EnvironmentReport {
  const present = (path: string) => ({ path, present: existsSync(path) });
  return {
    // The package's own version: unpackaged (npm run dev), app.getVersion() reports Electron's.
    appVersion: packageVersion(),
    electronVersion: process.versions['electron'] ?? 'unknown',
    chromeVersion: process.versions['chrome'] ?? 'unknown',
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    // Always absolute, never resolved from PATH: this machine has a system FFmpeg and Python
    // that must never be picked up (PROJECT.md §3).
    vendor: { ffmpeg: present(FFMPEG_EXE), ffprobe: present(FFPROBE_EXE), python: present(PYTHON_EXE) },
  };
}

/** Turns an I/O failure into something the UI can show, never a raw stack trace (ui-spec §11). */
function describe(error: unknown): Error {
  if (error instanceof ProjectIoError) {
    const fixes = error.fixes.length > 0 ? `\n\nTry:\n${error.fixes.map((f) => `• ${f}`).join('\n')}` : '';
    return new Error(`${error.message}${fixes}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * A project named on the command line, for `pulseforge song.pvproj` and for a double-click once
 * the file type is associated. Electron's argv carries its own switches, so only a path that
 * exists and looks like a project is accepted — anything else is ignored rather than guessed at.
 */
/** The settings as last read or saved; what the main process consults (models, caches, logs). */
let currentSettings: UserSettings = DEFAULT_SETTINGS;

function settingsPath(): string {
  return process.env['PULSEFORGE_SETTINGS'] ?? join(app.getPath('userData'), 'settings.json');
}

function presetsFolderPath(): string {
  return process.env['PULSEFORGE_PRESETS'] ?? join(app.getPath('documents'), 'Pulseforge', 'Presets');
}

function templatesFolderPath(): string {
  return process.env['PULSEFORGE_TEMPLATES'] ?? join(app.getPath('documents'), 'Pulseforge', 'Templates');
}

/** Set in smoke mode: "Import audio…" answers with this file instead of opening a dialog. */
let smokeAudioPath: string | null = null;

/**
 * A minute of song-shaped audio for the smoke's auto-director check: the reference beat track with
 * a quiet intro, a build, a loud part, a breakdown and a loud return, so there are sections to
 * arrange. Written once to out/ (a cache: rebuildable, never committed).
 */
async function smokeSong(): Promise<string> {
  const path = join(ROOT, 'out', 'smoke-song.wav');
  if (!existsSync(path)) {
    const seconds = 60;
    const pcm = synthesizeTestTrack(seconds);
    const shape: readonly (readonly [number, number])[] = [[12, 0.12], [20, 0.45], [38, 1], [48, 0.2], [60, 1]];
    for (let i = 0; i < pcm.length; i += 1) pcm[i] = (pcm[i] as number) * (shape.find(([until]) => i / 48_000 < until)?.[1] ?? 1);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, encodeWavFloat32([pcm], 48_000));
  }
  return path;
}

function initialProjectPath(): string | undefined {
  return process.argv.slice(1).find((arg) => !arg.startsWith('-') && arg.endsWith('.pvproj') && existsSync(arg));
}

function registerHandlers(): void {
  ipcMain.handle(IPC.projectInitial, async (): Promise<ProjectFile | null> => {
    const path = initialProjectPath();
    if (path === undefined) return null;
    try {
      return { path, text: await readProjectText(path) };
    } catch (error) {
      throw describe(error);
    }
  });

  ipcMain.handle(IPC.projectOpen, async (): Promise<ProjectFile | null> => {
    const result = await dialog.showOpenDialog({
      title: 'Open project',
      filters: PROJECT_FILTERS,
      properties: ['openFile'],
    });
    const path = result.filePaths[0];
    if (result.canceled || path === undefined) return null;
    try {
      return { path, text: await readProjectText(path) };
    } catch (error) {
      throw describe(error);
    }
  });

  ipcMain.handle(IPC.projectRead, async (_event, path: unknown): Promise<ProjectFile> => {
    if (typeof path !== 'string') throw new Error('readProject needs a path');
    try {
      return { path, text: await readProjectText(path) };
    } catch (error) {
      throw describe(error);
    }
  });

  ipcMain.handle(IPC.projectSave, async (_event, request: SaveRequest): Promise<SaveResult> => {
    try {
      return await writeProjectText(request.path, request.text, request.backupFromVersion === undefined
        ? {}
        : { backupFromVersion: request.backupFromVersion });
    } catch (error) {
      throw describe(error);
    }
  });

  ipcMain.handle(IPC.projectPickSavePath, async (_event, suggestedName: unknown): Promise<string | null> => {
    const result = await dialog.showSaveDialog({
      title: 'Save project as',
      defaultPath: typeof suggestedName === 'string' ? suggestedName : 'untitled.pvproj',
      filters: PROJECT_FILTERS,
    });
    return result.canceled || result.filePath === undefined ? null : result.filePath;
  });

  ipcMain.handle(IPC.projectCollect, async (_event, text: unknown): Promise<CollectSummary | null> => {
    if (typeof text !== 'string') throw new Error('collectProject needs the project text');
    const result = await dialog.showOpenDialog({
      title: 'Collect files into folder',
      buttonLabel: 'Collect here',
      properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
    });
    const folder = result.canceled ? undefined : result.filePaths[0];
    if (folder === undefined) return null;
    try {
      // The studio's text holds absolute paths (asset-paths.ts), so no source project path is needed.
      return await collectProject(loadDocument(text).document, null, folder);
    } catch (error) {
      throw describe(error);
    }
  });

  ipcMain.handle(IPC.assetFindInFolder, async (_event, wanted: unknown): Promise<FolderSearchResult | null> => {
    if (!Array.isArray(wanted)) throw new Error('findAssetsInFolder needs a list');
    const clean: WantedAsset[] = wanted.filter((w): w is WantedAsset =>
      typeof w === 'object' && w !== null && typeof w.id === 'string' && typeof w.name === 'string'
      && typeof w.size === 'number' && typeof w.hash === 'string');
    const result = await dialog.showOpenDialog({ title: 'Find missing files in folder', properties: ['openDirectory'] });
    const folder = result.canceled ? undefined : result.filePaths[0];
    if (folder === undefined) return null;
    return { folder, ...(await findFilesInFolder(folder, clean)) };
  });

  ipcMain.handle(IPC.assetReveal, async (_event, path: unknown): Promise<void> => {
    if (typeof path === 'string' && existsSync(path)) shell.showItemInFolder(path);
  });

  // Documents, because the library is the user's own collection and should be where they look
  // for files. `PULSEFORGE_LIBRARY` overrides it — the smoke check uses that to stay out of the
  // owner's Documents folder.
  const libraryFolder = () => process.env['PULSEFORGE_LIBRARY'] ?? join(app.getPath('documents'), 'Pulseforge', 'Library');
  const libraryListing = async (): Promise<LibraryListing> => {
    const folder = libraryFolder();
    return { folder, items: await listLibrary(folder) };
  };

  ipcMain.handle(IPC.libraryList, async (): Promise<LibraryListing> => {
    try {
      return await libraryListing();
    } catch (error) {
      throw describe(error);
    }
  });

  ipcMain.handle(IPC.libraryAdd, async (_event, category: unknown): Promise<LibraryListing> => {
    const result = await dialog.showOpenDialog({
      title: 'Add images to the library',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: [...IMAGE_EXTENSIONS] }],
    });
    if (!result.canceled && result.filePaths.length > 0) {
      await addToLibrary(libraryFolder(), result.filePaths, typeof category === 'string' ? category : '');
    }
    return libraryListing();
  });

  ipcMain.handle(IPC.libraryThumbnail, async (_event, path: unknown): Promise<ImageBytes> => {
    if (typeof path !== 'string') throw new Error('libraryThumbnail needs a path');
    const image = await decodeImageFile(FFMPEG_EXE, FFPROBE_EXE, path, THUMBNAIL_SIDE);
    return { path, hash: image.sha256, size: image.fileSize, name: image.name, width: image.width, height: image.height, pixels: image.pixels };
  });

  ipcMain.handle(IPC.libraryReveal, async (): Promise<void> => {
    const folder = libraryFolder();
    await mkdir(folder, { recursive: true });
    await shell.openPath(folder);
  });

  ipcMain.handle(IPC.audioPick, async (): Promise<string | null> => {
    // The smoke check's own song (smokeSong), instead of a dialog nobody is there to answer.
    if (smokeAudioPath !== null) return smokeAudioPath;
    const result = await dialog.showOpenDialog({
      title: 'Import audio',
      properties: ['openFile'],
      filters: [
        { name: 'Audio', extensions: ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'opus', 'aac', 'aiff'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(IPC.audioRead, async (_event, path: unknown): Promise<AudioBytes> => {
    if (typeof path !== 'string') throw new Error('readAudio needs a path');
    try {
      return { path, bytes: new Uint8Array(await readFile(path)) };
    } catch (cause) {
      throw new Error(`Could not read the audio file:\n${path}\n\n${(cause as Error).message}`, { cause });
    }
  });

  ipcMain.handle(IPC.audioAnalyze, async (_event, path: unknown, rawSettings: unknown): Promise<AnalysisPayload> => {
    if (typeof path !== 'string') throw new Error('analyzeAudio needs a path');
    const settings = parseProjectAnalysisSettings(rawSettings);
    if (!existsSync(FFMPEG_EXE)) {
      throw new Error('The vendored FFmpeg is missing.\n\nTry:\n• Run `npm run setup` to provision vendor/');
    }
    try {
      // The same decode and the same cache the exporter uses, so the preview reacts to exactly
      // the numbers the export will — not to Chromium's decoder (ipc.ts, AnalysisPayload).
      const decoded = await decodeMono48k(FFMPEG_EXE, path);
      const cache = new AnalysisCache({ root: analysisCacheRoot() });
      const result = await analyzeCached(decoded.pcm, cache, { ...cacheOptionsFor(settings), audioHash: decoded.pcmSha256 });
      // The open track is in use (never evicted) and just used (last in the LRU queue).
      if (lastTrackInUse !== null) cacheInUse.delete(lastTrackInUse);
      lastTrackInUse = `track:${result.audioHash}`;
      cacheInUse.add(lastTrackInUse);
      await cacheStore().touch(lastTrackInUse, basename(path));
      scheduleCacheUpkeep();
      const source = result.analysis.sources.get('mix');
      if (source === undefined) throw new Error('the analyser produced no mix source');
      // Stems (M5) that have been separated live in the same cache entry, so a hit brings them.
      const stems = [...result.analysis.sources]
        .filter(([name]) => name !== 'mix')
        .map(([name, analysis]) => ({ name, container: encodeAnalysis(analysis, { source: name }) }));
      const readiness = await cache.readiness(result.audioHash, result.settingsHash);
      const stemStatus = Object.fromEntries(Object.entries(readiness)
        .filter(([name]) => name !== 'mix')
        .map(([name, entry]) => [name, { state: entry.state, ...(entry.error === undefined ? {} : { error: entry.error }) }]));
      return {
        container: encodeAnalysis(source, { source: 'mix', beatGrid: result.beatGrid, meta: { audioHash: result.audioHash } }),
        peaks: encodePeaks(result.peaks),
        sections: result.sections.map((s) => ({ startSeconds: s.startSeconds, endSeconds: s.endSeconds, label: s.label, energy: s.energy })),
        onsetTimes: result.onsetTimes,
        durationSeconds: decoded.pcm.length / 48_000,
        fromCache: result.fromCache,
        stems,
        stemStatus,
      };
    } catch (error) {
      throw describe(error);
    }
  });

  // Stems (M5): Demucs through the supervised sidecar (M27), taking its turn on the GPU (M28).
  // One separation at a time; a second request while one runs is refused rather than queued twice.
  let stemsController: AbortController | null = null;
  let lyricsAlignController: AbortController | null = null;
  ipcMain.handle(IPC.stemsSeparate, async (event, path: unknown, rawSettings: unknown) => {
    if (typeof path !== 'string') throw new Error('separateStems needs a path');
    const settings = parseProjectAnalysisSettings(rawSettings);
    if (stemsController !== null) throw new Error('A stem separation is already running.');
    const missing = [FFMPEG_EXE, PYTHON_EXE, join(MODELS, 'demucs', `${settings.stemModel}.yaml`)].filter((p) => !existsSync(p));
    if (missing.length > 0) {
      throw new Error(`Stem separation needs the stems part of setup, which is not installed here:\n${missing.join('\n')}\n\nTry:\n• Run \`npm run setup\` (the stems tier) and restart the studio`);
    }
    const controller = new AbortController();
    stemsController = controller;
    const send = (progress: StemProgressEvent) => {
      if (!event.sender.isDestroyed()) event.sender.send(IPC.stemsProgress, progress);
    };
    send({ stage: 'queued', fraction: 0 });
    const started = performance.now();
    try {
      const result = await gpuQueue.run('ml', `Stems: ${basename(path)}`, () => separateStems({
        ffmpegExe: FFMPEG_EXE,
        sidecar: sidecar(),
        cacheRoot: analysisCacheRoot(),
        stemsRoot: join(cacheRootPath(), 'stems'),
        scratchDir: scratchPath(),
        modelRepo: join(MODELS, 'demucs'),
        audioPath: path,
        settings,
        signal: controller.signal,
        onProgress: send,
      }), controller.signal);
      return { stems: result.stems, seconds: (performance.now() - started) / 1000 };
    } catch (error) {
      throw error instanceof StemsCancelledError || error instanceof GpuJobCancelledError || controller.signal.aborted
        ? new Error('Stem separation was cancelled.')
        : describe(error);
    } finally {
      stemsController = null;
    }
  });
  ipcMain.handle(IPC.stemsCancel, async (): Promise<void> => {
    stemsController?.abort();
  });

  // Autosave and crash recovery (M1).
  ipcMain.handle(IPC.recoveryWrite, async (_event, raw: unknown): Promise<void> => {
    const snapshot = raw as { text?: unknown; projectPath?: unknown; projectName?: unknown; reason?: unknown };
    if (typeof snapshot.text !== 'string' || snapshot.text.length > 64 * 1024 * 1024) throw new Error('writeRecovery needs the project text');
    await recoveryStore().write(recoverySessionId, {
      text: snapshot.text,
      projectPath: typeof snapshot.projectPath === 'string' ? snapshot.projectPath : null,
      projectName: typeof snapshot.projectName === 'string' ? snapshot.projectName : 'Untitled',
      reason: typeof snapshot.reason === 'string' ? snapshot.reason.slice(0, 120) : 'autosave',
    });
  });
  ipcMain.handle(IPC.settingsGet, async () => {
    const file = await settingsStore().read();
    return { settings: file.settings, problems: file.problems };
  });
  ipcMain.handle(IPC.settingsUpdate, async (_event, raw: unknown): Promise<UserSettings> => {
    // Every field checked by the store's own rules; a bad value is refused with the reason.
    currentSettings = await settingsStore().update(validateSettingsPatch(raw));
    return currentSettings;
  });
  ipcMain.handle(IPC.settingsInfo, async (): Promise<SettingsInfo> => {
    const listed = async (dir: string, keep: (name: string) => string | null) => {
      try {
        return (await readdir(dir)).map(keep).filter((n): n is string => n !== null).sort();
      } catch {
        return [];
      }
    };
    const gpu = await app.getGPUInfo('basic').catch(() => null) as { gpuDevice?: { vendorId?: number; deviceId?: number; active?: boolean; driverVersion?: string; deviceString?: string }[] } | null;
    const active = gpu?.gpuDevice?.find((d) => d.active === true) ?? gpu?.gpuDevice?.[0];
    return {
      stemModels: await listed(join(MODELS, 'demucs'), (n) => (n.endsWith('.yaml') ? n.slice(0, -5) : null)),
      whisperModels: await listed(join(MODELS, 'whisper'), (n) => (n.startsWith('faster-whisper-') ? n : null)),
      gpu: active === undefined ? 'unknown' : `${active.deviceString ?? `device ${active.deviceId ?? '?'}`}${active.driverVersion === undefined ? '' : ` · driver ${active.driverVersion}`}`,
      paths: {
        settings: settingsPath(),
        userData: app.getPath('userData'),
        defaultCacheRoot: join(ROOT, 'cache'),
        presets: presetsFolderPath(),
        templates: templatesFolderPath(),
      },
      environment: environmentReport(),
    };
  });
  // The cache screen (M33).
  const cacheListing = async (): Promise<CacheListing> => {
    const inventory = await cacheStore().inventory();
    const legacy = await sizeOf(legacyCachePath());
    return {
      ...inventory,
      inUse: [...cacheInUse],
      ceilingBytes: currentSettings.cacheCeilingGb * 1e9,
      lowDiskBytes: currentSettings.lowDiskWarningGb * 1e9,
      legacy: legacy.bytes > 0 ? { path: legacyCachePath(), bytes: legacy.bytes } : null,
    };
  };
  ipcMain.handle(IPC.cacheInventory, async (): Promise<CacheListing> => cacheListing());
  ipcMain.handle(IPC.cacheAction, async (_event, raw: unknown): Promise<CacheActionResult> => {
    const action = (typeof raw === 'object' && raw !== null ? raw : {}) as { kind?: unknown; ids?: unknown; category?: unknown; keep?: unknown };
    const store = cacheStore();
    let result: { removed: readonly { bytes: number }[]; skipped?: readonly string[] };
    if (action.kind === 'remove' && Array.isArray(action.ids) && action.ids.every((id) => typeof id === 'string')) {
      result = await store.remove(action.ids as string[], cacheInUse);
    } else if (action.kind === 'clear' && (action.category === 'all' || (CACHE_CATEGORIES as readonly unknown[]).includes(action.category))) {
      result = await store.clear(action.category as CacheCategory | 'all', cacheInUse);
    } else if (action.kind === 'keepRecent' && typeof action.keep === 'number' && Number.isInteger(action.keep) && action.keep >= 0) {
      result = await store.keepRecentTracks(action.keep, cacheInUse);
    } else if (action.kind === 'clearLegacy') {
      const legacy = await sizeOf(legacyCachePath());
      await rm(legacyCachePath(), { recursive: true, force: true });
      result = { removed: [{ bytes: legacy.bytes }] };
    } else {
      throw new Error('That is not something the cache screen can do.');
    }
    return {
      removed: result.removed.length,
      freedBytes: result.removed.reduce((a, u) => a + u.bytes, 0),
      skipped: result.skipped?.length ?? 0,
      listing: await cacheListing(),
    };
  });
  ipcMain.handle(IPC.pickFolder, async (_event, title: unknown): Promise<string | null> => {
    const result = await dialog.showOpenDialog({ title: typeof title === 'string' ? title.slice(0, 120) : 'Choose a folder', properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle(IPC.revealCache, async (): Promise<void> => {
    await mkdir(cacheRootPath(), { recursive: true });
    await shell.openPath(cacheRootPath());
  });
  ipcMain.handle(IPC.revealPath, async (_event, which: unknown): Promise<void> => {
    const paths: Record<string, string> = { userData: app.getPath('userData'), settings: dirname(settingsPath()) };
    const path = typeof which === 'string' ? paths[which] : undefined;
    if (path === undefined) throw new Error('That is not a folder the studio can open.');
    await mkdir(path, { recursive: true });
    await shell.openPath(path);
  });

  // Setup and repair from the studio (M36, ui-spec §8): the same `npm run setup` a terminal runs,
  // under Electron's own Node, its output streamed to the Settings screen. One run at a time.
  let setupChild: ReturnType<typeof spawn> | null = null;
  ipcMain.handle(IPC.setupRun, async (event, raw: unknown): Promise<{ readonly code: number | null }> => {
    const request = (typeof raw === 'object' && raw !== null ? raw : {}) as { mode?: unknown; tier?: unknown };
    if (setupChild !== null) throw new Error('Setup is already running.');
    const args = request.mode === 'verify' ? ['--verify']
      : request.mode === 'repair' && typeof request.tier === 'string' && ['core', 'stems', 'lyrics'].includes(request.tier) ? ['--tier', request.tier]
        : null;
    if (args === null) throw new Error('Setup can verify, or repair one tier (core, stems or lyrics).');
    const send = (line: string) => {
      if (!event.sender.isDestroyed()) event.sender.send(IPC.setupOutput, line);
    };
    return new Promise((done, fail) => {
      const child = spawn(process.execPath, [join(ROOT, 'setup', 'index.mjs'), ...args], {
        cwd: ROOT,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NO_COLOR: '1', FORCE_COLOR: '0' },
        windowsHide: true,
      });
      setupChild = child;
      send(`$ npm run setup -- ${args.join(' ')}`);
      let pending = '';
      const onData = (chunk: Buffer) => {
        pending += chunk.toString('utf8');
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? '';
        // eslint-disable-next-line no-control-regex
        for (const line of lines) send(line.replace(/\u001b\[[0-9;]*m/g, ''));
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.on('error', (error) => {
        setupChild = null;
        fail(error);
      });
      child.on('close', (code) => {
        if (pending !== '') send(pending);
        setupChild = null;
        done({ code });
      });
    });
  });
  ipcMain.handle(IPC.setupCancel, async (): Promise<void> => {
    setupChild?.kill();
  });
  ipcMain.handle(IPC.lyricsOpen, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Import lyrics',
      properties: ['openFile'],
      filters: [
        { name: 'Lyrics', extensions: ['lrc', 'elrc', 'srt', 'vtt', 'ttml', 'dfxp', 'xml', 'txt'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    const path = result.canceled ? undefined : result.filePaths[0];
    if (path === undefined) return null;
    const info = await stat(path);
    // Lyrics are text; anything this large is not what was meant.
    if (info.size > 5 * 1024 * 1024) throw new Error(`${basename(path)} is ${(info.size / 1_048_576).toFixed(1)} MB — too large to be a lyrics file.`);
    return { name: basename(path), text: await readFile(path, 'utf8') };
  });
  ipcMain.handle(IPC.lyricsSave, async (_event, suggestedName: unknown, text: unknown): Promise<string | null> => {
    if (typeof text !== 'string' || text.length > 16 * 1024 * 1024) throw new Error('saveLyricsFile needs the exported text');
    const name = typeof suggestedName === 'string' ? suggestedName : 'lyrics.lrc';
    const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1] ?? 'lrc';
    const result = await dialog.showSaveDialog({
      title: 'Export lyrics',
      defaultPath: name,
      filters: [{ name: `.${extension}`, extensions: [extension] }, { name: 'All files', extensions: ['*'] }],
    });
    if (result.canceled || result.filePath === undefined) return null;
    await writeFile(result.filePath, text, 'utf8');
    return result.filePath;
  });
  // Lyrics alignment (M26): WhisperX on the vocal stem, through the GPU queue like stems.
  const lyricsFiles = () => ({
    whisperDir: join(MODELS, 'whisper', currentSettings.whisperModel),
    alignDir: join(MODELS, 'align'),
    marker: join(VENDOR, 'python', '.pulseforge-lyrics-env.json'),
  });
  const lyricsMissing = (): string | null => {
    const files = lyricsFiles();
    const missing = [PYTHON_EXE, files.marker, join(files.whisperDir, 'model.bin'), join(files.alignDir, WAV2VEC2_EN.fileName)].filter((p) => !existsSync(p));
    return missing.length === 0 ? null : `Alignment needs the lyrics part of setup, which is not installed here. Run \`npm run setup -- --tier lyrics\` (about 2.7 GB) and restart the studio.`;
  };
  ipcMain.handle(IPC.lyricsAlignAvailable, async () => {
    const reason = lyricsMissing();
    return { available: reason === null, languages: ALIGN_LANGUAGES, reason };
  });
  ipcMain.handle(IPC.lyricsAlign, async (event, raw: unknown) => {
    const request = raw as Partial<LyricsAlignRequest>;
    if (typeof request.audioPath !== 'string' || (request.mode !== 'align' && request.mode !== 'transcribe') || !Array.isArray(request.lines)
      || typeof request.language !== 'string' || typeof request.placement !== 'object' || request.placement === null) {
      throw new Error('alignLyrics needs an audio path, a mode, a language, the lines and the placement');
    }
    const missing = lyricsMissing();
    if (missing !== null) throw new Error(missing);
    if (lyricsAlignController !== null) throw new Error('An alignment is already running.');
    const settings = parseProjectAnalysisSettings(request.settings);
    const controller = new AbortController();
    lyricsAlignController = controller;
    const send = (progress: LyricsAlignProgress) => {
      if (!event.sender.isDestroyed()) event.sender.send(IPC.lyricsAlignProgress, progress);
    };
    send({ stage: 'decoding', fraction: 0 });
    try {
      const files = lyricsFiles();
      const lines = request.lines.filter((l): l is { id: string; text: string } => typeof l?.id === 'string' && typeof l?.text === 'string');
      const result = await gpuQueue.run('ml', `Lyrics: ${basename(request.audioPath)}`, () => alignLyrics({
        ffmpegExe: FFMPEG_EXE,
        sidecar: sidecar(),
        stemsRoot: join(cacheRootPath(), 'stems'),
        stemModel: settings.stemModel,
        audioPath: request.audioPath as string,
        whisperDir: files.whisperDir,
        alignDir: files.alignDir,
        language: request.language as string,
        mode: request.mode as 'align' | 'transcribe',
        lines,
        placement: { leadInTicks: Number(request.placement?.leadInTicks) || 0, clipInTicks: Number(request.placement?.clipInTicks) || 0 },
        ...(Array.isArray(request.vocalSegments) ? { vocalSegments: request.vocalSegments } : {}),
        signal: controller.signal,
        onProgress: send,
      }), controller.signal);
      return { status: 'ok' as const, result };
    } catch (error) {
      if (error instanceof LyricsNeedStemsError) return { status: 'needs-stems' as const, message: error.message };
      throw error instanceof GpuJobCancelledError || controller.signal.aborted
        ? new Error('Alignment was cancelled.')
        : describe(error);
    } finally {
      lyricsAlignController = null;
    }
  });
  ipcMain.handle(IPC.lyricsAlignCancel, async (): Promise<void> => {
    lyricsAlignController?.abort();
  });

  ipcMain.handle(IPC.recoveryClear, async (): Promise<void> => {
    await recoveryStore().clear(recoverySessionId);
  });
  ipcMain.handle(IPC.recoveryList, async (): Promise<readonly RecoveryCandidate[]> => {
    const store = recoveryStore();
    const sessions = await store.listRecoverable(recoverySessionId);
    const candidates: RecoveryCandidate[] = [];
    for (const session of sessions) {
      let savedText: string | null = null;
      if (session.projectPath !== null) {
        try {
          savedText = await readFile(session.projectPath, 'utf8');
        } catch {
          savedText = null; // moved or deleted since: the summary says "never saved" instead
        }
      }
      candidates.push({
        sessionId: session.sessionId,
        projectPath: session.projectPath,
        projectName: session.projectName,
        savedAt: session.savedAt,
        reason: session.reason,
        text: await store.readLatest(session.sessionId),
        savedText,
      });
    }
    return candidates;
  });
  ipcMain.handle(IPC.recoveryDiscard, async (_event, sessionId: unknown): Promise<void> => {
    if (typeof sessionId !== 'string' || sessionId === recoverySessionId) throw new Error('That is not a recovery session this can discard.');
    await recoveryStore().clear(sessionId);
  });

  const decodeForRenderer = async (path: string): Promise<ImageBytes> => {
    if (!existsSync(FFMPEG_EXE) || !existsSync(FFPROBE_EXE)) {
      throw new Error('The vendored FFmpeg is missing.\n\nTry:\n• Run `npm run setup` to provision vendor/');
    }
    const image = await decodeImageFile(FFMPEG_EXE, FFPROBE_EXE, path);
    return { path, hash: image.sha256, size: image.fileSize, name: image.name, width: image.width, height: image.height, pixels: image.pixels };
  };

  // Drop-in modules (M35): scanned on request, so the studio's reload is a fresh read of the folder.
  const builtinIds = new Set(BUILTIN_MODULES.map((m) => m.manifest.id));
  ipcMain.handle(IPC.modulesList, async (): Promise<ModuleScan> => scanModules(MODULES_DIR, builtinIds));
  ipcMain.handle(IPC.modulesReveal, async (): Promise<void> => {
    await mkdir(MODULES_DIR, { recursive: true });
    await shell.openPath(MODULES_DIR);
  });

  // Presets (S8). User presets live in Documents beside the asset library — they are the user's own
  // work and belong in their backups; built-ins ship in the repo; thumbnails are a cache on the
  // repo's drive. `PULSEFORGE_PRESETS` overrides the user folder, which the smoke check uses.
  const presetsFolder = presetsFolderPath;
  const presetStore = () => new PresetStore({
    root: presetsFolder(),
    builtinRoot: join(ROOT, 'presets', 'builtin'),
    thumbnailRoot: join(cacheRootPath(), 'preset-thumbnails'),
  });
  const presetListing = async (): Promise<PresetLibraryListing> => {
    const store = presetStore();
    const [library, favourites] = await Promise.all([store.list(), store.favourites()]);
    return {
      entries: library.entries.map((entry) => ({
        slug: entry.slug,
        origin: entry.origin,
        name: entry.name,
        scope: entry.scope,
        tags: entry.tags,
        moduleId: entry.moduleId ?? null,
        preset: entry.preset,
        favourite: favourites.has(`${entry.scope}/${entry.slug}`),
        thumbnailKey: presetThumbnailKey(entry.preset, ENGINE_VERSION),
      })),
      problems: library.problems,
      folder: presetsFolder(),
    };
  };
  const presetRef = (scope: unknown, slug: unknown): { scope: 'layer' | 'project'; slug: string } => {
    // Both become part of a path: accept only what the store itself would have written.
    if ((scope !== 'layer' && scope !== 'project') || typeof slug !== 'string' || !/^[a-z0-9-]{1,80}$/.test(slug)) {
      throw new Error('That is not a preset this library can name.');
    }
    return { scope, slug };
  };
  ipcMain.handle(IPC.presetsList, async (): Promise<PresetLibraryListing> => presetListing());
  ipcMain.handle(IPC.presetsSave, async (_event, raw: unknown) => {
    const slug = await presetStore().save(parsePreset(raw));
    return { slug, library: await presetListing() };
  });
  ipcMain.handle(IPC.presetsDelete, async (_event, scope: unknown, slug: unknown): Promise<PresetLibraryListing> => {
    const ref = presetRef(scope, slug);
    await presetStore().remove(ref.scope, ref.slug);
    return presetListing();
  });
  ipcMain.handle(IPC.presetsFavourite, async (_event, scope: unknown, slug: unknown, on: unknown): Promise<PresetLibraryListing> => {
    const ref = presetRef(scope, slug);
    await presetStore().setFavourite(ref.scope, ref.slug, on === true);
    return presetListing();
  });
  ipcMain.handle(IPC.presetsThumbnail, async (_event, key: unknown): Promise<Uint8Array | null> =>
    typeof key === 'string' ? presetStore().readThumbnail(key) : null);
  ipcMain.handle(IPC.presetsStoreThumbnail, async (_event, key: unknown, png: unknown): Promise<void> => {
    if (typeof key !== 'string' || !(png instanceof Uint8Array) || png.length > 8 * 1024 * 1024) {
      throw new Error('storePresetThumbnail needs a key and PNG bytes');
    }
    await presetStore().writeThumbnail(key, png);
  });
  ipcMain.handle(IPC.presetsReveal, async (): Promise<void> => {
    await mkdir(presetsFolder(), { recursive: true });
    await shell.openPath(presetsFolder());
  });

  // Auto-director templates (M21): built-ins in the repo, the user's own in Documents beside their
  // presets. Read fresh on every request, so an edited template is one "Reload" away.
  const templatesFolder = templatesFolderPath;
  ipcMain.handle(IPC.templatesList, async (): Promise<TemplateListing> => ({
    files: await readTemplateFiles({ builtin: join(ROOT, 'templates', 'builtin'), user: templatesFolder() }),
    folder: templatesFolder(),
  }));
  ipcMain.handle(IPC.templatesReveal, async (): Promise<void> => {
    await mkdir(templatesFolder(), { recursive: true });
    await shell.openPath(templatesFolder());
  });

  // Video (M39): extracted under the repo's drive, like the CLI's cache — a frame cache runs to
  // gigabytes and C: is nearly full on the build machine (STATUS §2). The studio and the CLI share
  // it, so a clip previewed here is already extracted when the queue renders it at the same size.
  const videoCacheRoot = () => cacheRootPath();
  const preparing = new Map<string, Promise<VideoPrepareResult>>();

  ipcMain.handle(IPC.videoImport, async (): Promise<VideoFile | null> => {
    const result = await dialog.showOpenDialog({
      title: 'Choose a video',
      properties: ['openFile'],
      filters: [{ name: 'Video', extensions: [...VIDEO_EXTENSIONS] }, { name: 'All files', extensions: ['*'] }],
    });
    const path = result.canceled ? undefined : result.filePaths[0];
    if (path === undefined) return null;
    try {
      const info = await probeVideo(FFPROBE_EXE, path);
      const { size } = await stat(path);
      return { path, hash: await hashVideoFile(path), size, name: basename(path), width: info.width, height: info.height, durationSeconds: info.durationSeconds };
    } catch (error) {
      throw describe(error);
    }
  });

  ipcMain.handle(IPC.videoPrepare, async (event, request: unknown): Promise<VideoPrepareResult> => {
    const r = request as { path?: unknown; projectPath?: unknown; hash?: unknown; fps?: { num?: unknown; den?: unknown }; maxFrames?: unknown };
    if (typeof r.path !== 'string' || typeof r.hash !== 'string' || typeof r.fps?.num !== 'number' || typeof r.fps.den !== 'number') {
      throw new Error('prepareVideo needs a path, a hash and an fps');
    }
    const path = resolveAssetPath(r.path, typeof r.projectPath === 'string' ? r.projectPath : null);
    if (path === undefined || !existsSync(path)) return { status: 'missing', path: path ?? r.path };
    const fps = { num: r.fps.num, den: r.fps.den };
    const key = `${r.hash}:${fps.num}/${fps.den}`;
    // One extraction per clip and fps at a time: opening a project and adding the clip to a second
    // layer must not start two FFmpeg runs writing into the same folder.
    const existing = preparing.get(key);
    if (existing !== undefined) return existing;
    const hash = r.hash;
    const job = extractSequence({
      ffmpegExe: FFMPEG_EXE,
      ffprobeExe: FFPROBE_EXE,
      root: videoCacheRoot(),
      path,
      videoHash: hash,
      fps,
      width: PROXY_WIDTH,
      ...(typeof r.maxFrames === 'number' && r.maxFrames > 0 ? { maxFrames: Math.ceil(r.maxFrames) } : {}),
      onProgress: (frames) => {
        if (!event.sender.isDestroyed()) event.sender.send(IPC.videoProgress, hash, frames);
      },
    }).then(
      (sequence): VideoPrepareResult => ({ status: 'ok', sequence: { hash, frameCount: sequence.frameCount, width: sequence.width, height: sequence.height } }),
      (error: unknown): VideoPrepareResult => ({ status: 'error', path, message: describe(error).message }),
    ).finally(() => preparing.delete(key));
    cacheInUse.add(`video:${hash}`);
    void cacheStore().touch(`video:${hash}`, basename(path)).then(scheduleCacheUpkeep);
    preparing.set(key, job);
    return job;
  });

  ipcMain.handle(IPC.videoFrame, async (_event, hash: unknown, fps: unknown, sourceFrame: unknown): Promise<Uint8Array> => {
    const f = fps as { num?: unknown; den?: unknown };
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash) || typeof f?.num !== 'number' || typeof f.den !== 'number'
      || typeof sourceFrame !== 'number' || !Number.isInteger(sourceFrame) || sourceFrame < 0) {
      throw new Error('videoFrame needs a clip hash, an fps and a frame number');
    }
    // Only ever inside the frame cache: the hash is validated hex, so it cannot climb out of it.
    const dir = sequenceDir(videoCacheRoot(), hash, { num: f.num, den: f.den }, PROXY_WIDTH);
    return new Uint8Array(await readFile(framePath(dir, sourceFrame)));
  });

  const readFont = async (path: string): Promise<FontBytes> => {
    const bytes = new Uint8Array(await readFile(path));
    return { path, hash: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, name: basename(path), bytes };
  };

  ipcMain.handle(IPC.fontImport, async (): Promise<FontBytes | null> => {
    const result = await dialog.showOpenDialog({
      title: 'Choose a font',
      defaultPath: dirname(DEFAULT_FONT_FILE),
      properties: ['openFile'],
      filters: [{ name: 'Fonts', extensions: [...FONT_EXTENSIONS] }, { name: 'All files', extensions: ['*'] }],
    });
    const path = result.canceled ? undefined : result.filePaths[0];
    return path === undefined ? null : readFont(path);
  });

  ipcMain.handle(IPC.fontLoad, async (_event, stored: unknown, projectPath: unknown): Promise<FontLoadResult> => {
    if (typeof stored !== 'string') throw new Error('loadFont needs a path');
    const path = resolveAssetPath(stored, typeof projectPath === 'string' ? projectPath : null);
    if (path === undefined || !existsSync(path)) return { status: 'missing', path: path ?? stored };
    try {
      return { status: 'ok', font: await readFont(path) };
    } catch (error) {
      return { status: 'error', path, message: describe(error).message };
    }
  });

  ipcMain.handle(IPC.fontDefault, async (): Promise<FontBytes> => {
    if (!existsSync(DEFAULT_FONT_FILE)) {
      throw new Error(`The bundled default font is missing (${DEFAULT_FONT_FILE}).\n\nTry:\n• Run \`npm run setup\` to provision vendor/fonts`);
    }
    return readFont(DEFAULT_FONT_FILE);
  });

  ipcMain.handle(IPC.imageImport, async (): Promise<ImageBytes | null> => {
    const result = await dialog.showOpenDialog({
      title: 'Choose an image',
      properties: ['openFile'],
      filters: [
        { name: 'Images', extensions: [...IMAGE_EXTENSIONS] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    const path = result.canceled ? undefined : result.filePaths[0];
    if (path === undefined) return null;
    try {
      return await decodeForRenderer(path);
    } catch (error) {
      throw describe(error);
    }
  });

  ipcMain.handle(IPC.imageLoad, async (_event, stored: unknown, projectPath: unknown): Promise<ImageLoadResult> => {
    if (typeof stored !== 'string') throw new Error('loadImage needs a path');
    const path = resolveAssetPath(stored, typeof projectPath === 'string' ? projectPath : null);
    if (path === undefined) return { status: 'missing', path: stored };
    if (!existsSync(path)) return { status: 'missing', path };
    try {
      return { status: 'ok', image: await decodeForRenderer(path) };
    } catch (error) {
      return { status: 'error', path, message: describe(error).message };
    }
  });

  ipcMain.handle(IPC.environment, (): EnvironmentReport => environmentReport());
}

/** Stands in for a queue that failed to start: an empty list, and a reason on any action. */
function unavailableRenderService(reason: string): RenderService {
  const refuse = async (): Promise<never> => {
    throw new RenderRequestError(`The render queue could not start, so rendering is unavailable.\n\n${reason}`);
  };
  return {
    list: () => [],
    enqueue: refuse,
    cancel: refuse,
    retry: refuse,
    remove: refuse,
    clearFinished: refuse,
    stop: async () => {},
    idle: async () => {},
  };
}

function registerRenderHandlers(renders: RenderService): void {
  const needId = (id: unknown): string => {
    if (typeof id !== 'string') throw new Error('a render job id is required');
    return id;
  };
  const wrap = (error: unknown): Error =>
    error instanceof RenderRequestError ? new Error(error.message) : describe(error);

  ipcMain.handle(IPC.renderPickOutput, async (_event, suggestedName: unknown): Promise<string | null> => {
    const result = await dialog.showSaveDialog({
      title: 'Render to',
      defaultPath: typeof suggestedName === 'string' ? suggestedName : 'render.mp4',
      filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
    });
    return result.canceled || result.filePath === undefined ? null : result.filePath;
  });

  ipcMain.handle(IPC.renderEnqueue, async (_event, request: RenderRequest) => {
    // Validated here, not trusted: the renderer could in principle be running a drop-in module.
    if (typeof request?.text !== 'string' || typeof request.presetId !== 'string' || typeof request.outputPath !== 'string'
      || (request.projectPath !== null && typeof request.projectPath !== 'string')) {
      throw new Error('enqueueRender needs text, presetId, outputPath and projectPath');
    }
    try {
      return await renders.enqueue(request);
    } catch (error) {
      throw wrap(error);
    }
  });
  ipcMain.handle(IPC.renderList, () => renders.list());
  ipcMain.handle(IPC.renderCancel, (_event, id: unknown) => renders.cancel(needId(id)));
  ipcMain.handle(IPC.renderRetry, (_event, id: unknown) => renders.retry(needId(id)));
  ipcMain.handle(IPC.renderRemove, (_event, id: unknown) => renders.remove(needId(id)));
  ipcMain.handle(IPC.renderClearFinished, () => renders.clearFinished());
  ipcMain.handle(IPC.renderReveal, (_event, path: unknown) => {
    // Only files the queue itself produced: revealing arbitrary paths is not a capability the
    // renderer should hold.
    const known = typeof path === 'string' && renders.list().some((job) => job.outputPath === path || job.reportPath === path);
    if (!known) throw new Error('Only a finished render can be revealed.');
    shell.showItemInFolder(path);
  });
}

/**
 * Hot reload for module authors (module-spec §12): editing a shader or a module.json in modules/
 * tells the studio to list again. Debounced — an editor's save is often several writes.
 */
function watchModules(window: BrowserWindow): void {
  if (!existsSync(MODULES_DIR)) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const watcher = watch(MODULES_DIR, { recursive: true }, () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        if (!window.isDestroyed()) window.webContents.send(IPC.modulesChanged);
      }, 300);
    });
    window.on('closed', () => watcher.close());
  } catch (error) {
    // Watching is a convenience; without it, Reload in the studio still works.
    console.error(`[modules] cannot watch ${MODULES_DIR}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function createWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1600,
    height: 950,
    minWidth: 1100,
    minHeight: 700,
    // Dark studio chrome (ui-spec §12): paint it before the page loads so there is no flash.
    backgroundColor: '#101013',
    show: false,
    title: 'Pulseforge',
    webPreferences: {
      preload: join(import.meta.dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: false,
    },
  });

  window.once('ready-to-show', () => window.show());
  watchModules(window);
  // The page vetoed its unload because the project has unsaved changes (ui/main.tsx). Without a
  // handler Electron silently keeps the window open, which reads as "the close button is broken".
  window.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(window, {
      type: 'warning',
      buttons: ['Close without saving', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Unsaved changes',
      message: 'The project has unsaved changes.',
      detail: 'Close Pulseforge and lose them?',
    });
    if (choice === 0) event.preventDefault(); // preventDefault here means "ignore the veto"
  });
  await window.loadFile(RENDERER_HTML);
  return window;
}

// Sandboxing every renderer by default, not just the ones that remember to ask.
app.enableSandbox();

app.whenReady().then(async () => {
  lockDownSession();
  guardWebContents();
  currentSettings = (await settingsStore().read()).settings;
  registerHandlers();
  // The ceiling and the free space, once at start (after that, after every cache write).
  scheduleCacheUpkeep();

  if (process.env['PULSEFORGE_SMOKE'] === '1' && process.env['PULSEFORGE_LIBRARY'] === undefined) {
    // A library of our own for the smoke check, with one generated image, set before the window
    // lists it — never the owner's Documents folder.
    const library = join(ROOT, 'out', 'smoke-library');
    const image = join(library, 'backgrounds', 'smoke-bars.png');
    await mkdir(dirname(image), { recursive: true });
    if (!existsSync(image) && existsSync(FFMPEG_EXE)) {
      spawnSync(FFMPEG_EXE, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'smptebars=s=320x180', '-frames:v', '1', image], { windowsHide: true });
    }
    process.env['PULSEFORGE_LIBRARY'] = library;

    // Its own settings file, fresh each run: the smoke must not read or change the owner's tap latency.
    const settingsFile = join(ROOT, 'out', 'smoke-settings.json');
    await rm(settingsFile, { force: true });
    process.env['PULSEFORGE_SETTINGS'] = settingsFile;
    // And its own cache root: the cache check clears things, and it must never clear the owner's.
    await settingsStore().update({ cacheRoot: join(ROOT, 'out', 'smoke-cache') });
    currentSettings = (await settingsStore().read()).settings;

    // Its own recovery folder too: the smoke must not offer (or clear) the owner's autosaves.
    const recovery = join(ROOT, 'out', 'smoke-recovery');
    await rm(recovery, { recursive: true, force: true });
    process.env['PULSEFORGE_RECOVERY'] = recovery;
    // …seeded with the autosave of a "crashed" run, which the studio must offer back (M1). Not when
    // the smoke opens a project of its own: restoring would replace it, and the stems check and the
    // UI tour after it need that project (the recovery check is then reported as not run).
    if (initialProjectPath() === undefined) {
      const crashed = { ...createDocument({ name: 'Smoke crash' }), layers: [createModuleLayer('core.visualizer.bars', { name: 'Recovered smoke layer' })] };
      await new RecoveryStore({ root: recovery }).write('smokecrashed', { text: stringifyDocument(crashed), projectPath: null, projectName: 'Smoke crash', reason: 'every minute' });
    }

    // A fresh, empty user preset folder, so the preset checks start from the built-ins alone and
    // never touch (or depend on) the owner's own presets.
    const presets = join(ROOT, 'out', 'smoke-presets');
    await rm(presets, { recursive: true, force: true });
    process.env['PULSEFORGE_PRESETS'] = presets;

    // A two-second clip for the video bridge check, generated with the vendored FFmpeg's own
    // encoder (the LGPL build has no libx264).
    const clip = join(ROOT, 'out', 'smoke-clip.mp4');
    if (!existsSync(clip) && existsSync(FFMPEG_EXE)) {
      spawnSync(FFMPEG_EXE, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=2', '-c:v', 'mpeg4', '-q:v', '4', clip], { windowsHide: true });
    }
    if (existsSync(clip)) process.env['PULSEFORGE_SMOKE_CLIP'] = JSON.stringify({ path: clip, hash: await hashVideoFile(clip) });
  }

  // The queue's state and scratch live on the repo's drive, not in the profile: scratch holds a
  // float WAV per job (~115 MB for five minutes of stereo) and C: is nearly full on the build
  // machine (STATUS §2) — and %APPDATA%\Electron is a redirected folder there (rename-into-place.ts).
  // A queue that cannot start must not take the studio down with it: editing still works, and
  // rendering explains itself when used.
  let renders: RenderService;
  try {
    renders = await createRenderService({
      root: join(ROOT, 'out', 'studio-render', 'queue'),
      workRoot: join(ROOT, 'out', 'studio-render', 'work'),
      cacheRoot: () => analysisCacheRoot(),
      videoCacheRoot: () => cacheRootPath(),
      gpu: gpuQueue,
      onChange: (jobs) => {
        for (const window of BrowserWindow.getAllWindows()) window.webContents.send(IPC.renderChanged, jobs);
      },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[render-queue] could not start: ${reason}`);
    renders = unavailableRenderService(reason);
  }
  registerRenderHandlers(renders);

  // A render runs in its own Electron process, which would outlive the app if the app simply
  // quit. Cancel it first; the queue records it as cancelled and the child is killed.
  let quitting = false;
  // The sidecar is a child process too; it must not outlive the app either.
  app.on('will-quit', () => {
    void sidecarInstance?.stop();
    endRecoverySession();
  });
  app.on('before-quit', (event) => {
    if (quitting || !renders.list().some((job) => job.status === 'running')) return;
    event.preventDefault();
    quitting = true;
    void renders.stop().finally(() => app.quit());
  });

  if (!existsSync(RENDERER_HTML)) {
    dialog.showErrorBox(
      'Pulseforge is not built',
      `The renderer bundle is missing at:\n${RENDERER_HTML}\n\nRun \`npm run build\` (or \`npm run dev\`) first.`,
    );
    app.quit();
    return;
  }

  const window = await createWindow();

  // A launch self-check for CI and for `npm run dev -- --smoke`: prove the window loaded, the
  // preload bridge is reachable and the renderer rendered, then quit with a status. Four lines
  // of app code buys a check that the app still *starts*, which no unit test can tell you.
  if (process.env['PULSEFORGE_SMOKE'] === '1') {
    // Wait for the renderer to finish its async startup. Without this the checks race the
    // first paint and pass against an empty project — which they silently did until a
    // screenshot showed the window in a state the checks claimed it was not in.
    const settled = await window.webContents.executeJavaScript(`new Promise((done) => {
      const deadline = Date.now() + 10000;
      const poll = () => {
        if (document.body.dataset.pulseforgeReady === 'true') done(true);
        else if (Date.now() > deadline) done(false);
        else setTimeout(poll, 25);
      };
      poll();
    })`) as boolean;
    if (!settled) console.error('[smoke] FAIL the renderer did not finish starting within 10 s');

    smokeAudioPath = await smokeSong();
    const checks = await window.webContents.executeJavaScript(`(async () => {
      // Does the renderer have Node? It must not — sandbox + contextIsolation.
      const noNode = typeof require === 'undefined' && typeof module === 'undefined'
        && typeof process === 'undefined' && typeof __dirname === 'undefined';
      // Can it reach the network? It must not, by CSP and by the session-level block.
      let offline = false;
      try { await fetch('https://example.com/'); } catch { offline = true; }
      // Drive real edits through the command stack, so the smoke check covers
      // command → history → re-render and not just "the page painted".
      //
      // **It starts by adding a layer, and that is not incidental.** A new project has none,
      // so every check below it — the undo stack, the inspector, the effect chain — used to
      // pass by having nothing to test. A vacuous pass is worse than a failure: it reports
      // green for a feature that was never reached.
      document.querySelector('#app .module-buttons button[data-action="add-layer"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((done) => setTimeout(done, 50));
      const before = document.querySelectorAll('#app .layer-row').length;
      // The eye toggles visibility, which is a command; clicking the row only selects.
      document.querySelector('#app .layer-row .eye')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      // React commits asynchronously, so the DOM right after a dispatched click still shows the
      // old tree. Yield before reading, or this check tests the render that already happened.
      await new Promise((done) => setTimeout(done, 50));
      // Matched on a stable hook, not on the label: the button reads "↶ Hide layer", and a
      // check that greps prose silently stops checking anything the first time wording changes.
      const undoButton = document.querySelector('#app header button[data-action="undo"]');
      const undoEnabled = undoButton !== null && !undoButton.disabled;
      // Put it back, so the screenshot below shows the project as it actually opened rather
      // than with its only layer hidden by this check.
      if (undoEnabled) undoButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((done) => setTimeout(done, 50));

      // The effect chain, end to end: select a layer, add an effect through the generated
      // picker, see it appear, take it away again. The inspector builds itself from schema,
      // so this also proves a module's parameters can be reached at all — which is the part
      // that was true of the engine long before it was true of the UI.
      document.querySelector('#app .layer-row .layer-name')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((done) => setTimeout(done, 50));
      const picker = document.querySelector('#app .inspector select[data-action="add-effect"]');
      const option = picker?.querySelector('option[value]:not([value=""])');
      let effectChain = false;
      if (picker !== null && option !== null && option !== undefined) {
        picker.value = option.value;
        picker.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((done) => setTimeout(done, 50));
        const added = document.querySelectorAll('#app .inspector .effect').length;
        document.querySelector('#app .inspector [data-action="remove-effect"]')
          ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await new Promise((done) => setTimeout(done, 50));
        const removed = document.querySelectorAll('#app .inspector .effect').length;
        effectChain = added === 1 && removed === 0;
      }

      // The background layer's image control (M14): switching the selected background to image
      // mode must reveal the generated asset picker, and the decode bridge must answer — here
      // with a clear "not found", since the smoke has no image and must not open a dialog.
      // The first add-layer button is the Background module, so the selected layer is one.
      let imageControl = false;
      const typeSelect = [...document.querySelectorAll('#app .inspector select')]
        .find((s) => s.querySelector('option[value="image"]') !== null);
      if (typeSelect !== undefined) {
        typeSelect.value = 'image';
        typeSelect.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((done) => setTimeout(done, 50));
        const chooser = document.querySelector('#app .inspector [data-action="choose-image"]');
        const answer = await window.pulseforge.loadImage('Z:/definitely/missing.png', null);
        imageControl = chooser !== null && answer.status === 'missing';
        // Back to how it was, for the screenshot.
        document.querySelector('#app header button[data-action="undo"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await new Promise((done) => setTimeout(done, 50));
      }

      // Groups (M38): grouping the selected layer must give a group row that the inspector
      // recognises, and undo must put the layer back where it was.
      let grouping = false;
      const rowsBeforeGrouping = document.querySelectorAll('#app .layer-row').length;
      document.querySelector('#app .layer-actions [data-action="group"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((done) => setTimeout(done, 80));
      const rows = [...document.querySelectorAll('#app .layer-row .meta')].map((m) => m.textContent ?? '');
      const ungroup = document.querySelector('#app .layer-actions [data-action="ungroup"]');
      if (ungroup !== null) {
        ungroup.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await new Promise((done) => setTimeout(done, 80));
      }
      grouping = rows.some((text) => text.startsWith('group')) && document.querySelectorAll('#app .layer-row').length === rowsBeforeGrouping;

      // The text layer (M16), end to end: adding it must give a generated text box in the
      // inspector, and the preview must actually rasterise — the engine notes would otherwise say
      // "no text rasteriser" or "fonts are still loading", which is what a missing font bundle or
      // an unwired rasteriser looks like.
      let textLayer = false;
      const textButton = [...document.querySelectorAll('#app .module-buttons button')].find((b) => b.textContent?.trim() === 'Text');
      if (textButton !== undefined) {
        textButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await new Promise((done) => setTimeout(done, 100));
        const box = document.querySelector('#app .inspector [data-action="text-value"]');
        let notes = '';
        for (let i = 0; i < 40; i += 1) {
          await new Promise((done) => setTimeout(done, 50));
          notes = document.querySelector('#app .canvas-notes')?.textContent ?? '';
          if (notes === '') break;
        }
        textLayer = box !== null && notes === '';
        document.querySelector('#app header button[data-action="undo"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await new Promise((done) => setTimeout(done, 80));
      }

      // Drop-in modules (M35): the shipped example in modules/ must be scanned by the main
      // process, offered under Add layer, and compile in the preview — a broken module would
      // leave an engine note saying so.
      let dropInModule = false;
      let pulseButton;
      for (let i = 0; i < 40 && pulseButton === undefined; i += 1) {
        pulseButton = [...document.querySelectorAll('#app .module-buttons button')].find((b) => b.textContent?.trim() === 'Pulse rings');
        if (pulseButton === undefined) await new Promise((done) => setTimeout(done, 50));
      }
      if (pulseButton !== undefined) {
        pulseButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await new Promise((done) => setTimeout(done, 1000));
        // Without audio the layer notes that it has nothing to react to; the check is that no
        // note says the module is broken. The notes are read from the toast they open.
        let noteText = '';
        const notesButton = document.querySelector('#app .canvas-notes');
        if (notesButton !== null) {
          notesButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await new Promise((done) => setTimeout(done, 50));
          const toast = document.querySelector('#app .toast');
          noteText = toast?.textContent ?? '';
          toast?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        }
        const inspectorControls = document.querySelectorAll('#app .inspector .field').length;
        dropInModule = !noteText.includes('broken') && inspectorControls > 0
          && [...document.querySelectorAll('#app .layer-row .meta')].some((m) => m.textContent === 'example.visualizer.pulse-rings');
        document.querySelector('#app header button[data-action="undo"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await new Promise((done) => setTimeout(done, 80));
      }

      // 3D scene layers (M37) in the live preview: Three.js on the preview's own context. A shader
      // Three could not build is reported as "<scene name>: …" in the engine notes, and a thrown
      // render shows as a canvas error; neither may appear. (Pixels are checked on the export path
      // by tests/golden/scene3d-gpu.)
      let sceneLayer = false;
      const sceneButton = [...document.querySelectorAll('#app .module-buttons button')].find((b) => b.textContent?.trim() === 'Reactive shape');
      if (sceneButton !== undefined) {
        sceneButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await new Promise((done) => setTimeout(done, 1000));
        let noteText = '';
        const notesButton = document.querySelector('#app .canvas-notes');
        if (notesButton !== null) {
          notesButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await new Promise((done) => setTimeout(done, 50));
          const toast = document.querySelector('#app .toast');
          noteText = toast?.textContent ?? '';
          toast?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        }
        sceneLayer = !noteText.includes('Reactive shape:') && !noteText.includes('broken')
          && document.querySelector('#app .canvas-error') === null
          && [...document.querySelectorAll('#app .layer-row .meta')].some((m) => m.textContent === 'core.scene3d.shapes');
        document.querySelector('#app header button[data-action="undo"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await new Promise((done) => setTimeout(done, 80));
      }

      // Video (M39), the studio half: the main process extracts a clip's preview proxy and hands
      // stills back over the bridge. (The GPU half — frames on screen — is tests/golden/video-gpu.)
      let videoBridge = false;
      const smokeClip = ${JSON.stringify(process.env['PULSEFORGE_SMOKE_CLIP'] ?? null)};
      if (smokeClip !== null) {
        const clip = JSON.parse(smokeClip);
        const fps = { num: 30, den: 1 };
        const prepared = await window.pulseforge.prepareVideo({ path: clip.path, projectPath: null, hash: clip.hash, fps, maxFrames: 30 });
        if (prepared.status === 'ok') {
          const bytes = await window.pulseforge.videoFrame(clip.hash, fps, 10);
          // A JPEG starts FF D8.
          videoBridge = prepared.sequence.frameCount === 30 && bytes.length > 100 && bytes[0] === 0xff && bytes[1] === 0xd8;
        }
      }

      // The asset library (M40), end to end: the smoke library holds one generated image; clicking
      // it must add a background layer, record the asset, and load it (status "ok" in the Assets
      // panel means the main process decoded it through FFmpeg and the preview has the pixels).
      // Undone afterwards, which must also leave the asset list empty again.
      let libraryToAsset = false;
      for (let i = 0; i < 40 && document.querySelector('#app .library-item') === null; i += 1) {
        await new Promise((done) => setTimeout(done, 50));
      }
      const libraryItem = document.querySelector('#app .library-item');
      if (libraryItem !== null) {
        const layersBefore = document.querySelectorAll('#app .layer-row').length;
        libraryItem.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        let state = null;
        for (let i = 0; i < 60; i += 1) {
          await new Promise((done) => setTimeout(done, 50));
          state = document.querySelector('#app .asset-row .asset-state')?.textContent ?? null;
          if (state === 'ok') break;
        }
        const layersAfter = document.querySelectorAll('#app .layer-row').length;
        document.querySelector('#app header button[data-action="undo"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await new Promise((done) => setTimeout(done, 80));
        libraryToAsset = state === 'ok' && layersAfter === layersBefore + 1
          && document.querySelectorAll('#app .asset-row').length === 0;
      }

      // The preset browser (S8), end to end. The smoke run has its own empty user folder, so the
      // library is the built-ins alone. A thumbnail must actually draw (the stills engine on the
      // preview's context → PNG → the main process's cache → back as a blob); a click must apply a
      // preset as one undo step; Save must produce a card with its thumbnail drawn straight away
      // (D45); Delete must remove it again.
      const waitFor = async (test, tries = 100) => {
        for (let i = 0; i < tries; i += 1) {
          const value = test();
          if (value) return value;
          await new Promise((done) => setTimeout(done, 50));
        }
        return test();
      };
      const presetCards = await waitFor(() => document.querySelectorAll('#app .preset-card').length >= 14 && document.querySelectorAll('#app .preset-card').length);
      const presetThumbnail = (await waitFor(() => document.querySelector('#app .preset-card .strip[data-thumbnail="ready"]') !== null, 200)) === true;
      const presetBrowser = presetCards >= 14 && presetThumbnail;

      let presetApply = false;
      const neonCard = document.querySelector('#app .preset-card[data-preset="neon-bars"] [data-action="apply-preset"]');
      if (neonCard !== null) {
        const rowsBefore = document.querySelectorAll('#app .layer-row').length;
        neonCard.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await new Promise((done) => setTimeout(done, 100));
        const applied = [...document.querySelectorAll('#app .layer-row .meta')].some((m) => m.textContent === 'core.visualizer.bars');
        const undoLabel = document.querySelector('#app header button[data-action="undo"]')?.textContent ?? '';
        document.querySelector('#app header button[data-action="undo"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await new Promise((done) => setTimeout(done, 100));
        presetApply = applied && undoLabel.includes('Neon bars') && document.querySelectorAll('#app .layer-row').length === rowsBefore;
      }

      let presetSave = false;
      document.querySelector('#app [data-action="save-preset"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const nameInput = await waitFor(() => document.querySelector('#app [data-action="preset-name"]'), 40);
      if (nameInput) {
        const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setValue.call(nameInput, 'Smoke check preset');
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((done) => setTimeout(done, 50));
        document.querySelector('#app [data-action="preset-save-confirm"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const saved = await waitFor(() => document.querySelector('#app .preset-card[data-preset="smoke-check-preset"] .strip[data-thumbnail="ready"]') !== null, 200);
        document.querySelector('#app .preset-card[data-preset="smoke-check-preset"] [data-action="preset-menu"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await new Promise((done) => setTimeout(done, 50));
        document.querySelector('#app .preset-card[data-preset="smoke-check-preset"] [data-action="preset-delete"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const gone = await waitFor(() => document.querySelector('#app .preset-card[data-preset="smoke-check-preset"]') === null, 60);
        presetSave = saved === true && gone === true;
      }

      // Layer editing (M9): solo and lock from the list, lock disabling the inspector and Delete, and
      // a one-step move — each undoable. Run on whichever layer is selected, with at least two rows.
      let layerEditing = false;
      const order = () => [...document.querySelectorAll('#app .layer-list .layer-row')].map((row) => row.getAttribute('data-layer'));
      const selectedRow = () => document.querySelector('#app .layer-list .layer-row.selected');
      const pressUndo = async () => {
        document.querySelector('#app header button[data-action="undo"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await new Promise((done) => setTimeout(done, 80));
      };
      // Its own two layers, so it does not depend on what earlier checks left behind; undone at the end.
      const addBars = () => [...document.querySelectorAll('#app .module-buttons button')].find((b) => b.textContent?.trim() === 'Bars')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      addBars();
      await new Promise((done) => setTimeout(done, 80));
      addBars();
      await new Promise((done) => setTimeout(done, 80));
      if (selectedRow() !== null && order().length >= 2) {
        const soloButton = () => selectedRow()?.querySelector('[data-action="solo"]');
        soloButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await new Promise((done) => setTimeout(done, 80));
        const soloed = soloButton()?.classList.contains('on') === true;
        await pressUndo();
        const unsoloed = soloButton()?.classList.contains('on') === false;

        const lockButton = () => selectedRow()?.querySelector('[data-action="lock"]');
        lockButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await new Promise((done) => setTimeout(done, 80));
        const lockedInspector = document.querySelector('#app .inspector fieldset.inspector-fields')?.disabled === true;
        const deleteDisabled = [...document.querySelectorAll('#app .layer-actions button')].find((b) => b.textContent?.trim() === 'Delete')?.disabled === true;
        await pressUndo();
        const unlocked = document.querySelector('#app .inspector fieldset.inspector-fields')?.disabled === false;

        const before = order();
        const step = [...document.querySelectorAll('#app .layer-actions [data-action="layer-down"], #app .layer-actions [data-action="layer-up"]')].find((b) => !b.disabled);
        step?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await new Promise((done) => setTimeout(done, 80));
        const moved = JSON.stringify(order()) !== JSON.stringify(before);
        await pressUndo();
        const restored = JSON.stringify(order()) === JSON.stringify(before);
        layerEditing = soloed && unsoloed && lockedInspector && deleteDisabled && unlocked && step !== undefined && moved && restored;
      }
      await pressUndo();
      await pressUndo();

      // Stems (M5), end to end, when the smoke is run with a project that has audio
      // (npm run dev -- <project> --smoke): Separate stems → Demucs on the GPU → the Audio panel
      // lists all four. Not reported without audio, where there is nothing to separate.
      let stemsUi;
      const stemsPanel = document.querySelector('#app [data-testid="stems-controls"]');
      if (stemsPanel !== null) {
        if (stemsPanel.getAttribute('data-state') !== 'ready') {
          stemsPanel.querySelector('[data-action="stems-separate"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        }
        const ready = await waitFor(() => document.querySelector('#app [data-testid="stems-controls"]')?.getAttribute('data-state') === 'ready', 2400);
        const text = document.querySelector('#app [data-testid="stems-controls"]')?.textContent ?? '';
        stemsUi = ready === true && ['drums', 'bass', 'vocals', 'other'].every((stem) => text.includes(stem));
      }

      // Modulation (M13), end to end in the studio: ∿ beside a control → a recipe → a binding row in
      // the inspector, the preview reporting the rendered value (the slider's live marker) and the
      // binding's signal (its level meter), and the matrix listing it. "Breathing" is an LFO, so it
      // runs without audio. Undone afterwards.
      let modulationUi = false;
      const barsButton = [...document.querySelectorAll('#app .module-buttons button')].find((b) => b.textContent?.trim() === 'Bars');
      if (barsButton !== undefined) {
        barsButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await new Promise((done) => setTimeout(done, 100));
        document.querySelector('#app .inspector .param-group [data-action="modulate"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await new Promise((done) => setTimeout(done, 50));
        document.querySelector('#app .inspector [data-action="modulate-recipe-breathing"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const row = await waitFor(() => document.querySelector('#app .modulation-section .binding'), 40);
        const marker = await waitFor(() => document.querySelector('#app .inspector .live-marker'), 60);
        const meter = await waitFor(() => {
          const fill = document.querySelector('#app .modulation-section .level-fill');
          return fill !== null && parseFloat(fill.style.width) > 0;
        }, 60);
        const undoLabel = document.querySelector('#app header button[data-action="undo"]')?.textContent ?? '';
        document.querySelector('#app header [data-action="modulation-matrix"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const listed = await waitFor(() => document.querySelector('#app [data-testid="modulation-matrix"] .binding'), 40);
        document.querySelector('#app header [data-action="modulation-matrix"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        for (let i = 0; i < 2; i += 1) {
          document.querySelector('#app header button[data-action="undo"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await new Promise((done) => setTimeout(done, 80));
        }
        modulationUi = row !== null && marker !== null && meter === true && listed !== null && undoLabel.includes('Add modulation')
          && document.querySelector('#app .modulation-section .binding') === null;
      }

      // Lyrics (P6), end to end in the studio: the drawer from the top bar, pasted text becoming
      // lines and a marker, the checklist noticing they are untimed, the left rail adding a lyrics
      // layer, and tap-to-sync — three taps time three lines, Backspace undoes one, Esc ends it.
      // Only on a project without lyrics — it pastes its own, which would replace a project's.
      let lyricsUi = document.querySelector('#app [data-testid="lyrics-summary"]') === null ? false : undefined;
      if (lyricsUi === false) {
        const click = (selector) => document.querySelector(selector)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const pause = (ms) => new Promise((done) => setTimeout(done, ms));
        click('#app header [data-action="lyrics-drawer"]');
        const area = await waitFor(() => document.querySelector('#app [data-testid="lyrics-textarea"]'), 40);
        if (area !== null && area !== false) {
          const setText = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
          area.focus();
          // Backslashes doubled: this script sits in a template literal, which would turn a single
          // one into a real line break inside the string.
          setText.call(area, '[Verse]\\nFirst smoke line\\nSecond smoke line\\n(ooh)');
          area.dispatchEvent(new Event('input', { bubbles: true }));
          area.blur();
          await pause(80);
          click('#app [data-action="lyrics-tab-lines"]');
          const listed = await waitFor(() => document.querySelectorAll('#app [data-testid="lyric-lines"] .lyric-line').length === 3, 40);
          // Alignment (M26) is offered, idle, and — with no track loaded — not pressable.
          const alignOffered = document.querySelector('#app [data-testid="align-controls"]')?.getAttribute('data-state') === 'idle'
            && (document.querySelector('#app [data-action="align-lyrics"]')?.disabled ?? true) === true;
          const marker = document.querySelector('#app [data-testid="lyric-lines"] .lyric-marker')?.textContent === 'Verse';
          click('#app [data-action="lyrics-tab-checks"]');
          const untimed = await waitFor(() => document.querySelector('#app [data-check="untimed"]') !== null, 40);
          const layersBefore = document.querySelectorAll('#app .layer-list .layer-row').length;
          click('#app [data-action="add-lyrics-layer"]');
          const layerAdded = await waitFor(() => document.querySelectorAll('#app .layer-list .layer-row').length === layersBefore + 1, 40);

          click('#app [data-action="tap-start"]');
          const overlay = await waitFor(() => document.querySelector('#app [data-testid="tap-overlay"]'), 40);
          // From the page, as a real key press is: the tap session catches it on the way down.
          for (let i = 0; i < 3; i += 1) {
            document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true }));
            await pause(60);
            document.body.dispatchEvent(new KeyboardEvent('keyup', { key: 't', bubbles: true }));
            await pause(60);
          }
          click('#app [data-action="lyrics-tab-lines"]');
          const timedAll = await waitFor(() => document.querySelectorAll('#app .lyric-line[data-timed="yes"]').length === 3, 40);
          document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
          const undone = await waitFor(() => document.querySelectorAll('#app .lyric-line[data-timed="yes"]').length === 2, 40);
          document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          const closed = await waitFor(() => document.querySelector('#app [data-testid="tap-overlay"]') === null, 40);

          // The timeline lane (P6 step 4): type the first line's times, drag its block on the
          // timeline canvas (Shift while moving: no snapping), then nudge it with ] — each must move its start.
          const startField = () => document.querySelector('#app [data-testid="lyric-lines"] .lyric-line input[aria-label="Start"]');
          const typeTime = async (field, text) => {
            const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            field.focus();
            setValue.call(field, text);
            field.dispatchEvent(new Event('input', { bubbles: true }));
            field.blur();
            await pause(60);
          };
          const seconds = (text) => {
            const m = /^(\\d+):(\\d+\\.\\d+)$/.exec(text ?? '');
            return m === null ? NaN : Number(m[1]) * 60 + Number(m[2]);
          };
          await typeTime(startField(), '0:00.50');
          await typeTime(document.querySelector('#app [data-testid="lyric-lines"] .lyric-line input[aria-label="End"]'), '0:00.90');
          // The second tapped line has an estimated end that overlaps: move it out of the way.
          const second = document.querySelectorAll('#app [data-testid="lyric-lines"] .lyric-line')[1];
          await typeTime(second?.querySelector('input[aria-label="End"]'), '0:05.00');
          await typeTime(second?.querySelector('input[aria-label="Start"]'), '0:04.00');
          const typed = seconds(startField()?.value) === 0.5;
          const timeline = document.querySelector('#app [data-testid="timeline"]');
          const box = timeline.getBoundingClientRect();
          // The fitted view spans the timeline (at least a second): the block's middle, 0.7 s, is there.
          const total = seconds((document.querySelector('#app .transport .timecode')?.textContent ?? '').split('/')[1]?.trim());
          const span = Math.max(1, Number.isFinite(total) ? total : 0);
          const at = { clientX: box.left + 8 + (0.7 / span) * (box.width - 16), clientY: box.top + 56 + 4 + 15, pointerId: 1, bubbles: true };
          timeline.dispatchEvent(new PointerEvent('pointerdown', at));
          timeline.dispatchEvent(new PointerEvent('pointermove', { ...at, clientX: at.clientX + 20, shiftKey: true }));
          timeline.dispatchEvent(new PointerEvent('pointermove', { ...at, clientX: at.clientX + 40, shiftKey: true }));
          timeline.dispatchEvent(new PointerEvent('pointerup', { ...at, clientX: at.clientX + 40 }));
          const dragged = await waitFor(() => seconds(startField()?.value) > 0.52, 40);
          const afterDrag = seconds(startField()?.value);
          document.body.dispatchEvent(new KeyboardEvent('keydown', { key: ']', code: 'BracketRight', bubbles: true }));
          const nudged = await waitFor(() => Math.abs(seconds(startField()?.value) - afterDrag - 0.01) < 0.005, 40);
          document.querySelector('#app .transport button[title="Stop"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          click('#app header [data-action="lyrics-drawer"]');
          await pause(50);
          const steps = {
            listed: listed === true, marker, untimed: untimed === true, layerAdded: layerAdded === true, overlay: overlay !== null && overlay !== false,
            timedAll: timedAll === true, undone: undone === true, closed: closed === true,
            typed, dragged: dragged === true, nudged: nudged === true, alignOffered, drawerClosed: document.querySelector('#app [data-testid="lyrics-drawer"]') === null,
          };
          lyricsUi = Object.values(steps).every(Boolean);
          // Which step, when it fails: the console reaches the smoke log.
          if (!lyricsUi) console.error('[smoke] lyricsUi steps ' + JSON.stringify(steps));
        }
      }

      // WhisperX from the studio (M26), opt-in (PULSEFORGE_SMOKE_ALIGN=1): needs a project with a
      // track, its stems and lyrics text. Presses Align in the real window and waits for the GPU
      // job; the lines must come back timed, word by word, through the command stack.
      let alignLive;
      if (${process.env['PULSEFORGE_SMOKE_ALIGN'] === '1' ? 'true' : 'false'}) {
        const click = (selector) => document.querySelector(selector)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        window.confirm = () => true;
        click('#app header [data-action="lyrics-drawer"]');
        await new Promise((done) => setTimeout(done, 100));
        click('#app [data-action="align-lyrics"]');
        const started = await waitFor(() => document.querySelector('#app [data-testid="align-controls"]')?.getAttribute('data-state') === 'running', 100);
        const finished = await waitFor(() => document.querySelector('#app [data-testid="align-controls"]')?.getAttribute('data-state') === 'idle', 6000);
        click('#app [data-action="lyrics-tab-lines"]');
        await new Promise((done) => setTimeout(done, 100));
        const rows = [...document.querySelectorAll('#app [data-testid="lyric-lines"] .lyric-line')];
        const timed = rows.filter((row) => row.getAttribute('data-timed') === 'yes').length;
        const toast = document.querySelector('#app .toast')?.textContent ?? '';
        console.error('[smoke] alignLive ' + JSON.stringify({ started, finished, rows: rows.length, timed, toast: toast.slice(0, 300) }));
        alignLive = started === true && finished === true && timed > 0 && /Aligned \\d+ line/.test(toast);
        click('#app header [data-action="lyrics-drawer"]');
      }

      // The whole-frame chain (P7 prerequisite): "Whole frame" in the layer list shows the global
      // effect chain in the inspector; adding an effect there lands in the document's global chain
      // (the row's count says so) and is one undo step.
      let globalChain = false;
      {
        const click = (selector) => document.querySelector(selector)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        click('#app [data-action="select-whole-frame"]');
        const shown = await waitFor(() => document.querySelector('#app [data-testid="global-inspector"]'), 40);
        const picker = document.querySelector('#app [data-testid="global-inspector"] select[data-action="add-effect"]');
        if (shown !== null && shown !== false && picker !== null) {
          const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
          setValue.call(picker, 'core.effect.vignette');
          picker.dispatchEvent(new Event('change', { bubbles: true }));
          const added = await waitFor(() => document.querySelectorAll('#app [data-testid="global-inspector"] .effect').length === 1, 40);
          const counted = (document.querySelector('#app [data-action="select-whole-frame"]')?.textContent ?? '').includes('1 effect');
          click('#app header button[data-action="undo"]');
          const undone = await waitFor(() => document.querySelectorAll('#app [data-testid="global-inspector"] .effect').length === 0, 40);
          globalChain = added === true && counted && undone === true;
          if (!globalChain) console.error('[smoke] globalChain ' + JSON.stringify({ added, counted, undone }));
        }
      }

      // The auto-director (M21, M22), end to end: import the smoke's song (the pick dialog answers
      // with it), open Auto once the analysis is in, see the seven templates ranked, Generate (one
      // undo step, a decision log, layers), Surprise me (a second roll in the strip, with a drawn
      // thumbnail), restore the first roll, then undo all three.
      let autoUi = false;
      {
        const click = (selector) => document.querySelector(selector)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const undoLabel = () => document.querySelector('#app header button[data-action="undo"]')?.textContent ?? '';
        const layerCount = () => document.querySelectorAll('#app .layer-list .layer-row').length;
        click('#app [data-action="import-audio"]');
        click('#app header [data-action="auto-drawer"]');
        const ready = await waitFor(() => document.querySelector('#app [data-testid="auto-templates"]'), 600);
        const templates = document.querySelectorAll('#app [data-testid="auto-templates"] input[name="auto-template"]').length;
        const layersBefore = layerCount();
        click('#app [data-action="auto-generate"]');
        const generated = await waitFor(() => undoLabel().includes('Generate project'), 100);
        const logged = await waitFor(() => (document.querySelector('#app [data-testid="auto-log"]')?.textContent ?? '').includes('Why it looks like this'), 40);
        const layersAfter = layerCount();
        click('#app [data-action="auto-surprise"]');
        const surprised = await waitFor(() => undoLabel().includes('Surprise me'), 100);
        const strip = await waitFor(() => document.querySelectorAll('#app [data-testid="auto-history"] .roll-tile').length >= 2, 40);
        const thumbnail = await waitFor(() => document.querySelector('#app [data-testid="auto-history"] .roll-tile img') !== null, 200);
        const older = [...document.querySelectorAll('#app [data-testid="auto-history"] .roll-tile')].find((tile) => !tile.disabled);
        older?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const restored = await waitFor(() => undoLabel().includes('Restore roll'), 100);
        for (let i = 0; i < 3; i += 1) {
          click('#app header button[data-action="undo"]');
          await new Promise((done) => setTimeout(done, 80));
        }
        const undone = await waitFor(() => layerCount() === layersBefore, 40);
        click('#app header [data-action="auto-drawer"]');
        const steps = {
          ready: ready !== null && ready !== false, templates, generated: generated === true, logged: logged === true, grew: layersAfter > layersBefore,
          surprised: surprised === true, strip: strip === true, thumbnail: thumbnail === true, restored: restored === true, undone: undone === true,
        };
        autoUi = steps.ready && templates >= 7 && steps.generated && steps.logged && steps.grew && steps.surprised && steps.strip && steps.thumbnail && steps.restored && steps.undone;
        if (!autoUi) console.error('[smoke] autoUi steps ' + JSON.stringify(steps));
      }

      // Settings (M36): the screen opens from the top bar; a change is saved and survives a
      // re-render; the light theme swaps the chrome's tokens; the environment names the GPU; and
      // Verify runs the real npm run setup -- --verify under the Node inside Electron and reports back.
      let settingsUi = false;
      {
        const click = (selector) => document.querySelector(selector)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const choose = (selector, value) => {
          const select = document.querySelector(selector);
          if (select === null) return;
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, value);
          select.dispatchEvent(new Event('change', { bubbles: true }));
        };
        click('#app header [data-action="settings"]');
        const shown = await waitFor(() => document.querySelector('#app [data-testid="settings-dialog"]'), 40);
        choose('#app [data-setting="autosaveMinutes"]', '5');
        const saved = await waitFor(() => document.querySelector('#app [data-setting="autosaveMinutes"]')?.value === '5', 60);
        choose('#app [data-setting="theme"]', 'light');
        const light = await waitFor(() => document.documentElement.dataset.theme === 'light', 60);
        choose('#app [data-setting="theme"]', 'dark');
        const dark = await waitFor(() => document.documentElement.dataset.theme === 'dark', 60);
        const gpu = await waitFor(() => /GPU/.test(document.querySelector('#app [data-testid="settings-environment"]')?.textContent ?? '') && !/Reading/.test(document.querySelector('#app [data-testid="settings-environment"]')?.textContent ?? ''), 60);
        click('#app [data-action="setup-verify"]');
        const verified = await waitFor(() => /checks out/.test(document.querySelector('#app [data-testid="setup-result"]')?.textContent ?? ''), 3600);
        const logged = (document.querySelector('#app [data-testid="setup-log"]')?.textContent ?? '').includes('Verification passed');
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        const closed = await waitFor(() => document.querySelector('#app [data-testid="settings-dialog"]') === null, 40);
        const steps = { shown: shown !== null && shown !== false, saved: saved === true, light: light === true, dark: dark === true, gpu: gpu === true, verified: verified === true, logged, closed: closed === true };
        settingsUi = Object.values(steps).every(Boolean);
        if (!settingsUi) console.error('[smoke] settingsUi steps ' + JSON.stringify(steps) + ' ' + (document.querySelector('#app [data-testid="setup-result"]')?.textContent ?? ''));
      }

      // Storage (M33): the breakdown lists the smoke song's track (analysed by autoUi) as in use,
      // and Clear everything frees the rest but keeps it. The smoke has its own cache root.
      let storageUi = false;
      {
        window.confirm = () => true;
        document.querySelector('#app header [data-action="settings"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const shown = await waitFor(() => document.querySelector('#app [data-testid="cache-breakdown"]'), 200);
        const songRow = () => [...document.querySelectorAll('#app .cache-units tr')].find((row) => (row.textContent ?? '').includes('smoke-song.wav'));
        const inUse = (songRow()?.textContent ?? '').includes('in use');
        const before = document.querySelectorAll('#app .cache-units tr').length;
        document.querySelector('#app [data-action="cache-clear-all"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const cleared = await waitFor(() => /Freed .*kept/.test(document.querySelector('#app .toast')?.textContent ?? ''), 200);
        const kept = songRow() !== undefined;
        const after = document.querySelectorAll('#app .cache-units tr').length;
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        const steps = { shown: shown !== null && shown !== false, inUse, cleared: cleared === true, kept, fewer: after < before || before === 1 };
        storageUi = Object.values(steps).every(Boolean);
        if (!storageUi) console.error('[smoke] storageUi steps ' + JSON.stringify(steps) + ' rows ' + before + '→' + after);
      }

      // The export dialog opens from the top bar and lists every preset. Queueing is exercised
      // separately (PULSEFORGE_SMOKE_RENDER), because it needs an audio file and a real render.
      document.querySelector('#app header button[data-action="export"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((done) => setTimeout(done, 50));
      const presets = document.querySelectorAll('#app .export-dialog input[data-action="export-preset"]').length;
      document.querySelector('#app .modal-backdrop')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((done) => setTimeout(done, 50));
      const exportDialog = presets >= 6 && document.querySelector('#app .export-dialog') === null;

      // Crash recovery (M1), last because it replaces the project: the seeded autosave of a
      // "crashed" run is offered on start with its summary, and Restore opens it — unsaved — with
      // its layer. (The main process then checks the old session was let go and this one holds a
      // fresh snapshot.) The "discard your changes?" question is answered yes: nothing here is kept.
      let recoveryDialog = ${initialProjectPath() === undefined ? 'false' : 'undefined'};
      const offered = recoveryDialog === undefined ? null : await waitFor(() => document.querySelector('#app .recovery-dialog [data-recovery="smokecrashed"]'), 60);
      if (offered !== null && offered !== false) {
        const summary = offered.textContent ?? '';
        window.confirm = () => true;
        document.querySelector('#app [data-action="recovery-restore"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const restored = await waitFor(() => [...document.querySelectorAll('#app .layer-list .layer-row')].some((row) => row.textContent?.includes('Recovered smoke layer')), 60);
        recoveryDialog = summary.includes('Smoke crash') && summary.includes('never saved') && restored === true
          && document.querySelector('#app .recovery-dialog') === null;
      }

      return {
        rendered: document.querySelector('#app header') !== null,
        bridge: typeof window.pulseforge?.openProject === 'function',
        noNode,
        offline,
        // The layer this check added itself, so there is always something to act on.
        layerAdded: before === 1,
        undoable: undoEnabled,
        effectChain,
        imageControl,
        textLayer,
        grouping,
        dropInModule,
        sceneLayer,
        videoBridge,
        libraryToAsset,
        presetBrowser,
        presetApply,
        presetSave,
        modulationUi,
        layerEditing,
        globalChain,
        autoUi,
        settingsUi,
        storageUi,
        ...(stemsUi === undefined ? {} : { stemsUi }),
        ...(lyricsUi === undefined ? {} : { lyricsUi }),
        ...(alignLive === undefined ? {} : { alignLive }),
        exportDialog,
        ...(recoveryDialog === undefined ? {} : { recoveryDialog }),
      };
    })()`) as Record<string, boolean>;

    // The other half of the recovery check: restoring let the crashed run's folder go and took a
    // fresh snapshot into this run's own (a crash from here on recovers the restored work).
    if (checks['recoveryDialog'] === true) {
      let sessions: readonly string[] = [];
      for (let i = 0; i < 40; i += 1) {
        sessions = (await recoveryStore().listRecoverable('none')).map((session) => session.sessionId);
        if (!sessions.includes('smokecrashed') && sessions.includes(recoverySessionId)) break;
        await new Promise((done) => setTimeout(done, 50));
      }
      checks['recoveryDialog'] = !sessions.includes('smokecrashed') && sessions.includes(recoverySessionId);
    }

    // A real render through the studio's queue, from inside Electron's main process. This is the
    // path the Node-side check cannot cover: here `electron` is the API object, not a path, and
    // esbuild must load at runtime rather than from the bundle.
    const smokeAudio = process.env['PULSEFORGE_SMOKE_RENDER'];
    if (smokeAudio !== undefined && smokeAudio !== '') {
      const project = createDocument({ name: 'Smoke render', canvas: { width: 640, height: 360 } });
      const withLayer = { ...project, layers: [createModuleLayer('core.visualizer.bars', { name: 'bars' })], audio: { ...project.audio, path: smokeAudio } };
      const output = join(ROOT, 'out', 'smoke-render.mp4');
      const job = await renders.enqueue({ text: stringifyDocument(withLayer), projectPath: null, presetId: 'project-h264', outputPath: output });
      await Promise.race([renders.idle(), new Promise((done) => setTimeout(done, 120_000))]);
      const finished = renders.list().find((entry) => entry.id === job.id);
      if (finished?.error) console.error(`[smoke] render error: ${finished.error}`);
      checks['queuedRender'] = finished?.status === 'done' && existsSync(output) && finished.progress?.fraction === 1;
    }

    const failed = [...(settled ? [] : ["settled"]), ...Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name)];
    for (const [name, ok] of Object.entries(checks)) console.log(`[smoke] ${ok ? 'ok  ' : 'FAIL'} ${name}`);

    // A picture of what launched, so "does the chrome actually render" has an answer that is
    // not someone's word for it. The window has to be shown and composited first: capturing a
    // hidden window fails, because there is no surface to read.
    // dist/app/main.js → the repo's own out/, not dist/app/out/.
    const shot = join(import.meta.dirname, '..', '..', 'out', 'smoke.png');
    try {
      window.show();
      await new Promise<void>((done) => {
        window.webContents.once('paint', () => done());
        setTimeout(done, 1500);
      });
      await mkdir(dirname(shot), { recursive: true });
      await writeFile(shot, (await window.webContents.capturePage()).toPNG());
      console.log(`[smoke] wrote ${shot}`);
    } catch (error) {
      console.error(`[smoke] could not capture the window: ${error instanceof Error ? error.message : String(error)}`);
    }

    // `PULSEFORGE_UI_TOUR=1`: screenshots of the states a single capture never shows — dialogs,
    // the queue drawer, an expanded effect, a toast, and a small window — to out/ui-tour/. For
    // looking at, not asserting: layout problems are found by eye, and this makes them cheap to see.
    if (process.env['PULSEFORGE_UI_TOUR'] === '1') await uiTour(window, join(dirname(shot), 'ui-tour'));

    if (failed.length > 0) console.error(`[smoke] FAILED: ${failed.join(', ')}`);
    // Also to a file: Electron's stdout does not always reach a parent that captures it (a GUI
    // subsystem binary under a piped shell), and a smoke check whose verdict can vanish is no check.
    await writeFile(join(dirname(shot), 'smoke-result.json'), `${JSON.stringify({ checks, failed }, null, 2)}\n`);
    // `app.exit` skips will-quit; the smoke ends cleanly all the same, and must leave nothing to recover.
    endRecoverySession();
    const leftOver = (await recoveryStore().listRecoverable('none')).some((session) => session.sessionId === recoverySessionId);
    if (leftOver) console.error('[smoke] FAILED: a clean exit left the autosaves of this run behind');
    app.exit(failed.length === 0 && !leftOver ? 0 : 1);
    return;
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
}).catch((error: unknown) => {
  dialog.showErrorBox('Pulseforge could not start', error instanceof Error ? error.message : String(error));
  app.quit();
});

async function uiTour(window: BrowserWindow, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const js = (code: string) => window.webContents.executeJavaScript(`(async () => { ${code}; await new Promise((d) => setTimeout(d, 150)); })()`);
  const click = (selector: string) => `document.querySelector(${JSON.stringify(selector)})?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`;
  const snap = async (name: string) => {
    await new Promise((done) => setTimeout(done, 250));
    await writeFile(join(dir, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  };
  const sizes: Array<[string, number, number]> = [['large', 1600, 900], ['small', 1100, 680]];
  for (const [label, width, height] of sizes) {
    window.setContentSize(width, height);
    // A richer project than the smoke's: bars on a background, bars selected, an effect open.
    await js(`${click('#app .module-buttons button:nth-child(2)')}`);
    await js(`
      const picker = document.querySelector('#app .inspector select[data-action="add-effect"]');
      const option = picker?.querySelector('option[value]:not([value=""])');
      if (picker && option) { picker.value = option.value; picker.dispatchEvent(new Event('change', { bubbles: true })); }
    `);
    await snap(`${label}-1-layer-and-effect`);
    await js(`[...document.querySelectorAll('#app .module-buttons button')].find((b) => b.textContent?.trim() === 'Text')?.dispatchEvent(new MouseEvent('click', { bubbles: true })); await new Promise((d) => setTimeout(d, 600))`);
    await snap(`${label}-1a-text-layer`);
    await js(`${click('#app .library-item')}; await new Promise((d) => setTimeout(d, 1200))`);
    await snap(`${label}-1b-assets-and-library`);
    await js(click('#app .inspector'));
    await js(`document.querySelector('#app .inspector').scrollTop = 99999`);
    await snap(`${label}-2-inspector-scrolled`);
    await js(click('#app .canvas-bar .aspects button:nth-child(2)'));
    await snap(`${label}-3-vertical-override`);
    await js(click('#app header button[data-action="export"]'));
    await snap(`${label}-4-export-dialog`);
    await js(click('#app .modal-backdrop'));
    await js(click('#app header button[data-action="render-queue"]'));
    await snap(`${label}-5-render-queue`);
    await js(click('#app header button[data-action="render-queue"]'));
    await js(`${click('#app .canvas-notes')}`);
    await snap(`${label}-6-notes-toast`);
    // Modulation (M13): a Bars layer with a recipe binding open in the inspector, then the matrix.
    await js(`[...document.querySelectorAll('#app .module-buttons button')].find((b) => b.textContent?.trim() === 'Bars')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    await js(click('#app .inspector [data-action="modulate"]'));
    await snap(`${label}-7a-modulate-menu`);
    await js(`${click('#app .inspector [data-action="modulate-recipe-breathing"]')}; await new Promise((d) => setTimeout(d, 400))`);
    await js(`document.querySelector('#app .modulation-section')?.scrollIntoView()`);
    await snap(`${label}-7b-binding-editor`);
    await js(click('#app header button[data-action="modulation-matrix"]'));
    await snap(`${label}-7c-modulation-matrix`);
    await js(click('#app header button[data-action="modulation-matrix"]'));
    // Lyrics (P6): the drawer's three tabs, a selected line's words, and tap-to-sync running. The
    // smoke's own lyrics are still in the project (three lines, two timed).
    await js(click('#app header button[data-action="lyrics-drawer"]'));
    // The recovery check replaced the project by now; the tour pastes lyrics of its own.
    await js(click('#app [data-action="lyrics-tab-text"]'));
    await js(`
      const area = document.querySelector('#app [data-testid="lyrics-textarea"]');
      if (area && area.value === '') {
        const setText = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        area.focus();
        setText.call(area, ${JSON.stringify('[Verse 1]\nNeon lights are calling out my name tonight, and every one of them is burning\nHold on (x2)\n(ooh, yeah)\n\n[Chorus]\nWe are the pulse')});
        area.dispatchEvent(new Event('input', { bubbles: true }));
        area.blur();
      }
    `);
    await snap(`${label}-9a-lyrics-text`);
    await js(click('#app [data-action="lyrics-tab-lines"]'));
    await js(click('#app .lyric-line'));
    await snap(`${label}-9b-lyrics-lines`);
    await js(click('#app [data-action="lyrics-tab-checks"]'));
    await snap(`${label}-9c-lyrics-checklist`);
    await js(click('#app [data-action="tap-start"]'));
    await snap(`${label}-9d-tapping`);
    await js(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); ${click('#app .transport button[title="Stop"]')}`);
    await js(click('#app header button[data-action="lyrics-drawer"]'));
    // The timeline zoomed in around a quarter of the way through: the lyrics lane up close.
    await js(`
      const timeline = document.querySelector('#app [data-testid="timeline"]');
      const box = timeline.getBoundingClientRect();
      for (let i = 0; i < 5; i += 1) {
        timeline.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, clientX: box.left + box.width * 0.2, clientY: box.top + 20, bubbles: true, cancelable: true }));
      }
    `);
    await snap(`${label}-9e-timeline-zoomed`);
    await js(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true }))`);
    // The audio clip panel (M29) — only there when the project has audio (open one with the tour).
    await js(`document.querySelector('#app [data-testid="clip-controls"]')?.scrollIntoView({ block: 'center' })`);
    await snap(`${label}-8-audio-clip`);
    // The auto-director (P7): the smoke's song, a generated project, two rerolls, the log.
    if (label === 'large') {
      await js(`${click('#app [data-action="import-audio"]')}; await new Promise((d) => setTimeout(d, 4000))`);
    }
    await js(click('#app header button[data-action="auto-drawer"]'));
    await js(`${click('#app [data-action="auto-generate"]')}; await new Promise((d) => setTimeout(d, 1500))`);
    await snap(`${label}-10a-auto-generated`);
    await js(`${click('#app [data-action="auto-surprise"]')}; await new Promise((d) => setTimeout(d, 800))`);
    await js(`${click('#app [data-action="auto-surprise"]')}; await new Promise((d) => setTimeout(d, 1500))`);
    await snap(`${label}-10b-auto-rolls`);
    await js(`document.querySelector('#app [data-testid="auto-log"]')?.scrollIntoView()`);
    await snap(`${label}-10c-auto-log`);
    await js(click('#app header button[data-action="auto-drawer"]'));
    // Settings (M36), then the whole studio in the light theme, then back to dark.
    const theme = (value: string) => `
      const select = document.querySelector('#app [data-setting="theme"]');
      if (select) { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(value)}); select.dispatchEvent(new Event('change', { bubbles: true })); }
      await new Promise((d) => setTimeout(d, 300))`;
    await js(click('#app header button[data-action="settings"]'));
    await snap(`${label}-11a-settings`);
    await js(`document.querySelector('#app [data-testid="settings-storage"]')?.scrollIntoView(); await new Promise((d) => setTimeout(d, 600))`);
    await snap(`${label}-11c-storage`);
    await js(theme('light'));
    await js(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await snap(`${label}-11b-light-theme`);
    await js(click('#app header button[data-action="settings"]'));
    await js(theme('dark'));
    await js(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  }
  console.log(`[smoke] ui tour written to ${dir}`);
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
