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

import { execFile, spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, watch } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { BrowserWindow, Notification, app, clipboard, dialog, ipcMain, session, shell } from 'electron';
import { DEFAULT_FONT_FILE, FFMPEG_EXE, FFPROBE_EXE, MILKDROP_JS_DIR, MODELS, MODULES_DIR, NVIDIA_SMI_EXE, PYTHON_EXE, ROOT, VENDOR } from '../../setup/lib/paths.ts';
import { WAV2VEC2_EN } from '../../setup/manifest.ts';
import { LyricsNeedStemsError, installedAlignLanguages, alignLyrics, type LyricsAlignProgress } from '../ml/lyrics-align.ts';
import { FONT_EXTENSIONS, fallbackFontFiles } from '../assets/fonts.ts';
import { AnalysisCache } from '../analysis/cache.ts';
import { analyzeCached } from '../analysis/cached.ts';
import { readTemplateFiles } from '../director/template-store.ts';
import { Logger, splitScope, type LogLevel } from './logger.ts';
import { buildDiagnostics } from './diagnostics.ts';
import { CACHE_CATEGORIES, CacheStore, sizeOf, type CacheCategory } from '../cache/cache-store.ts';
import { synthesizeTestTrack } from '../analysis/reference-track.ts';
import { encodeWavFloat32 } from '../export/audio.ts';
import { cacheOptionsFor, parseProjectAnalysisSettings } from '../analysis/project-settings.ts';
import { encodeAnalysis } from '../analysis/container.ts';
import { decodeMono48k } from '../analysis/decode.ts';
import { encodePeaks } from '../analysis/peaks.ts';
import {
  IPC, type AnalysisPayload, type AudioBytes, type CollectSummary, type EnvironmentReport, type FolderSearchResult, type FontBytes, type FontLoadResult, type LutFile, type LutLoadResult,
  type ImageBytes, type ImageLoadResult, type LibraryListing, type ProjectFile, type SaveRequest, type SaveResult, type VideoFile,
  type VideoPrepareResult, type WantedAsset, type PresetLibraryListing, type StemProgressEvent, type RecoveryCandidate, type LyricsAlignRequest, type TemplateListing, type SettingsInfo, type CacheListing, type CacheActionResult, type LogInfo, type RenderJob, type RenderReadiness, type ComponentsInfo,
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
import { motionBlurProblems } from '../engine/core/time.ts';
import { parseCube } from '../engine/core/lut.ts';
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
import { probeCodecs, type CodecSupport } from '../export/encoder-probe.ts';
import { COMPONENTS, NON_COMMERCIAL_NOTICE, componentInstalled, resolveChoice } from '../../setup/components.ts';
import { BeatTrackingError, refineBeats, worthFollowing } from '../ml/beats.ts';
import type { BeatRefinement } from '../analysis/beat-refinement.ts';
import { freeBytesAt } from '../node/free-bytes.ts';
import { RenderRequestError, createRenderService, type RenderRequest, type RenderService } from './render-service.ts';
import { BatchRequestError, completionWatcher, createBatchService, type BatchRequest, type BatchService, type BatchStatus } from './batch-service.ts';
import { directTrack } from '../batch/direct-track.ts';
import { BATCH_AUDIO_EXTENSIONS } from '../batch/plan.ts';
import { loadTemplates } from '../director/template-library.ts';
import { shaderModuleDefinition, shadertoyFileSource, validateShaderModule } from '../engine/modules/shader-module.ts';
import type { QueueFinishedEvent } from './ipc.ts';
import { DEFAULT_ANALYSIS_SETTINGS, createDocument, createModuleLayer } from '../project/create.ts';
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
    // The studio's own warnings and errors reach the log (M34); its info lines only at debug level.
    contents.on('console-message', (...args: unknown[]) => {
      const details = args[0] as { level?: unknown; message?: unknown };
      const level = typeof details.level === 'string' ? details.level : ['debug', 'info', 'warning', 'error'][Number(args[1])] ?? 'info';
      const message = typeof details.message === 'string' ? details.message : String(args[2] ?? '');
      const mapped: LogLevel = level === 'error' ? 'error' : level === 'warning' ? 'warn' : 'debug';
      const { scope, msg } = splitScope(message, 'studio');
      log().write(mapped, scope, msg);
    });
    contents.on('render-process-gone', (_e, details) => {
      log().error('studio', `the renderer process ended: ${details.reason} (exit code ${details.exitCode})`);
    });
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
/**
 * The log (M34): JSON lines in the profile's logs folder, rotated by size, at the level the
 * settings say. `PULSEFORGE_LOGS` points it elsewhere — the smoke check does.
 */
let logger: Logger | null = null;
function log(): Logger {
  logger ??= new Logger({ dir: process.env['PULSEFORGE_LOGS'] ?? join(app.getPath('userData'), 'logs'), level: currentSettings.logLevel });
  return logger;
}

/**
 * Everything the main process says on the console goes to the log too, scoped by its "[tag]":
 * the code already writes "[render-queue] could not start: …", so no call site has to change.
 */
function captureConsole(): void {
  const original = { error: console.error.bind(console), warn: console.warn.bind(console), log: console.log.bind(console) };
  const route = (level: LogLevel, args: unknown[]) => {
    const text = args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    const { scope, msg } = splitScope(text, 'main');
    log().write(level, scope, msg);
  };
  console.error = (...args: unknown[]) => { original.error(...args); route('error', args); };
  console.warn = (...args: unknown[]) => { original.warn(...args); route('warn', args); };
  console.log = (...args: unknown[]) => { original.log(...args); route('info', args); };
}

/**
 * What a stranger's first start does, driven through the real chooser in a fresh download
 * (`PULSEFORGE_INSTALL_CHECK=1`): it appears, the essentials and whatever else is ticked install,
 * the app reloads into a working studio. The verdict goes to out/install-check.json.
 */
async function installCheck(window: BrowserWindow): Promise<void> {
  const page = <T>(script: string) => window.webContents.executeJavaScript(script) as Promise<T>;
  const until = async (test: () => Promise<boolean> | boolean, seconds: number) => {
    for (const end = Date.now() + seconds * 1000; Date.now() < end; await new Promise((done) => setTimeout(done, 500))) {
      if (await test()) return true;
    }
    return false;
  };
  const ready = () => page<boolean>(`document.querySelector('[data-action="components-install"]')?.disabled === false`).catch(() => false);
  const report: Record<string, unknown> = { root: ROOT, chooser: await until(ready, 60) };
  report['ticked'] = await page<string[]>(`[...document.querySelectorAll('[data-testid="component-chooser"] input:checked')].map((box) => box.dataset.action)`);
  report['blocked'] = await page<number>(`document.querySelectorAll('[data-testid="component-chooser"] li.blocked').length`);
  report['page'] = await page<string>(`document.querySelector('[data-testid="component-total"]')?.textContent ?? document.body.innerText.slice(0, 300)`);
  await mkdir(join(ROOT, 'out'), { recursive: true });
  await writeFile(join(ROOT, 'out', 'install-chooser.png'), (await window.webContents.capturePage()).toPNG());
  await writeFile(join(ROOT, 'out', 'install-check.json'), JSON.stringify(report, null, 2));
  if (report['chooser'] !== true) return;
  await page(`document.querySelector('[data-action="components-install"]').click()`);
  report['core'] = await until(() => componentInstalled('core'), 600);
  report['beats'] = await until(() => componentInstalled('beats'), 600);
  // The chooser reloads the page when it finishes, into the studio with nothing left to ask.
  report['studio'] = await until(() => page<boolean>(`document.body.dataset.pulseforgeReady === 'true' && document.querySelector('[data-testid="component-chooser"]') === null`).catch(() => false), 120);
  report['log'] = await page<string>(`document.querySelector('[data-testid="component-log"]')?.textContent?.slice(-800) ?? ''`).catch(() => '');
  await writeFile(join(ROOT, 'out', 'install-check.json'), JSON.stringify(report, null, 2));
}

/** The NVIDIA card and driver, by asking the driver; null when there is none to ask. */
function nvidiaDriver(): Promise<ComponentsInfo['driver']> {
  return new Promise((resolve) => {
    execFile(NVIDIA_SMI_EXE, ['--query-gpu=name,driver_version', '--format=csv,noheader,nounits'], { windowsHide: true }, (error, stdout) => {
      const [name, version] = (stdout.split(/\r?\n/)[0] ?? '').split(',').map((part) => part.trim());
      const major = Number(version?.split('.')[0]);
      resolve(error !== null || name === undefined || version === undefined || !Number.isFinite(major) ? null : { name, version, major });
    });
  });
}

async function gpuDescription(): Promise<string> {
  const gpu = await app.getGPUInfo('basic').catch(() => null) as { gpuDevice?: { deviceId?: number; active?: boolean; driverVersion?: string; deviceString?: string }[] } | null;
  const active = gpu?.gpuDevice?.find((d) => d.active === true) ?? gpu?.gpuDevice?.[0];
  return active === undefined ? 'unknown' : `${active.deviceString ?? `device ${active.deviceId ?? '?'}`}${active.driverVersion === undefined ? '' : ` · driver ${active.driverVersion}`}`;
}

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

/** How the Settings screen names each optional model (D8). */

/** The render queue's jobs, for "Copy diagnostics" on a failed one; set once the queue starts. */
let rendersForDiagnostics: (() => readonly RenderJob[]) | null = null;

/** Set in smoke mode: "Import audio…" answers with this file instead of opening a dialog. */
let smokeAudioPath: string | null = null;
/** Set in smoke mode: "Choose a LUT" answers with this generated .cube instead of a dialog (S11). */
let smokeLutPath: string | null = null;

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
        beatRefinement: result.beatRefinement,
        stems,
        stemStatus,
      };
    } catch (error) {
      throw describe(error);
    }
  });

  ipcMain.handle(IPC.stemAudio, async (_event, path: unknown, stem: unknown, stemModel: unknown) => {
    const name = /^[A-Za-z0-9_-]{1,40}$/;
    if (typeof path !== 'string' || typeof stem !== 'string' || typeof stemModel !== 'string' || !name.test(stem) || !name.test(stemModel)) throw new Error('readStemAudio needs a path, a stem and a model');
    const { pcmSha256 } = await decodeMono48k(FFMPEG_EXE, path);
    const file = join(cacheRootPath(), 'stems', pcmSha256, stemModel, `${stem}.flac`);
    if (!existsSync(file)) throw new Error(`The ${stem} stem's audio is not in the cache. Separate the stems again.`);
    return { bytes: await readFile(file) };
  });

  // Beat refinement (S16): librosa in a child process, on the CPU, so it does not queue for the GPU.
  let beatsController: AbortController | null = null;
  ipcMain.handle(IPC.beatsRefine, async (_event, path: unknown, stemModel: unknown): Promise<BeatRefinement> => {
    if (typeof path !== 'string' || typeof stemModel !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(stemModel)) throw new Error('refineBeats needs a path and a stem model');
    if (beatsController !== null) throw new Error('Beats are already being refined.');
    const controller = new AbortController();
    beatsController = controller;
    try {
      const decoded = await decodeMono48k(FFMPEG_EXE, path);
      // The drum stem when it has been separated and has something in it (PROJECT.md §8.1).
      const drumsFile = join(cacheRootPath(), 'stems', decoded.pcmSha256, stemModel, 'drums.flac');
      const drums = existsSync(drumsFile) ? (await decodeMono48k(FFMPEG_EXE, drumsFile)).pcm : null;
      return await refineBeats({
        pythonExe: PYTHON_EXE,
        packageDir: join(ROOT, 'python'),
        env: pythonEnv(),
        pcm: drums !== null && worthFollowing(drums, decoded.pcm) ? drums : decoded.pcm,
        audioHash: decoded.pcmSha256,
        workDir: scratchPath(),
        signal: controller.signal,
      });
    } catch (error) {
      throw error instanceof BeatTrackingError ? new Error(error.message) : describe(error);
    } finally {
      beatsController = null;
    }
  });
  ipcMain.handle(IPC.beatsCancel, () => beatsController?.abort());

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
      throw new Error(`Stem separation needs the stems part of setup, which is not installed here:\n${missing.join('\n')}\n\nTry:\n• Install Stem separation in Settings → Components`);
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
    log().setLevel(currentSettings.logLevel);
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
    return {
      stemModels: await listed(join(MODELS, 'demucs'), (n) => (n.endsWith('.yaml') ? n.slice(0, -5) : null)),
      whisperModels: await listed(join(MODELS, 'whisper'), (n) => (n.startsWith('faster-whisper-') && existsSync(join(MODELS, 'whisper', n, 'model.bin')) ? n : null)),
      alignLanguages: installedAlignLanguages(join(MODELS, 'align')),
      gpu: await gpuDescription(),
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
  // Diagnostics (M34).
  ipcMain.handle(IPC.logInfo, async (): Promise<LogInfo> => {
    const current = log();
    let bytes: number;
    try {
      bytes = (await stat(current.path)).size;
    } catch {
      bytes = 0;
    }
    return { path: current.path, level: current.getLevel(), bytes };
  });
  ipcMain.handle(IPC.revealLogs, async (): Promise<void> => {
    await mkdir(log().dir, { recursive: true });
    await shell.openPath(log().dir);
  });
  ipcMain.handle(IPC.copyDiagnostics, async (_event, raw: unknown): Promise<{ readonly lines: number; readonly text: string }> => {
    const jobId = typeof raw === 'object' && raw !== null && typeof (raw as { jobId?: unknown }).jobId === 'string' ? (raw as { jobId: string }).jobId : null;
    const job = jobId === null ? undefined : rendersForDiagnostics?.().find((j) => j.id === jobId);
    let cache: { root: string; totalBytes: number; freeBytes: number | null; units: number } | null;
    try {
      const inventory = await cacheStore().inventory();
      cache = { root: inventory.root, totalBytes: inventory.totalBytes, freeBytes: inventory.freeBytes, units: inventory.units.length };
    } catch {
      cache = null;
    }
    const text = buildDiagnostics({
      generatedAt: new Date().toISOString(),
      environment: { ...environmentReport() },
      gpu: await gpuDescription(),
      settings: { ...currentSettings },
      cache,
      job: job === undefined ? undefined : {
        id: job.id, label: job.label, status: job.status, error: job.error, outputPath: job.outputPath, reportPath: job.reportPath, startedAt: job.startedAt, finishedAt: job.finishedAt,
      },
      logPath: log().path,
      log: log().tail(200),
    });
    await clipboard.writeText(text);
    log().info('diagnostics', `copied to the clipboard${job === undefined ? '' : ` for render ${job.id}`}`);
    return { lines: text.split('\n').length, text };
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
  ipcMain.handle(IPC.milkdropIndex, async () => {
    const file = join(MILKDROP_JS_DIR, 'index.json');
    if (!existsSync(file)) return null;
    return { baseUrl: pathToFileURL(MILKDROP_JS_DIR).href, presets: JSON.parse(await readFile(file, 'utf8')) as { name: string; file: string }[] };
  });
  ipcMain.handle(IPC.componentsInfo, async (): Promise<ComponentsInfo> => ({
    components: COMPONENTS.map((component) => ({ ...component, installed: componentInstalled(component.id) })),
    driver: await nvidiaDriver(),
    freeBytes: await freeBytesAt(ROOT),
    nonCommercialNotice: NON_COMMERCIAL_NOTICE,
  }));
  ipcMain.handle(IPC.setupRun, async (event, raw: unknown): Promise<{ readonly code: number | null }> => {
    const request = (typeof raw === 'object' && raw !== null ? raw : {}) as { mode?: unknown; tier?: unknown };
    if (setupChild !== null) throw new Error('Setup is already running.');
    // Verifying covers what is installed: a part someone chose not to have is not a failure.
    const installed = COMPONENTS.filter((c) => componentInstalled(c.id)).map((c) => c.id);
    const chosen = (request as { components?: unknown }).components;
    const args = request.mode === 'verify' ? ['--verify', '--components', installed.join(',')]
      : request.mode === 'rebuild-check' ? ['--rebuild-check']
      : request.mode === 'repair' && typeof request.tier === 'string' && ['core', 'stems', 'lyrics', 'beats', 'milkdrop'].includes(request.tier) ? ['--components', request.tier]
        : request.mode === 'components' && Array.isArray(chosen) && chosen.every((id) => typeof id === 'string')
          ? ['--components', resolveChoice(chosen as string[]).components.map((c) => c.id).join(','), ...((request as { acceptNonCommercial?: unknown }).acceptNonCommercial === true ? ['--accept-non-commercial'] : [])]
          : null;
    if (args === null) throw new Error('Setup can verify, repair one part, or install chosen components.');
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
      log().info('setup', `started: npm run setup -- ${args.join(' ')}`);
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
        log().write(code === 0 ? 'info' : 'error', 'setup', `npm run setup -- ${args.join(' ')} exited with code ${code ?? 'none'}`);
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
    return missing.length === 0 ? null : `Alignment needs the lyrics part of setup, which is not installed here. Install Lyric transcription and timing in Settings → Components.`;
  };
  ipcMain.handle(IPC.lyricsAlignAvailable, async () => {
    const reason = lyricsMissing();
    return { available: reason === null, languages: installedAlignLanguages(lyricsFiles().alignDir), reason };
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
  // "Paste a Shadertoy" (S2): the code becomes a bare .glsl file, which the folder scan loads as a
  // Shadertoy source — the same path as dropping the file in by hand. Validated, never overwrites.
  ipcMain.handle(IPC.modulesAddShadertoy, async (_event, request: { name?: unknown; code?: unknown }) => {
    if (typeof request?.code !== 'string' || request.code.length > 256 * 1024) throw new Error('addShadertoy needs the shader code (at most 256 KB)');
    const cleaned = [...(typeof request.name === 'string' ? request.name : '')]
      .filter((ch) => ch.charCodeAt(0) >= 32 && !'<>:"/\\|?*'.includes(ch)).join('').trim().replace(/[. ]+$/, '').slice(0, 80) || 'Shadertoy';
    await mkdir(MODULES_DIR, { recursive: true });
    const scanned = await scanModules(MODULES_DIR, builtinIds);
    const takenIds = new Set([...builtinIds, ...scanned.modules.map((m) => m.manifest.id)]);
    let name = cleaned;
    for (let n = 2; existsSync(join(MODULES_DIR, `${name}.glsl`)) || takenIds.has(shadertoyFileSource(`${name}.glsl`, '').manifest.id); n += 1) name = `${cleaned} ${n}`;
    const fileName = `${name}.glsl`;
    const source = shadertoyFileSource(fileName, request.code);
    const problems = validateShaderModule(source, takenIds);
    if (problems.length > 0) throw new Error(problems.join('; '));
    await writeFile(join(MODULES_DIR, fileName), request.code);
    log().write('info', 'modules', `Added a Shadertoy shader: modules/${fileName} (${source.manifest.id})`);
    return { fileName, id: source.manifest.id };
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

  // LUTs (S11): read, hashed and parsed here, so a malformed .cube is refused at import with its line
  // rather than failing in a render later.
  const readLut = async (path: string): Promise<LutFile> => {
    const bytes = await readFile(path);
    if (bytes.length > 64 * 1024 * 1024) throw new Error(`${basename(path)} is larger than 64 MB; that is not a LUT`);
    const text = bytes.toString('utf8');
    const parsed = parseCube(text);
    return { path, hash: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, name: basename(path), text, description: parsed.description };
  };
  ipcMain.handle(IPC.lutImport, async (): Promise<LutFile | null> => {
    if (smokeLutPath !== null) return readLut(smokeLutPath);
    const result = await dialog.showOpenDialog({
      title: 'Choose a LUT (.cube)',
      properties: ['openFile'],
      filters: [{ name: 'LUTs', extensions: ['cube'] }, { name: 'All files', extensions: ['*'] }],
    });
    const path = result.canceled ? undefined : result.filePaths[0];
    if (path === undefined) return null;
    try {
      return await readLut(path);
    } catch (error) {
      throw new Error(`${basename(path)} is not a LUT this app can read: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  });
  ipcMain.handle(IPC.lutLoad, async (_event, stored: unknown, projectPath: unknown): Promise<LutLoadResult> => {
    if (typeof stored !== 'string') throw new Error('loadLut needs a path');
    const path = resolveAssetPath(stored, typeof projectPath === 'string' ? projectPath : null);
    if (path === undefined || !existsSync(path)) return { status: 'missing', path: path ?? stored };
    try {
      return { status: 'ok', lut: await readLut(path) };
    } catch (error) {
      return { status: 'error', path, message: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle(IPC.fontDefault, async (): Promise<FontBytes> => {
    if (!existsSync(DEFAULT_FONT_FILE)) {
      throw new Error(`The bundled default font is missing (${DEFAULT_FONT_FILE}).\n\nTry:\n• Run \`npm run setup\` to provision vendor/fonts`);
    }
    return readFont(DEFAULT_FONT_FILE);
  });

  ipcMain.handle(IPC.fontFallbacks, () => fallbackFontFiles().map((font) => ({ hash: font.hash, bytes: readFileSync(font.file) })));

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

// ---------------------------------------------------------------------------
// Batch mode (S13) and "shut down when done" (export-spec §12, ui-spec §7)
// ---------------------------------------------------------------------------

/** Set from the queue drawer; cleared once it has fired, so it never carries into the next session's work. */
let shutdownWhenDone = false;
/** Seconds between everything finishing and the computer shutting down: time to see it and cancel. */
const SHUTDOWN_GRACE_SECONDS = 120;
/** In smoke mode the shutdown is recorded here instead of run — a self-check must never turn the machine off. */
const smokeShutdownCalls: string[][] = [];

function systemShutdown(args: readonly string[]): void {
  if (process.env['PULSEFORGE_SMOKE'] === '1') {
    smokeShutdownCalls.push([...args]);
    return;
  }
  // By absolute path, like every other tool this app runs (CLAUDE.md).
  const exe = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'shutdown.exe');
  spawn(exe, [...args], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
}

function onAllFinished(summary: { readonly done: number; readonly failed: number }): void {
  if (summary.done + summary.failed === 0) return;
  const shutdown = shutdownWhenDone;
  shutdownWhenDone = false;
  const text = `${summary.done} render${summary.done === 1 ? '' : 's'} finished${summary.failed > 0 ? `, ${summary.failed} failed` : ''}.`;
  log().write('info', 'render', `All work finished: ${text}${shutdown ? ` Shutting down in ${SHUTDOWN_GRACE_SECONDS} s.` : ''}`);
  if (shutdown) systemShutdown(['/s', '/t', String(SHUTDOWN_GRACE_SECONDS), '/c', `Pulseforge: ${text} Shutting down.`]);
  if (process.env['PULSEFORGE_SMOKE'] !== '1' && Notification.isSupported()) {
    new Notification({ title: 'Pulseforge', body: shutdown ? `${text} The computer shuts down in ${SHUTDOWN_GRACE_SECONDS / 60} minutes.` : text }).show();
  }
  const event: QueueFinishedEvent = { done: summary.done, failed: summary.failed, shutdownInSeconds: shutdown ? SHUTDOWN_GRACE_SECONDS : null };
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send(IPC.queueFinished, event);
}

function registerBatchHandlers(renders: RenderService, onChange: (status: BatchStatus) => void): BatchService {
  const builtinIds = new Set(BUILTIN_MODULES.map((m) => m.manifest.id));
  const templateFiles = () => readTemplateFiles({ builtin: join(ROOT, 'templates', 'builtin'), user: templatesFolderPath() });
  const service = createBatchService({
    newId,
    onChange,
    templateIds: async () => loadTemplates(await templateFiles()).templates.map((t) => t.template.id),
    async directTrack(track, options) {
      // Read per track: a template or module added mid-batch is used by the tracks after it.
      const templates = loadTemplates(await templateFiles()).templates.map((t) => t.template);
      const scanned = await scanModules(MODULES_DIR, builtinIds);
      const manifests = [...BUILTIN_MODULES, ...scanned.modules.map(shaderModuleDefinition)].map((m) => m.manifest);
      const byId = new Map(manifests.map((m) => [m.id, m]));
      const settings = currentSettings;
      return directTrack(track, {
        ffmpegExe: FFMPEG_EXE,
        cacheRoot: analysisCacheRoot(),
        templates,
        modules: { get: (id) => byId.get(id), all: manifests },
        preset: options.preset,
        templateId: options.templateId,
        appVersion: packageVersion(),
        ...(options.refineBeats ? {
          refineBeats: (pcm: Float32Array, audioHash: string) => refineBeats({ pythonExe: PYTHON_EXE, packageDir: join(ROOT, 'python'), env: pythonEnv(), pcm, audioHash, workDir: scratchPath() }),
        } : {}),
        ...(options.stems ? {
          separateStems: async (audioPath: string) => {
            if (!existsSync(join(MODELS, 'demucs', 'htdemucs.yaml'))) throw new Error('the stems part of setup is not installed');
            await gpuQueue.run('ml', `Stems: ${basename(audioPath)}`, () => separateStems({
              ffmpegExe: FFMPEG_EXE,
              sidecar: sidecar(),
              cacheRoot: analysisCacheRoot(),
              stemsRoot: join(cacheRootPath(), 'stems'),
              scratchDir: scratchPath(),
              modelRepo: join(MODELS, 'demucs'),
              audioPath,
              // New projects use the default model; the stem model setting is honoured here too.
              settings: { ...DEFAULT_ANALYSIS_SETTINGS, stemModel: settings.stemModel },
            }));
          },
        } : {}),
      });
    },
    async enqueue(request) {
      await renders.enqueue({
        text: await readFile(request.projectPath, 'utf8'),
        projectPath: request.projectPath,
        presetId: request.presetId,
        outputPath: request.outputPath,
        motionBlur: request.motionBlur,
        audioMix: request.audioMix,
      });
    },
  });

  ipcMain.handle(IPC.batchPickTracks, async (): Promise<readonly string[]> => {
    // The smoke check's own song, as "Import audio…" answers, instead of a dialog nobody is there to answer.
    if (smokeAudioPath !== null) return [smokeAudioPath];
    const result = await dialog.showOpenDialog({
      title: 'Add tracks to the batch',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Audio', extensions: BATCH_AUDIO_EXTENSIONS.map((e) => e.slice(1)) }, { name: 'All files', extensions: ['*'] }],
    });
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle(IPC.batchStart, async (_event, request: BatchRequest) => {
    try {
      const missing = (Array.isArray(request?.tracks) ? request.tracks : []).filter((t) => typeof t !== 'string' || !existsSync(t));
      if (missing.length > 0) throw new BatchRequestError(`Not found: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ` and ${missing.length - 3} more` : ''}`);
      return await service.start(request);
    } catch (error) {
      throw error instanceof BatchRequestError ? new Error(error.message) : describe(error);
    }
  });
  ipcMain.handle(IPC.batchCancel, () => service.cancel());
  ipcMain.handle(IPC.batchStatus, () => service.status());
  ipcMain.handle(IPC.queueSetShutdown, (_event, on: unknown): boolean => {
    shutdownWhenDone = on === true;
    return shutdownWhenDone;
  });
  ipcMain.handle(IPC.queueCancelShutdown, (): void => {
    systemShutdown(['/a']);
    log().write('info', 'render', 'Scheduled shutdown cancelled.');
  });
  return service;
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

  // A working answer is kept for the session; a failed one is asked again, so a driver updated
  // with the app open is noticed when the dialog next opens.
  let codecs: CodecSupport | null = null;
  ipcMain.handle(IPC.renderReadiness, async (_event, outputPath: unknown): Promise<RenderReadiness> => {
    if (codecs === null || !codecs.h264.available || !codecs.hevc.available) {
      codecs = existsSync(FFMPEG_EXE) ? await probeCodecs(FFMPEG_EXE) : null;
    }
    return { codecs, freeBytes: typeof outputPath === 'string' ? await freeBytesAt(outputPath) : null };
  });
  ipcMain.handle(IPC.renderEnqueue, async (_event, request: RenderRequest) => {
    // Validated here, not trusted: the renderer could in principle be running a drop-in module.
    if (typeof request?.text !== 'string' || typeof request.presetId !== 'string' || typeof request.outputPath !== 'string'
      || (request.projectPath !== null && typeof request.projectPath !== 'string')) {
      throw new Error('enqueueRender needs text, presetId, outputPath and projectPath');
    }
    if (request.audioMix !== undefined && request.audioMix !== 'full' && request.audioMix !== 'instrumental') {
      throw new Error('enqueueRender: audioMix must be "full" or "instrumental"');
    }
    const range = request.range;
    if (range != null && (typeof range !== 'object' || !Number.isSafeInteger(range.inTicks) || !Number.isSafeInteger(range.outTicks) || range.inTicks < 0 || range.outTicks <= range.inTicks)) {
      throw new Error('enqueueRender: the range must be whole ticks with 0 ≤ in < out');
    }
    if (request.supersample !== undefined && request.supersample !== 1 && request.supersample !== 2) throw new Error('enqueueRender: supersample must be 1 or 2');
    const blur = request.motionBlur;
    if (blur != null && (typeof blur !== 'object' || motionBlurProblems(blur).length > 0)) {
      throw new Error(`enqueueRender: ${typeof blur === 'object' ? motionBlurProblems(blur).join('; ') : 'motionBlur must be an object'}`);
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
      // The self-check polls with timers, and a window Chromium thinks is hidden or covered has its
      // timers slowed to one a minute — the check then stalls for good. The studio itself keeps the
      // default: a hidden studio should idle.
      backgroundThrottling: process.env['PULSEFORGE_SMOKE'] !== '1',
    },
  });

  window.once('ready-to-show', () => {
    if (process.env['PULSEFORGE_SMOKE'] === '1') {
      // The self-check drives the page with DOM events, so its window is deaf to the real mouse: a
      // click on it while it runs (its recovery dialog invites one) would otherwise answer a dialog
      // the check is waiting to see, and fail it for no fault of the app.
      window.show();
      window.setIgnoreMouseEvents(true);
      return;
    }
    window.show();
  });
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

// The self-check must not depend on what else is on screen: Windows' occlusion tracking marks a
// covered window hidden, and a hidden page stops painting and running animation frames — so a
// window someone happens to cover mid-check stalled it. Set before the app is ready, as switches must be.
if (process.env['PULSEFORGE_SMOKE'] === '1') app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

app.whenReady().then(async () => {
  lockDownSession();
  guardWebContents();
  if (process.env['PULSEFORGE_SMOKE'] === '1' && process.env['PULSEFORGE_LOGS'] === undefined) {
    // The smoke's own log folder, fresh each run: its checks read the log back.
    process.env['PULSEFORGE_LOGS'] = join(ROOT, 'out', 'smoke-logs');
    await rm(process.env['PULSEFORGE_LOGS'], { recursive: true, force: true });
  }
  currentSettings = (await settingsStore().read()).settings;
  captureConsole();
  log().info('app', `Pulseforge ${packageVersion()} started`, { electron: process.versions['electron'], gpu: await gpuDescription() });
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
    log().setLevel(currentSettings.logLevel);

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
  const loggedJobStatus = new Map<string, string>();
  // "When everything is finished" (export-spec §12): a notification, and the shutdown if asked for.
  // Batches count as work too — the queue is briefly empty between two directed tracks.
  let batchService: BatchService | null = null;
  const completion = completionWatcher((summary) => onAllFinished(summary));
  let renders: RenderService;
  try {
    renders = await createRenderService({
      root: join(ROOT, 'out', 'studio-render', 'queue'),
      workRoot: join(ROOT, 'out', 'studio-render', 'work'),
      cacheRoot: () => analysisCacheRoot(),
      videoCacheRoot: () => cacheRootPath(),
      gpu: gpuQueue,
      onChange: (jobs) => {
        // Each job's transitions, once each: queued, started, done or failed and why.
        for (const job of jobs) {
          if (loggedJobStatus.get(job.id) === job.status) continue;
          loggedJobStatus.set(job.id, job.status);
          log().write(job.status === 'failed' ? 'error' : 'info', 'render', `${job.label}: ${job.status}${job.error === null ? '' : ` — ${job.error}`}`, { id: job.id, output: job.outputPath, report: job.reportPath });
        }
        for (const window of BrowserWindow.getAllWindows()) window.webContents.send(IPC.renderChanged, jobs);
        completion.update(jobs, batchService?.busy() ?? false);
      },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[render-queue] could not start: ${reason}`);
    renders = unavailableRenderService(reason);
  }
  registerRenderHandlers(renders);
  rendersForDiagnostics = () => renders.list();
  batchService = registerBatchHandlers(renders, (status) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send(IPC.batchChanged, status);
    completion.update(renders.list(), batchService?.busy() ?? status.state === 'running');
  });

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

  if (process.env['PULSEFORGE_INSTALL_CHECK'] === '1') {
    await installCheck(window);
    app.quit();
    return;
  }

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
    // A 2-point LUT that inverts, for the LUT check (S11).
    smokeLutPath = join(ROOT, 'out', 'smoke-lut.cube');
    await writeFile(smokeLutPath, 'TITLE "Smoke invert"\nLUT_3D_SIZE 2\n' + [0, 1].flatMap((b) => [0, 1].flatMap((g) => [0, 1].map((r) => `${1 - r} ${1 - g} ${1 - b}`))).join('\n') + '\n');
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
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
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
      document.querySelector('#app [data-action="select-whole-frame"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((done) => setTimeout(done, 30));
      document.querySelector('#app .layer-row .layer-name')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((done) => setTimeout(done, 50));
      const picker = document.querySelector('#app .inspector select[data-action="add-effect"]');
      const option = picker?.querySelector('option[value]:not([value=""])');
      console.log('[smoke] step: effectChain');
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
      console.log('[smoke] step: imageControl');
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
      console.log('[smoke] step: grouping');
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
      console.log('[smoke] step: textLayer');
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
      console.log('[smoke] step: dropInModule');
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
      console.log('[smoke] step: sceneLayer');
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
      console.log('[smoke] step: videoBridge');
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
      console.log('[smoke] step: libraryToAsset');
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
      const recoveryTrace = [];
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

      console.log('[smoke] step: presetApply');
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

      console.log('[smoke] step: presetSave');
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
      console.log('[smoke] step: layerEditing');
      let layerEditing = false;
      const order = () => [...document.querySelectorAll('#app .layer-list .layer-row')].map((row) => row.getAttribute('data-layer'));
      const selectedRow = () => document.querySelector('#app .layer-list .layer-row.selected');
      const pressUndo = async () => {
        document.querySelector('#app header button[data-action="undo"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await new Promise((done) => setTimeout(done, 80));
      };
      // Its own two layers, so it does not depend on what earlier checks left behind; undone at the end.
      const addBars = () => [...document.querySelectorAll('#app .module-buttons button')].find((b) => b.textContent?.trim() === 'Bars')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
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
      console.log('[smoke] step: stemsUi');
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
      console.log('[smoke] step: modulationUi');
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
      console.log('[smoke] step: lyricsUi');
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
          const at = { clientX: box.left + 8 + (0.7 / span) * (box.width - 16), clientY: box.top + 56 + 4 + 16 + 15, pointerId: 1, bubbles: true }; // waveform, gap, markers lane (S9), half the lyrics lane
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
      console.log('[smoke] step: globalChain');
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
      console.log('[smoke] step: autoUi');
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
      console.log('[smoke] step: ' + 'checkpoint'); recoveryTrace.push('settings:' + (document.querySelector('#app .recovery-dialog') !== null));
      console.log('[smoke] step: unicodeFonts');
      // The chain reaches the studio: all ten bundled files, and Arabic among them.
      const chain = await window.pulseforge.fallbackFonts();
      const unicodeFonts = chain.length === 10 && chain.every((font) => font.bytes.length > 10000);
      if (!unicodeFonts) console.error('[smoke] unicodeFonts: ' + chain.length + ' fonts');
      // Refining the beats (S16): a real run of librosa on the smoke song, then undone like any edit.
      console.log('[smoke] step: beatsUi');
      const beatStates = [];
      const beatState = () => document.querySelector('#app [data-testid="beat-controls"]')?.getAttribute('data-state');
      document.querySelector('#app [data-action="beats-refine"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      beatStates.push(await waitFor(() => beatState() === 'applied', 1200));
      beatStates.push(/refined with librosa/.test(document.querySelector('#app [data-testid="beat-source"]')?.textContent ?? ''));
      document.querySelector('#app [data-action="beats-revert"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      beatStates.push(await waitFor(() => beatState() === 'none', 400));
      const beatsUi = beatStates.every((step) => step === true);
      if (!beatsUi) console.error('[smoke] beatsUi steps ' + JSON.stringify(beatStates) + ' state ' + beatState());
      // Dragging a layer's block on the timeline (M9): its start moves, and one undo puts it back.
      console.log('[smoke] step: layerDragUi');
      const rowTimeline = document.querySelector('#app [data-testid="timeline"]');
      const rowBox = rowTimeline.getBoundingClientRect();
      const inField = () => document.querySelector('#app [data-action="layer-in"]')?.value;
      const rowAt = { clientX: rowBox.left + rowBox.width / 2, clientY: rowBox.top + Number(rowTimeline.dataset.rowsTop) + 5, pointerId: 1, bubbles: true };
      rowTimeline.dispatchEvent(new PointerEvent('pointerdown', rowAt));
      await new Promise((done) => setTimeout(done, 100));
      const inBefore = inField();
      rowTimeline.dispatchEvent(new PointerEvent('pointermove', { ...rowAt, clientX: rowAt.clientX + 12, shiftKey: true }));
      rowTimeline.dispatchEvent(new PointerEvent('pointermove', { ...rowAt, clientX: rowAt.clientX + 40, shiftKey: true }));
      rowTimeline.dispatchEvent(new PointerEvent('pointerup', { ...rowAt, clientX: rowAt.clientX + 40 }));
      const blockMoved = inBefore !== undefined && await waitFor(() => inField() !== inBefore, 40);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true }));
      const blockBack = await waitFor(() => inField() === inBefore, 40);
      const layerDragUi = blockMoved === true && blockBack === true;
      if (!layerDragUi) console.error('[smoke] layerDragUi: ' + JSON.stringify({ inBefore, after: inField(), blockMoved, blockBack }));
      // Choosing visuals: a second one swaps rather than stacks, the same one again removes it, and
      // Shift stacks on purpose.
      console.log('[smoke] step: pickerUi');
      document.querySelector('#app [data-action="select-whole-frame"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((done) => setTimeout(done, 50));
      const visual = (index) => document.querySelectorAll('#app .module-buttons button[data-action="add-layer"]')[index];
      const layerCount = () => document.querySelectorAll('#app .layer-list .layer-row').length;
      const pressVisual = async (index, shiftKey) => {
        visual(index)?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey }));
        await new Promise((done) => setTimeout(done, 80));
      };
      const barsIndex = [...document.querySelectorAll('#app .module-buttons button[data-action="add-layer"]')].findIndex((b) => /bars/i.test(b.textContent));
      const wavesIndex = [...document.querySelectorAll('#app .module-buttons button[data-action="add-layer"]')].findIndex((b) => /wave/i.test(b.textContent));
      const pickStart = layerCount();
      await pressVisual(barsIndex, false);
      const pickAdded = layerCount() === pickStart + 1 && visual(barsIndex)?.classList.contains('active') === true;
      await pressVisual(wavesIndex, false);
      const pickSwapped = layerCount() === pickStart + 1 && visual(wavesIndex)?.classList.contains('active') === true && visual(barsIndex)?.classList.contains('active') === false;
      await pressVisual(wavesIndex, true);
      const pickStacked = layerCount() === pickStart + 2;
      await pressVisual(wavesIndex, false);
      await new Promise((done) => setTimeout(done, 50));
      const pickRemoved = layerCount() === pickStart + 1;
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true }));
      await new Promise((done) => setTimeout(done, 80));
      for (let i = 0; i < 4 && layerCount() !== pickStart; i += 1) {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true }));
        await new Promise((done) => setTimeout(done, 80));
      }
      const pickerUi = pickAdded && pickSwapped && pickStacked && pickRemoved && layerCount() === pickStart;
      if (!pickerUi) console.error('[smoke] pickerUi: ' + JSON.stringify({ barsIndex, wavesIndex, pickStart, pickAdded, pickSwapped, pickStacked, pickRemoved, end: layerCount() }));

      // The MilkDrop library, in the real page: its strict policy must still let a preset's script
      // load, the card must make a picture, and a click must put a layer in and take it out.
      console.log('[smoke] step: milkdropUi');
      document.querySelector('#app [data-action="select-whole-frame"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      document.querySelector('#app [data-action="preset-scope-milkdrop"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const mdCards = await waitFor(() => document.querySelectorAll('#app [data-action="apply-milkdrop"]').length > 0, 100);
      const mdPicture = await waitFor(() => document.querySelector('#app [data-testid="milkdrop-grid"] img') !== null, 300);
      const mdLayers = () => [...document.querySelectorAll('#app .layer-list .layer-row .meta')].filter((m) => m.textContent === 'core.visualizer.milkdrop').length;
      document.querySelector('#app [data-action="apply-milkdrop"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const mdAdded = await waitFor(() => mdLayers() === 1, 40);
      await new Promise((done) => setTimeout(done, 400));
      const mdCanvasError = document.querySelector('#app .canvas-error')?.textContent ?? null;
      const mdScript = typeof globalThis.__pfMilkdrop === 'object';
      document.querySelector('#app [data-action="apply-milkdrop"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const mdRemoved = await waitFor(() => mdLayers() === 0, 40);
      document.querySelector('#app [data-action="preset-scope-all"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const milkdropUi = mdCards === true && mdPicture === true && mdAdded === true && mdScript && mdCanvasError === null && mdRemoved === true;
      if (!milkdropUi) console.error('[smoke] milkdropUi: ' + JSON.stringify({ mdCards, mdPicture, mdAdded, mdScript, mdCanvasError, mdRemoved }));

      // Selecting two layers with Ctrl brings their shared actions; a plain click goes back to one.
      console.log('[smoke] step: multiSelectUi');
      const names = [...document.querySelectorAll('#app .layer-list .layer-name')];
      const pressName = (button, ctrlKey) => button?.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey }));
      document.querySelector('#app [data-action="select-whole-frame"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((done) => setTimeout(done, 50));
      pressName(names[0], false);
      await new Promise((done) => setTimeout(done, 50));
      pressName(names[1], true);
      const manyShown = await waitFor(() => document.querySelector('#app [data-testid="multi-layer-actions"]') !== null, 40);
      pressName(names[0], false);
      const oneAgain = await waitFor(() => document.querySelector('#app [data-testid="multi-layer-actions"]') === null, 40);
      const multiSelectUi = names.length >= 2 && manyShown === true && oneAgain === true;
      if (!multiSelectUi) console.error('[smoke] multiSelectUi: ' + JSON.stringify({ rows: names.length, manyShown, oneAgain }));

      // Remapping a key: the next key pressed is the action's, and the table says so.
      console.log('[smoke] step: shortcutUi');
      document.querySelector('#app header [data-action="settings"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await waitFor(() => document.querySelector('#app [data-action="shortcut-fit"]') !== null, 60);
      document.querySelector('#app [data-action="shortcut-fit"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((done) => setTimeout(done, 80));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }));
      const remapped = await waitFor(() => document.querySelector('#app [data-action="shortcut-fit"]')?.textContent === 'J', 60);
      document.querySelector('#app [data-action="shortcuts-reset"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const restored = await waitFor(() => document.querySelector('#app [data-action="shortcut-fit"]')?.textContent === 'F', 60);
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await waitFor(() => document.querySelector('#app [data-testid="settings-dialog"]') === null, 40);
      const shortcutUi = remapped === true && restored === true;
      if (!shortcutUi) console.error('[smoke] shortcutUi: ' + JSON.stringify({ remapped, restored }));
      console.log('[smoke] step: settingsUi');
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
        const verifySection = document.querySelector('#app [data-testid="settings-setup"]');
        const verifyButton = document.querySelector('#app [data-action="setup-verify"]');
        const verifyState = verifyButton === null ? 'missing' : verifyButton.disabled ? 'disabled' : 'enabled';
        click('#app [data-action="setup-verify"]');
        const verified = await waitFor(() => /checks out/.test(document.querySelector('#app [data-testid="setup-result"]')?.textContent ?? ''), 3600);
        const logged = (document.querySelector('#app [data-testid="setup-log"]')?.textContent ?? '').includes('Verification passed');
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        const closed = await waitFor(() => document.querySelector('#app [data-testid="settings-dialog"]') === null, 40);
        const steps = { shown: shown !== null && shown !== false, saved: saved === true, light: light === true, dark: dark === true, gpu: gpu === true, verified: verified === true, logged, closed: closed === true };
        settingsUi = Object.values(steps).every(Boolean);
        if (!settingsUi) console.error('[smoke] settingsUi steps ' + JSON.stringify(steps) + ' ' + (document.querySelector('#app [data-testid="setup-result"]')?.textContent ?? '')
          + ' | setup section ' + (verifySection === null ? 'missing' : 'present') + ', verify button was ' + verifyState + ', log chars ' + (document.querySelector('#app [data-testid="setup-log"]')?.textContent ?? '').length);
      }

      // Storage (M33): the breakdown lists the smoke song's track (analysed by autoUi) as in use,
      // and Clear everything frees the rest but keeps it. The smoke has its own cache root.
      console.log('[smoke] step: ' + 'checkpoint'); recoveryTrace.push('storage:' + (document.querySelector('#app .recovery-dialog') !== null));
      console.log('[smoke] step: storageUi');
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

      // Diagnostics (M34): the log is where Settings says (the smoke's own folder), and Copy
      // diagnostics reports success. The main process then checks the clipboard and the log file.
      let diagnosticsUi = false;
      {
        document.querySelector('#app header [data-action="settings"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const path = await waitFor(() => /smoke-logs/.test(document.querySelector('#app [data-testid="log-path"]')?.textContent ?? ''), 100);
        // A warning from the page itself: it must reach the log through the renderer's console.
        console.warn('[smoke-renderer] console capture check');
        document.querySelector('#app [data-action="copy-diagnostics"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const copied = await waitFor(() => /Diagnostics copied/.test(document.querySelector('#app .toast')?.textContent ?? ''), 100);
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        diagnosticsUi = path === true && copied === true;
        if (!diagnosticsUi) console.error('[smoke] diagnosticsUi steps ' + JSON.stringify({ path, copied }));
      }

      // Optional models and the per-project stem model (D8, P1): Settings lists the six extras
      // (installed on this machine); the Audio panel offers both stem models, and switching is one
      // undo step that re-analyses under the new key.
      let extrasUi = false;
      {
        const click = (selector) => document.querySelector(selector)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        click('#app header [data-action="settings"]');
        const listed = await waitFor(() => document.querySelectorAll('#app [data-testid="optional-models"] li').length === 7, 100);
        const installed = document.querySelectorAll('#app [data-testid="optional-models"] li .ok').length;
        // The model picker exists only where htdemucs_ft is installed; elsewhere the list is the check.
        const hasFt = document.querySelector('#app [data-testid="optional-models"] li[data-extra="htdemucs_ft"] .ok') !== null;
        const has6s = document.querySelector('#app [data-testid="optional-models"] li[data-extra="htdemucs_6s"] .ok') !== null;
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        const picker = hasFt ? await waitFor(() => document.querySelector('#app [data-action="stem-model"]'), 100) : null;
        let switched = false;
        let back = false;
        if (picker !== null && picker !== false) {
          const choose = (value) => {
            const select = document.querySelector('#app [data-action="stem-model"]');
            Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, value);
            select.dispatchEvent(new Event('change', { bubbles: true }));
          };
          choose('htdemucs_ft');
          switched = (await waitFor(() => (document.querySelector('#app header button[data-action="undo"]')?.textContent ?? '').includes('Stem model: htdemucs_ft'), 100)) === true;
          await waitFor(() => document.querySelector('#app [data-testid="stems-controls"]')?.getAttribute('data-state') !== 'running', 100);
          click('#app header button[data-action="undo"]');
          back = (await waitFor(() => document.querySelector('#app [data-action="stem-model"]')?.value === 'htdemucs', 100)) === true;
        }
        // S6: an installed 6-stem model is offered in the picker too.
        const offers6s = !has6s || [...(document.querySelector('#app [data-action="stem-model"]')?.options ?? [])].some((o) => o.value === 'htdemucs_6s');
        const steps = { listed: listed === true, installed, hasFt, has6s, offers6s, picker: picker !== null && picker !== false, switched, back };
        extrasUi = steps.listed && offers6s && (!hasFt || (steps.picker && switched && back));
        if (!extrasUi) console.error('[smoke] extrasUi steps ' + JSON.stringify(steps));
      }

      // Keyframes (S1): on a new Bars layer, the first parameter's diamond sets a key at the
      // playhead; after seeking to 2 s, moving its slider sets a second key (auto-key); a key picked
      // in the Keyframes section opens the editor, and an ease-in-out easing shows the curve editor.
      let keyframeUi = false;
      {
        const click = (selector) => document.querySelector(selector)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const bars = [...document.querySelectorAll('#app .module-buttons button')].find((b) => b.textContent?.trim() === 'Bars');
        bars?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await new Promise((done) => setTimeout(done, 150));
        const firstDiamond = () => document.querySelector('#app .inspector .param-group [data-action="keyframe"]');
        firstDiamond()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const keyed = await waitFor(() => firstDiamond()?.getAttribute('data-key-state') === 'on-key', 40);
        // Seek to 2 s on the waveform lane.
        const timeline = document.querySelector('#app [data-testid="timeline"]');
        const box = timeline.getBoundingClientRect();
        const total = 60;
        const at = { clientX: box.left + 8 + (2 / total) * (box.width - 16), clientY: box.top + 10, pointerId: 7, bubbles: true };
        timeline.dispatchEvent(new PointerEvent('pointerdown', at));
        timeline.dispatchEvent(new PointerEvent('pointerup', at));
        const moved = await waitFor(() => firstDiamond()?.getAttribute('data-key-state') === 'animated', 40);
        const range = document.querySelector('#app .inspector .param-group input[type="range"]');
        if (range !== null) {
          const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setValue.call(range, range.max);
          range.dispatchEvent(new Event('input', { bubbles: true }));
          range.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        }
        const twoKeys = await waitFor(() => document.querySelectorAll('#app [data-testid="keyframes-section"] .key-chip').length === 2, 40);
        click('#app [data-testid="keyframes-section"] .key-chip');
        const editor = await waitFor(() => document.querySelector('#app [data-testid="key-editor"]'), 40);
        const easing = document.querySelector('#app [data-action="key-easing"]');
        if (easing !== null) {
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(easing, 'easeInOut');
          easing.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const curve = await waitFor(() => document.querySelector('#app [data-testid="curve-editor"]'), 40);
        // Delete removes the selected key (the timeline's handler); one is left.
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
        const deleted = await waitFor(() => document.querySelectorAll('#app [data-testid="keyframes-section"] .key-chip').length === 1, 40);
        const steps = { keyed: keyed === true, moved: moved === true, twoKeys: twoKeys === true, editor: editor !== null && editor !== false, curve: curve !== null && curve !== false, deleted: deleted === true };
        keyframeUi = Object.values(steps).every(Boolean);
        if (!keyframeUi) console.error('[smoke] keyframeUi steps ' + JSON.stringify(steps));
      }

      // Masking (S7): an Orb masked by a Bars layer — the mask options appear, the source's
      // inspector says it masks the orb and offers to show it, and the frame renders without warnings.
      let maskUi = false;
      {
        const add = (name) => [...document.querySelectorAll('#app .module-buttons button')].find((b) => b.textContent?.trim() === name)?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
        add('Bars');
        await new Promise((done) => setTimeout(done, 150));
        const barsId = document.querySelector('#app .layer-list .layer-row.selected')?.getAttribute('data-layer');
        add('Orb');
        await new Promise((done) => setTimeout(done, 150));
        const source = document.querySelector('#app [data-action="mask-source"]');
        if (source !== null && barsId) {
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(source, barsId);
          source.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const options = await waitFor(() => document.querySelector('#app [data-action="mask-channel"]'), 40);
        const undoText = document.querySelector('#app header button[data-action="undo"]')?.textContent ?? '';
        [...document.querySelectorAll('#app .layer-list .layer-row')].find((r) => r.getAttribute('data-layer') === barsId)?.querySelector('.layer-name')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const offered = await waitFor(() => document.querySelector('#app [data-action="mask-source-visible"]'), 40);
        const steps = { barsId: Boolean(barsId), options: options !== null && options !== false, undo: undoText.includes('Set mask'), offered: offered !== null && offered !== false };
        maskUi = Object.values(steps).every(Boolean);
        if (!maskUi) console.error('[smoke] maskUi steps ' + JSON.stringify(steps));
      }

      console.log('[smoke] step: ' + 'checkpoint'); recoveryTrace.push('export:' + (document.querySelector('#app .recovery-dialog') !== null));
      // The export dialog opens from the top bar and lists every preset. Queueing is exercised
      // separately (PULSEFORGE_SMOKE_RENDER), because it needs an audio file and a real render.
      document.querySelector('#app header button[data-action="export"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((done) => setTimeout(done, 50));
      const presets = document.querySelectorAll('#app .export-dialog input[data-action="export-preset"]').length;
      const sizeShown = /Up to [0-9]/.test(document.querySelector('#app .export-dialog [data-testid="export-size"]')?.textContent ?? '');
      if (!sizeShown) console.error('[smoke] exportDialog: no size estimate');
      // Karaoke (S15): the audio choice is there, and offers the instrumental only once stems are ready.
      const audioSelect = document.querySelector('#app .export-dialog [data-action="export-audio"]');
      const audioChoice = audioSelect !== null && [...audioSelect.options].some((o) => o.value === 'instrumental')
        && (audioSelect.disabled || (document.querySelector('#app [data-testid="stems-controls"]')?.getAttribute('data-state') === 'ready'));
      if (!audioChoice) console.error('[smoke] exportDialog: no karaoke audio choice, or it is offered without stems');
      // Motion blur (S10): off, its choices disabled, until ticked.
      const blurSamples = () => document.querySelector('#app .export-dialog [data-action="export-blur-samples"]');
      const blurWasOff = blurSamples()?.disabled === true;
      document.querySelector('#app .export-dialog [data-action="export-motion-blur"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((done) => setTimeout(done, 50));
      const blurToggles = blurWasOff && blurSamples()?.disabled === false
        && (document.querySelector('#app .export-blur')?.textContent ?? '').includes('render time');
      if (!blurToggles) console.error('[smoke] exportDialog: the motion-blur toggle did not enable its choices');
      document.querySelector('#app .modal-backdrop')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((done) => setTimeout(done, 50));
      const exportDialog = presets >= 6 && sizeShown && blurToggles && audioChoice && document.querySelector('#app .export-dialog') === null;

      console.log('[smoke] step: ' + 'checkpoint'); recoveryTrace.push('markers:' + (document.querySelector('#app .recovery-dialog') !== null));
      // Markers (S9): M adds one at the playhead (one undo step), a double-click in the markers lane
      // adds another and opens its editor, typing renames it, and the export dialog then offers a
      // range between markers.
      const undoLabel = () => document.querySelector('#app header button[data-action="undo"]')?.textContent ?? '';
      const canvasEl = document.querySelector('#app [data-testid="timeline"]');
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }));
      const addedByKey = (await waitFor(() => undoLabel().includes('Add marker'), 40)) === true;
      let editorOpened = false;
      let renamed = false;
      let editorClosed = false;
      let escapeClosed = false;
      if (canvasEl !== null) {
        const r = canvasEl.getBoundingClientRect();
        canvasEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: r.left + r.width * 0.7, clientY: r.top + 66 }));
        const nameInput = await waitFor(() => document.querySelector('#app [data-action="marker-name"]'), 40);
        editorOpened = nameInput !== null && nameInput !== false;
        if (editorOpened) {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(nameInput, 'Smoke drop');
          nameInput.dispatchEvent(new Event('input', { bubbles: true }));
          renamed = (await waitFor(() => undoLabel().includes('Rename marker'), 40)) === true;
          nameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          editorClosed = (await waitFor(() => document.querySelector('#app [data-testid="marker-editor"]') === null, 40)) === true;
          // And Escape, from a reopened editor.
          canvasEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: r.left + r.width * 0.7 + 2, clientY: r.top + 66 }));
          const again = await waitFor(() => document.querySelector('#app [data-action="marker-name"]'), 40);
          again?.dispatchEvent?.(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          escapeClosed = again !== null && again !== false && (await waitFor(() => document.querySelector('#app [data-testid="marker-editor"]') === null, 40)) === true;
        }
      }
      document.querySelector('#app header button[data-action="export"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const rangeOffered = (await waitFor(() => [...(document.querySelector('#app [data-action="export-range-from"]')?.options ?? [])].some((o) => o.textContent.includes('Smoke drop')), 40)) === true;
      document.querySelector('#app .modal-backdrop')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const navButtons = document.querySelector('#app [data-action="marker-prev"]') !== null && document.querySelector('#app [data-action="marker-next"]') !== null;
      const markerSteps = { addedByKey, editorOpened, renamed, editorClosed, escapeClosed, rangeOffered, navButtons };
      const markerUi = Object.values(markerSteps).every(Boolean);
      if (!markerUi) console.error('[smoke] markerUi steps ' + JSON.stringify(markerSteps));

      console.log('[smoke] step: ' + 'checkpoint'); recoveryTrace.push('batch:' + (document.querySelector('#app .recovery-dialog') !== null));
      // The performance HUD (S12): the canvas bar opens it, it fills with measured GPU times for the
      // project's layers and the output pass (or says timer queries are missing), and it closes.
      document.querySelector('#app [data-action="perf-hud"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const measured = await waitFor(() => document.querySelector('#app [data-testid="perf-hud"] tr[data-span="output"]') !== null
        || /does not expose/.test(document.querySelector('#app [data-testid="perf-hud"]')?.textContent ?? ''), 100);
      const hudRows = document.querySelectorAll('#app [data-testid="perf-hud"] tr[data-span]').length;
      const hudText = document.querySelector('#app [data-testid="perf-hud"]')?.textContent ?? '';
      document.querySelector('#app [data-action="perf-hud"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const hudClosed = (await waitFor(() => document.querySelector('#app [data-testid="perf-hud"]') === null, 40)) === true;
      const hudSteps = { measured: measured === true, rows: hudRows >= 2, estimate: /3840×2160|does not expose/.test(hudText), hudClosed };
      const perfHud = Object.values(hudSteps).every(Boolean);
      if (!perfHud) console.error('[smoke] perfHud steps ' + JSON.stringify(hudSteps) + ' ' + hudText.slice(0, 200));

      // Draft mode (S18): the canvas bar's Draft caps the preview at 640 px on the long side (the size
      // badge says so), the preview keeps drawing with no new errors, and Draft off restores the size.
      console.log('[smoke] step: draftUi');
      let draftUi = false;
      {
        const badge = () => document.querySelector('#app [data-testid="render-size"]')?.textContent ?? '';
        const sizeOf = (text) => text.replace('Draft', '').trim().split('×').map(Number);
        const before = badge();
        document.querySelector('#app [data-action="draft-mode"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const drafted = (await waitFor(() => badge().startsWith('Draft'), 40)) === true;
        const [w, h] = sizeOf(badge());
        const capped = Math.max(w, h) <= 640 && Math.max(w, h) > 0;
        await new Promise((d) => setTimeout(d, 300));
        const errorFree = document.querySelector('#app .canvas-error') === null;
        document.querySelector('#app [data-action="draft-mode"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const restored = (await waitFor(() => badge() === before, 40)) === true;
        const draftSteps = { drafted, capped, errorFree, restored };
        draftUi = Object.values(draftSteps).every(Boolean);
        if (!draftUi) console.error('[smoke] draftUi steps ' + JSON.stringify(draftSteps) + ' ' + before + ' / ' + badge());
      }

      // LUTs (S11): a background layer gets the LUT effect, Choose picks a .cube (the smoke answers
      // with a generated one), the inspector names it, and the preview grades with no LUT note.
      console.log('[smoke] step: lutUi');
      let lutUi = false;
      {
        document.querySelector('#app .module-buttons button[data-action="add-layer"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
        await new Promise((d) => setTimeout(d, 100));
        const picker = document.querySelector('#app .inspector select[data-action="add-effect"]');
        const hasOption = picker !== null && [...picker.options].some((o) => o.value === 'core.effect.lut');
        if (hasOption) {
          picker.value = 'core.effect.lut';
          picker.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const chooser = await waitFor(() => document.querySelector('#app .inspector [data-action="choose-lut"]'), 40);
        if (chooser) chooser.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const named = (await waitFor(() => [...document.querySelectorAll('#app .inspector .asset-name')].some((n) => (n.textContent ?? '').includes('smoke-lut.cube')), 60)) === true;
        await new Promise((d) => setTimeout(d, 400));
        const notes = document.querySelector('#app .canvas-notes')?.textContent ?? '';
        const graded = named && !notes.includes('LUT');
        const lutSteps = { hasOption, chooser: chooser !== null && chooser !== false, named, graded };
        lutUi = Object.values(lutSteps).every(Boolean);
        if (!lutUi) console.error('[smoke] lutUi steps ' + JSON.stringify(lutSteps) + ' ' + notes.slice(0, 200));
      }

      // Shadertoy (S2): the paste dialog checks as you type — the example compiles, a typo is named on
      // its own line — and Add saves it in modules/ and puts it on the project as a layer that renders.
      console.log('[smoke] step: shadertoyUi');
      let shadertoyUi = false;
      {
        const setText = (el, value, proto) => {
          Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        const resultText = () => document.querySelector('#app [data-testid="shadertoy-result"]')?.textContent ?? '';
        document.querySelector('#app [data-action="shadertoy-paste"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const area = await waitFor(() => document.querySelector('#app [data-action="shadertoy-code"]'), 40);
        const good = area ? area.value : '';
        const compiles = (await waitFor(() => resultText() === 'Compiles.', 60)) === true;
        let lineNamed = false;
        if (area) {
          // A typo as the author's line 4. No backslashes anywhere here: this whole script is a template
          // literal, which turns a written "\\n" into a real line break inside a string and breaks it.
          const newline = String.fromCharCode(10);
          setText(area, good.replace('vec2 uv = fragCoord / iResolution.xy;', 'vec2 uv = fragCoord / iResolution.xy;' + newline + '    float broken = vec2(1.0);'), HTMLTextAreaElement);
          lineNamed = (await waitFor(() => resultText().includes('0:4:'), 60)) === true;
          if (!lineNamed) console.error('[smoke] shadertoyUi error text: ' + JSON.stringify(resultText()));
          setText(area, good, HTMLTextAreaElement);
          setText(document.querySelector('#app [data-action="shadertoy-name"]'), 'Smoke Shadertoy', HTMLInputElement);
          await waitFor(() => resultText() === 'Compiles.', 60);
        }
        document.querySelector('#app [data-action="shadertoy-add"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const added = (await waitFor(() => [...document.querySelectorAll('#app .layer-list .layer-row')].some((row) => (row.textContent ?? '').includes('Smoke Shadertoy')), 100)) === true;
        await new Promise((d) => setTimeout(d, 400));
        const notes = document.querySelector('#app .canvas-notes')?.textContent ?? '';
        const rendered = added && !/unknown module|does not compile|is broken/.test(notes);
        const stSteps = { opened: area !== null && area !== false, compiles, lineNamed, added, rendered, closed: document.querySelector('#app .shadertoy-dialog') === null };
        shadertoyUi = Object.values(stSteps).every(Boolean);
        if (!shadertoyUi) console.error('[smoke] shadertoyUi steps ' + JSON.stringify(stSteps) + ' ' + resultText().slice(0, 200) + ' | ' + notes.slice(0, 200));
      }

      // Batch mode (S13): the top bar opens the dialog, which starts empty and cannot start; a drop
      // of something that is not audio on disk is answered rather than ignored; the queue drawer
      // offers "Shut down when done". The batch itself is run from the main process below.
      document.querySelector('#app header button[data-action="batch"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const batchDialog = await waitFor(() => document.querySelector('#app .batch-dialog'), 40);
      const startDisabled = document.querySelector('#app [data-action="batch-start"]')?.disabled === true;
      const transfer = new DataTransfer();
      transfer.items.add(new File(['x'], 'not-on-disk.wav', { type: 'audio/wav' }));
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
      const dropAnswered = (await waitFor(() => (document.querySelector('#app .toast')?.textContent ?? '').includes('Drop audio files'), 40)) === true;
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      const batchClosed = (await waitFor(() => document.querySelector('#app .batch-dialog') === null, 40)) === true;
      document.querySelector('#app header button[data-action="render-queue"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const shutdownOffered = (await waitFor(() => document.querySelector('#app [data-action="shutdown-when-done"]') !== null, 40)) === true;
      document.querySelector('#app header button[data-action="render-queue"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const batchSteps = { dialog: batchDialog !== null && batchDialog !== false, startDisabled, dropAnswered, batchClosed, shutdownOffered };
      const batchUi = Object.values(batchSteps).every(Boolean);
      if (!batchUi) console.error('[smoke] batchUi steps ' + JSON.stringify(batchSteps));

      // Crash recovery (M1), last because it replaces the project: the seeded autosave of a
      // "crashed" run is offered on start with its summary, and Restore opens it — unsaved — with
      // its layer. (The main process then checks the old session was let go and this one holds a
      // fresh snapshot.) The "discard your changes?" question is answered yes: nothing here is kept.
      console.log('[smoke] step: ' + 'checkpoint'); recoveryTrace.push('recovery:' + (document.querySelector('#app .recovery-dialog') !== null));
      let recoveryDialog = ${initialProjectPath() === undefined ? 'false' : 'undefined'};
      const offered = recoveryDialog === undefined ? null : await waitFor(() => document.querySelector('#app .recovery-dialog [data-recovery="smokecrashed"]'), 60);
      if (offered !== null && offered !== false) {
        const summary = offered.textContent ?? '';
        window.confirm = () => true;
        document.querySelector('#app [data-action="recovery-restore"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        // Generous: this check runs last, after the heavy ones (setup verify, cache clearing), and on
        // a busy machine the restore and its snapshot can take a few seconds.
        const restored = await waitFor(() => [...document.querySelectorAll('#app .layer-list .layer-row')].some((row) => row.textContent?.includes('Recovered smoke layer')), 200);
        recoveryDialog = summary.includes('Smoke crash') && summary.includes('never saved') && restored === true
          && document.querySelector('#app .recovery-dialog') === null;
        if (!recoveryDialog) console.error('[smoke] recoveryDialog steps ' + JSON.stringify({ summary: summary.slice(0, 120), restored, open: document.querySelector('#app .recovery-dialog') !== null }));
      } else if (recoveryDialog === false) {
        console.error('[smoke] recoveryDialog: the dialog was not offered; on screen: ' + JSON.stringify({ dialog: document.querySelector('#app .recovery-dialog') !== null, cards: [...document.querySelectorAll('#app [data-recovery]')].map((c) => c.getAttribute('data-recovery')), modals: [...document.querySelectorAll('#app .modal')].map((m) => m.className), trace: recoveryTrace }));
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
        diagnosticsUi,
        extrasUi,
        keyframeUi,
        maskUi,
        ...(stemsUi === undefined ? {} : { stemsUi }),
        ...(lyricsUi === undefined ? {} : { lyricsUi }),
        ...(alignLive === undefined ? {} : { alignLive }),
        exportDialog,
        unicodeFonts,
        beatsUi,
        layerDragUi,
        pickerUi,
        multiSelectUi,
        milkdropUi,
        shortcutUi,
        batchUi,
        markerUi,
        perfHud,
        shadertoyUi,
        lutUi,
        draftUi,
        ...(recoveryDialog === undefined ? {} : { recoveryDialog }),
      };
    })()`) as Record<string, boolean>;

    console.log('[smoke] phase: renderer checks finished');
    // The Shadertoy check saved a shader in the real modules/ folder; it goes again (the studio's
    // watcher unloads it). Only files the check made — named for it — are ever touched.
    for (const name of ['Smoke Shadertoy.glsl', 'Smoke Shadertoy 2.glsl']) await rm(join(MODULES_DIR, name), { force: true });

    // The other half of the diagnostics check: the clipboard holds the report, and the log file has
    // the app's start, the copy itself, and lines captured from the studio's own console.
    if (checks['diagnosticsUi'] === true) {
      const text = await clipboard.readText();
      let logText: string;
      try {
        logText = await readFile(log().path, 'utf8');
      } catch {
        logText = '';
      }
      const entries = logText.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as { scope?: string; msg?: string });
      const ok = text.startsWith('# Pulseforge diagnostics') && text.includes('## Environment')
        && entries.some((e) => e.scope === 'app' && /started/.test(e.msg ?? ''))
        && entries.some((e) => e.scope === 'diagnostics')
        && entries.some((e) => e.scope === 'smoke-renderer');
      if (!ok) console.error(`[smoke] diagnostics: clipboard ${text.slice(0, 40)}…, ${entries.length} log lines`);
      checks['diagnosticsUi'] = ok;
    }

    // The other half of the recovery check: restoring let the crashed run's folder go and took a
    // fresh snapshot into this run's own (a crash from here on recovers the restored work).
    if (checks['recoveryDialog'] === true) {
      let sessions: readonly string[] = [];
      for (let i = 0; i < 200; i += 1) {
        sessions = (await recoveryStore().listRecoverable('none')).map((session) => session.sessionId);
        if (!sessions.includes('smokecrashed') && sessions.includes(recoverySessionId)) break;
        await new Promise((done) => setTimeout(done, 50));
      }
      checks['recoveryDialog'] = !sessions.includes('smokecrashed') && sessions.includes(recoverySessionId);
      if (!checks['recoveryDialog']) console.error(`[smoke] recovery sessions after restore: ${JSON.stringify(sessions)} (this run: ${recoverySessionId})`);
    }

    console.log('[smoke] phase: queued render');
    // A real render through the studio's queue, from inside Electron's main process. This is the
    // path the Node-side check cannot cover: here `electron` is the API object, not a path, and
    // esbuild must load at runtime rather than from the bundle.
    const smokeAudio = process.env['PULSEFORGE_SMOKE_RENDER'];
    if (smokeAudio !== undefined && smokeAudio !== '') {
      const project = createDocument({ name: 'Smoke render', canvas: { width: 640, height: 360 } });
      const withLayer = { ...project, layers: [createModuleLayer('core.visualizer.bars', { name: 'bars' })], audio: { ...project.audio, path: smokeAudio } };
      const output = join(ROOT, 'out', 'smoke-render.mp4');
      const job = await renders.enqueue({ text: stringifyDocument(withLayer), projectPath: null, presetId: 'project-h264', outputPath: output, motionBlur: { samples: 4, shutterDegrees: 180 } });
      await Promise.race([renders.idle(), new Promise((done) => setTimeout(done, 120_000))]);
      const finished = renders.list().find((entry) => entry.id === job.id);
      if (finished?.error) console.error(`[smoke] render error: ${finished.error}`);
      // Queued with motion blur (S10), which the job carries through to the render and its report.
      const blurred = finished?.reportPath != null && existsSync(finished.reportPath)
        && (JSON.parse(readFileSync(finished.reportPath, 'utf8')) as { motionBlur?: { samples: number } | null }).motionBlur?.samples === 4;
      if (!blurred) console.error('[smoke] queuedRender: the report does not record the motion blur');
      checks['queuedRender'] = finished?.status === 'done' && existsSync(output) && finished.progress?.fraction === 1 && blurred;
    }

    console.log('[smoke] phase: batch run');
    // Batch mode (S13), from the main process: the smoke song becomes an auto-directed project in its
    // own folder, queued for rendering. Without a smoke render the queued job is cancelled (a
    // full-length render is minutes); with one, it renders with "shut down when done" on, and the
    // shutdown is requested — recorded, never run, in smoke mode.
    if (batchService !== null && smokeAudioPath !== null) {
      const batchDir = join(ROOT, 'out', 'smoke-batch');
      await rm(batchDir, { recursive: true, force: true });
      const renderToo = smokeAudio !== undefined && smokeAudio !== '';
      if (renderToo) shutdownWhenDone = true;
      const before = new Set(renders.list().map((job) => job.id));
      const started = await batchService.start({ tracks: [smokeAudioPath], outDir: batchDir, presetId: 'project-h264', templateId: null, seed: 1, stems: false, motionBlur: null });
      await batchService.settled();
      console.log('[smoke] phase: batch directed');
      const status = batchService.status();
      const track = status?.tracks[0];
      const job = renders.list().find((entry) => !before.has(entry.id));
      const project = track === undefined || !existsSync(track.projectPath) ? null : loadDocument(readFileSync(track.projectPath, 'utf8')).document;
      let rendered = true;
      if (job !== undefined && renderToo) {
        await Promise.race([renders.idle(), new Promise((done) => setTimeout(done, 240_000))]);
        console.log('[smoke] phase: batch render finished waiting');
        const finishedJob = renders.list().find((entry) => entry.id === job.id);
        rendered = finishedJob?.status === 'done' && existsSync(finishedJob.outputPath)
          && smokeShutdownCalls.some((call) => call[0] === '/s');
      } else if (job !== undefined) {
        await renders.cancel(job.id);
      }
      const steps = {
        started: started.tracks.length === 1,
        queued: status?.state === 'finished' && track?.state === 'queued',
        project: project !== null && project.layers.length > 0 && project.director !== null,
        job: job !== undefined && job.outputPath === track?.outputPath,
        rendered,
      };
      checks['batchRun'] = Object.values(steps).every(Boolean);
      if (!checks['batchRun']) console.error(`[smoke] batchRun steps ${JSON.stringify(steps)} ${JSON.stringify(status)}`);
      shutdownWhenDone = false;
    }

    console.log('[smoke] phase: verdict');
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

    // What MilkDrop looks like in the studio, playing, for a person to read.
    try {
      await window.webContents.executeJavaScript(`(async () => {
        document.querySelector('#app [data-action="preset-scope-milkdrop"]')?.click();
        await new Promise((done) => setTimeout(done, 1500));
        document.querySelectorAll('#app [data-action="apply-milkdrop"]')[3]?.click();
        await new Promise((done) => setTimeout(done, 400));
        document.querySelector('#app .transport button[title="Play"]')?.click();
        await new Promise((done) => setTimeout(done, 3000));
      })()`);
      await writeFile(join(dirname(shot), 'smoke-milkdrop.png'), (await window.webContents.capturePage()).toPNG());
    } catch (error) {
      console.error(`[smoke] could not capture MilkDrop: ${error instanceof Error ? error.message : String(error)}`);
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
    // Keyframes (S1): the recovery check replaced the project, so the tour animates a layer of its
    // own — a Bars layer keyed at 5 s and 20 s — and shows the Keyframes section, the key editor
    // and the timeline's keyframe row.
    await js(`[...document.querySelectorAll('#app .module-buttons button')].find((b) => b.textContent?.trim() === 'Bars')?.dispatchEvent(new MouseEvent('click', { bubbles: true })); await new Promise((d) => setTimeout(d, 200))`);
    const seekTo = (seconds: number) => `
      const timeline = document.querySelector('#app [data-testid="timeline"]');
      const box = timeline.getBoundingClientRect();
      const at = { clientX: box.left + 8 + (${seconds} / 60) * (box.width - 16), clientY: box.top + 10, pointerId: 9, bubbles: true };
      timeline.dispatchEvent(new PointerEvent('pointerdown', at));
      timeline.dispatchEvent(new PointerEvent('pointerup', at));
      await new Promise((d) => setTimeout(d, 200))`;
    await js(seekTo(5));
    await js(click('#app .inspector .param-group [data-action="keyframe"]'));
    await js(seekTo(20));
    await js(`
      const range = document.querySelector('#app .inspector .param-group input[type="range"]');
      if (range) { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(range, range.max); range.dispatchEvent(new Event('input', { bubbles: true })); range.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); }`);
    await js(`document.querySelector('#app [data-testid="keyframes-section"]')?.scrollIntoView(); ${click('#app [data-testid="keyframes-section"] .key-chip')}`);
    await js(`
      const easing = document.querySelector('#app [data-action="key-easing"]');
      if (easing) { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(easing, 'easeInOut'); easing.dispatchEvent(new Event('change', { bubbles: true })); }
      document.querySelector('#app [data-testid="key-editor"]')?.scrollIntoView()`);
    await snap(`${label}-12-keyframes`);
    // Batch mode (S13): the dialog with two tracks in it.
    await js(`${click('#app header button[data-action="batch"]')}; await new Promise((d) => setTimeout(d, 200));
      ${click('#app [data-action="batch-add"]')}; await new Promise((d) => setTimeout(d, 300));
      ${click('#app [data-action="batch-add"]')}; await new Promise((d) => setTimeout(d, 300))`);
    await snap(`${label}-13-batch`);
    await js(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    // Markers (S9): three at the playhead, the middle one recoloured and its editor open.
    const pressM = `document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true })); await new Promise((d) => setTimeout(d, 150))`;
    for (const at of [12, 30, 45]) {
      await js(seekTo(at));
      await js(pressM);
    }
    await js(`
      const timeline = document.querySelector('#app [data-testid="timeline"]');
      const box = timeline.getBoundingClientRect();
      timeline.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: box.left + 8 + (30 / 60) * (box.width - 16) + 2, clientY: box.top + 66 }));
      await new Promise((d) => setTimeout(d, 200));
      document.querySelectorAll('#app .marker-swatches .swatch')[2]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((d) => setTimeout(d, 200))`);
    await snap(`${label}-14-markers`);
    await js(`document.querySelector('#app [data-action="marker-name"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await new Promise((d) => setTimeout(d, 100))`);
    // The performance HUD (S12) over the animated project.
    await js(`${click('#app [data-action="perf-hud"]')}; await new Promise((d) => setTimeout(d, 800))`);
    await snap(`${label}-15-perf-hud`);
    await js(click('#app [data-action="perf-hud"]'));
    // The Shadertoy paste dialog (S2) with its example, checked.
    await js(`${click('#app [data-action="shadertoy-paste"]')}; await new Promise((d) => setTimeout(d, 800))`);
    await snap(`${label}-16-shadertoy`);
    await js(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    // Draft mode (S18) with the HUD open: the low-resolution preview and what it costs.
    await js(`${click('#app [data-action="draft-mode"]')}; ${click('#app [data-action="perf-hud"]')}; await new Promise((d) => setTimeout(d, 800))`);
    await snap(`${label}-17-draft`);
    await js(`${click('#app [data-action="draft-mode"]')}; ${click('#app [data-action="perf-hud"]')}`);
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
