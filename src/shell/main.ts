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

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { BrowserWindow, app, dialog, ipcMain, session, shell } from 'electron';
import { FFMPEG_EXE, FFPROBE_EXE, PYTHON_EXE, ROOT } from '../../setup/lib/paths.ts';
import { AnalysisCache } from '../analysis/cache.ts';
import { analyzeCached } from '../analysis/cached.ts';
import { encodeAnalysis } from '../analysis/container.ts';
import { decodeMono48k } from '../analysis/decode.ts';
import { encodePeaks } from '../analysis/peaks.ts';
import {
  IPC, type AnalysisPayload, type AudioBytes, type CollectSummary, type EnvironmentReport, type FolderSearchResult,
  type ImageBytes, type ImageLoadResult, type LibraryListing, type ProjectFile, type SaveRequest, type SaveResult, type WantedAsset,
} from './ipc.ts';
import { IMAGE_EXTENSIONS, decodeImageFile } from '../assets/image-decode.ts';
import { resolveAssetPath } from '../assets/load-images.ts';
import { collectProject } from '../assets/collect-files.ts';
import { findFilesInFolder } from '../assets/find-in-folder.ts';
import { addToLibrary, listLibrary } from '../assets/library.ts';
import { loadDocument } from '../project/load.ts';

/** Library thumbnails: decoded this small, so a panel of fifty costs little. */
const THUMBNAIL_SIDE = 160;
import { ProjectIoError, readProjectText, writeProjectText } from './project-io.ts';
import { RenderRequestError, createRenderService, type RenderRequest, type RenderService } from './render-service.ts';
import { createDocument, createModuleLayer } from '../project/create.ts';
import { stringifyDocument } from '../project/serialize.ts';

/** The analysis cache the preview and the render queue share, so a queued render is a cache hit. */
function analysisCacheRoot(): string {
  return join(app.getPath('userData'), 'cache', 'analysis');
}

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

function environmentReport(): EnvironmentReport {
  const present = (path: string) => ({ path, present: existsSync(path) });
  return {
    appVersion: app.getVersion(),
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

  ipcMain.handle(IPC.audioAnalyze, async (_event, path: unknown): Promise<AnalysisPayload> => {
    if (typeof path !== 'string') throw new Error('analyzeAudio needs a path');
    if (!existsSync(FFMPEG_EXE)) {
      throw new Error('The vendored FFmpeg is missing.\n\nTry:\n• Run `npm run setup` to provision vendor/');
    }
    try {
      // The same decode and the same cache the exporter uses, so the preview reacts to exactly
      // the numbers the export will — not to Chromium's decoder (ipc.ts, AnalysisPayload).
      const decoded = await decodeMono48k(FFMPEG_EXE, path);
      const cache = new AnalysisCache({ root: analysisCacheRoot() });
      const result = await analyzeCached(decoded.pcm, cache, { audioHash: decoded.pcmSha256 });
      const source = result.analysis.sources.get('mix');
      if (source === undefined) throw new Error('the analyser produced no mix source');
      return {
        container: encodeAnalysis(source, { source: 'mix', beatGrid: result.beatGrid, meta: { audioHash: result.audioHash } }),
        peaks: encodePeaks(result.peaks),
        sections: result.sections.map((s) => ({ startSeconds: s.startSeconds, endSeconds: s.endSeconds, label: s.label })),
        durationSeconds: decoded.pcm.length / 48_000,
        fromCache: result.fromCache,
      };
    } catch (error) {
      throw describe(error);
    }
  });

  const decodeForRenderer = async (path: string): Promise<ImageBytes> => {
    if (!existsSync(FFMPEG_EXE) || !existsSync(FFPROBE_EXE)) {
      throw new Error('The vendored FFmpeg is missing.\n\nTry:\n• Run `npm run setup` to provision vendor/');
    }
    const image = await decodeImageFile(FFMPEG_EXE, FFPROBE_EXE, path);
    return { path, hash: image.sha256, size: image.fileSize, name: image.name, width: image.width, height: image.height, pixels: image.pixels };
  };

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
  registerHandlers();

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
      cacheRoot: analysisCacheRoot(),
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

      // The export dialog opens from the top bar and lists every preset. Queueing is exercised
      // separately (PULSEFORGE_SMOKE_RENDER), because it needs an audio file and a real render.
      document.querySelector('#app header button[data-action="export"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((done) => setTimeout(done, 50));
      const presets = document.querySelectorAll('#app .export-dialog input[data-action="export-preset"]').length;
      document.querySelector('#app .modal-backdrop')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((done) => setTimeout(done, 50));
      const exportDialog = presets >= 6 && document.querySelector('#app .export-dialog') === null;

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
        libraryToAsset,
        exportDialog,
      };
    })()`) as Record<string, boolean>;

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
    app.exit(failed.length === 0 ? 0 : 1);
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
  }
  console.log(`[smoke] ui tour written to ${dir}`);
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
