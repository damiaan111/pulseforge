// The only bridge between the sandboxed renderer and the main process.
//
// Runs with context isolation on, so nothing here leaks into the page's own world: the renderer
// sees exactly the functions below on `window.pulseforge` and nothing else — no `ipcRenderer`,
// no `require`, no Node. Every addition to this file widens the app's attack surface by exactly
// one capability, which is why the API in ipc.ts is deliberately small enough to read in one go.
//
// Arguments are passed straight through and validated on the main side (they arrive from a
// renderer that, in principle, could be running a third-party module).

import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type ProjectFile, type PulseforgeApi, type RenderJob, type SaveRequest, type SaveResult } from './ipc.ts';
// (SaveResult stays imported for saveProject's cast.)

const api: PulseforgeApi = {
  initialProject: () => ipcRenderer.invoke(IPC.projectInitial) as Promise<ProjectFile | null>,
  openProject: () => ipcRenderer.invoke(IPC.projectOpen) as Promise<ProjectFile | null>,
  readProject: (path) => ipcRenderer.invoke(IPC.projectRead, path) as Promise<ProjectFile>,
  saveProject: (request: SaveRequest) => ipcRenderer.invoke(IPC.projectSave, request) as Promise<SaveResult>,
  pickProjectSavePath: (suggestedName) => ipcRenderer.invoke(IPC.projectPickSavePath, suggestedName) as Promise<string | null>,
  collectProject: (text) => ipcRenderer.invoke(IPC.projectCollect, text) as ReturnType<PulseforgeApi['collectProject']>,
  findAssetsInFolder: (wanted) => ipcRenderer.invoke(IPC.assetFindInFolder, wanted) as ReturnType<PulseforgeApi['findAssetsInFolder']>,
  revealAsset: (path) => ipcRenderer.invoke(IPC.assetReveal, path) as Promise<void>,
  listLibrary: () => ipcRenderer.invoke(IPC.libraryList) as ReturnType<PulseforgeApi['listLibrary']>,
  addToLibrary: (category) => ipcRenderer.invoke(IPC.libraryAdd, category) as ReturnType<PulseforgeApi['addToLibrary']>,
  libraryThumbnail: (path) => ipcRenderer.invoke(IPC.libraryThumbnail, path) as ReturnType<PulseforgeApi['libraryThumbnail']>,
  revealLibrary: () => ipcRenderer.invoke(IPC.libraryReveal) as Promise<void>,
  pickAudio: () => ipcRenderer.invoke(IPC.audioPick) as ReturnType<PulseforgeApi['pickAudio']>,
  readAudio: (path) => ipcRenderer.invoke(IPC.audioRead, path) as ReturnType<PulseforgeApi['readAudio']>,
  analyzeAudio: (path, settings) => ipcRenderer.invoke(IPC.audioAnalyze, path, settings) as ReturnType<PulseforgeApi['analyzeAudio']>,
  listModules: () => ipcRenderer.invoke(IPC.modulesList) as ReturnType<PulseforgeApi['listModules']>,
  revealModules: () => ipcRenderer.invoke(IPC.modulesReveal) as Promise<void>,
  listPresets: () => ipcRenderer.invoke(IPC.presetsList) as ReturnType<PulseforgeApi['listPresets']>,
  savePreset: (preset) => ipcRenderer.invoke(IPC.presetsSave, preset) as ReturnType<PulseforgeApi['savePreset']>,
  deletePreset: (scope, slug) => ipcRenderer.invoke(IPC.presetsDelete, scope, slug) as ReturnType<PulseforgeApi['deletePreset']>,
  setPresetFavourite: (scope, slug, on) => ipcRenderer.invoke(IPC.presetsFavourite, scope, slug, on) as ReturnType<PulseforgeApi['setPresetFavourite']>,
  presetThumbnail: (key) => ipcRenderer.invoke(IPC.presetsThumbnail, key) as ReturnType<PulseforgeApi['presetThumbnail']>,
  storePresetThumbnail: (key, png) => ipcRenderer.invoke(IPC.presetsStoreThumbnail, key, png) as Promise<void>,
  revealPresets: () => ipcRenderer.invoke(IPC.presetsReveal) as Promise<void>,
  onModulesChanged(listener) {
    const handler = () => listener();
    ipcRenderer.on(IPC.modulesChanged, handler);
    return () => {
      ipcRenderer.removeListener(IPC.modulesChanged, handler);
    };
  },
  importVideo: () => ipcRenderer.invoke(IPC.videoImport) as ReturnType<PulseforgeApi['importVideo']>,
  prepareVideo: (request) => ipcRenderer.invoke(IPC.videoPrepare, request) as ReturnType<PulseforgeApi['prepareVideo']>,
  videoFrame: (hash, fps, sourceFrame) => ipcRenderer.invoke(IPC.videoFrame, hash, fps, sourceFrame) as ReturnType<PulseforgeApi['videoFrame']>,
  onVideoProgress(listener) {
    // Wrapped for the same reason as onRendersChanged: the page never gets the IPC event object.
    const handler = (_event: unknown, hash: string, frames: number) => listener(hash, frames);
    ipcRenderer.on(IPC.videoProgress, handler);
    return () => {
      ipcRenderer.removeListener(IPC.videoProgress, handler);
    };
  },
  importFont: () => ipcRenderer.invoke(IPC.fontImport) as ReturnType<PulseforgeApi['importFont']>,
  loadFont: (path, projectPath) => ipcRenderer.invoke(IPC.fontLoad, path, projectPath) as ReturnType<PulseforgeApi['loadFont']>,
  defaultFont: () => ipcRenderer.invoke(IPC.fontDefault) as ReturnType<PulseforgeApi['defaultFont']>,
  importImage: () => ipcRenderer.invoke(IPC.imageImport) as ReturnType<PulseforgeApi['importImage']>,
  loadImage: (path, projectPath) => ipcRenderer.invoke(IPC.imageLoad, path, projectPath) as ReturnType<PulseforgeApi['loadImage']>,
  environment: () => ipcRenderer.invoke(IPC.environment) as ReturnType<PulseforgeApi['environment']>,
  pickRenderOutput: (suggestedName) => ipcRenderer.invoke(IPC.renderPickOutput, suggestedName) as Promise<string | null>,
  enqueueRender: (request) => ipcRenderer.invoke(IPC.renderEnqueue, request) as ReturnType<PulseforgeApi['enqueueRender']>,
  listRenders: () => ipcRenderer.invoke(IPC.renderList) as ReturnType<PulseforgeApi['listRenders']>,
  cancelRender: (id) => ipcRenderer.invoke(IPC.renderCancel, id) as Promise<void>,
  retryRender: (id) => ipcRenderer.invoke(IPC.renderRetry, id) as Promise<void>,
  removeRender: (id) => ipcRenderer.invoke(IPC.renderRemove, id) as Promise<void>,
  clearFinishedRenders: () => ipcRenderer.invoke(IPC.renderClearFinished) as Promise<void>,
  revealRender: (path) => ipcRenderer.invoke(IPC.renderReveal, path) as Promise<void>,
  onRendersChanged(listener) {
    // Wrapped, so the page never receives the IpcRendererEvent (it carries `sender`, a handle
    // back into ipcRenderer that context isolation exists to keep out of the page).
    const handler = (_event: unknown, jobs: readonly RenderJob[]) => listener(jobs);
    ipcRenderer.on(IPC.renderChanged, handler);
    return () => {
      ipcRenderer.removeListener(IPC.renderChanged, handler);
    };
  },
};

contextBridge.exposeInMainWorld('pulseforge', api);
