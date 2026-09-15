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
import { FFMPEG_EXE, FFPROBE_EXE, PYTHON_EXE } from '../../setup/lib/paths.ts';
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
      const cache = new AnalysisCache({ root: join(app.getPath('userData'), 'cache', 'analysis') });
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

      return {
        rendered: document.querySelector('#app header') !== null,
        bridge: typeof window.pulseforge?.openProject === 'function',
        noNode,
        offline,
        // The layer this check added itself, so there is always something to act on.
        layerAdded: before === 1,
        undoable: undoEnabled,
        effectChain,
      };
    })()`) as Record<string, boolean>;

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
