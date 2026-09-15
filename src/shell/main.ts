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
  IPC, type AnalysisPayload, type AudioBytes, type EnvironmentReport, type ProjectFile,
  type SaveRequest, type SaveResult,
} from './ipc.ts';
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

  ipcMain.handle(IPC.projectSaveAs, async (_event, text: unknown, suggestedName: unknown): Promise<SaveResult | null> => {
    if (typeof text !== 'string') throw new Error('saveProjectAs needs the project text');
    const result = await dialog.showSaveDialog({
      title: 'Save project as',
      defaultPath: typeof suggestedName === 'string' ? suggestedName : 'untitled.pvproj',
      filters: PROJECT_FILTERS,
    });
    if (result.canceled || result.filePath === undefined) return null;
    try {
      return await writeProjectText(result.filePath, text);
    } catch (error) {
      throw describe(error);
    }
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
  await window.loadFile(RENDERER_HTML);
  return window;
}

// Sandboxing every renderer by default, not just the ones that remember to ask.
app.enableSandbox();

app.whenReady().then(async () => {
  lockDownSession();
  guardWebContents();
  registerHandlers();

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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
