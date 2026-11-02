// The only bridge between the sandboxed renderer and the main process.
//
// Runs with context isolation on, so nothing here leaks into the page's own world: the renderer
// sees exactly the functions below on `window.pulseforge` and nothing else — no `ipcRenderer`,
// no `require`, no Node. Every addition to this file widens the app's attack surface by exactly
// one capability, which is why the API in ipc.ts is deliberately small enough to read in one go.
//
// Arguments are passed straight through and validated on the main side (they arrive from a
// renderer that, in principle, could be running a third-party module).

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { IPC, type ProjectFile, type PulseforgeApi, type RenderJob, type SaveRequest, type SaveResult } from './ipc.ts';
// (SaveResult stays imported for saveProject's cast.)

const api: PulseforgeApi = {
  initialProject: () => ipcRenderer.invoke(IPC.projectInitial) as Promise<ProjectFile | null>,
  onProjectOpenRequest: (listener) => {
    const handler = (_event: unknown, file: ProjectFile) => listener(file);
    ipcRenderer.on(IPC.projectOpenRequest, handler);
    return () => {
      ipcRenderer.removeListener(IPC.projectOpenRequest, handler);
    };
  },
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
  pickAudioFiles: () => ipcRenderer.invoke(IPC.audioPickMany) as ReturnType<PulseforgeApi['pickAudioFiles']>,
  prepareAudio: (path, picture) => ipcRenderer.invoke(IPC.audioPrepare, path, picture) as ReturnType<PulseforgeApi['prepareAudio']>,
  combineAudio: (paths) => ipcRenderer.invoke(IPC.audioCombine, paths) as ReturnType<PulseforgeApi['combineAudio']>,
  pickMidi: () => ipcRenderer.invoke(IPC.midiPick) as ReturnType<PulseforgeApi['pickMidi']>,
  readAudio: (path) => ipcRenderer.invoke(IPC.audioRead, path) as ReturnType<PulseforgeApi['readAudio']>,
  readStemAudio: (path, stem, stemModel) => ipcRenderer.invoke(IPC.stemAudio, path, stem, stemModel) as ReturnType<PulseforgeApi['readStemAudio']>,
  refineBeats: (path, stemModel) => ipcRenderer.invoke(IPC.beatsRefine, path, stemModel) as ReturnType<PulseforgeApi['refineBeats']>,
  cancelRefineBeats: () => ipcRenderer.invoke(IPC.beatsCancel) as ReturnType<PulseforgeApi['cancelRefineBeats']>,
  analyzeAudio: (path, settings) => ipcRenderer.invoke(IPC.audioAnalyze, path, settings) as ReturnType<PulseforgeApi['analyzeAudio']>,
  separateStems: (path, settings) => ipcRenderer.invoke(IPC.stemsSeparate, path, settings) as ReturnType<PulseforgeApi['separateStems']>,
  cancelStems: () => ipcRenderer.invoke(IPC.stemsCancel) as Promise<void>,
  writeRecovery: (snapshot) => ipcRenderer.invoke(IPC.recoveryWrite, snapshot) as Promise<void>,
  clearRecovery: () => ipcRenderer.invoke(IPC.recoveryClear) as Promise<void>,
  listRecovery: () => ipcRenderer.invoke(IPC.recoveryList) as ReturnType<PulseforgeApi['listRecovery']>,
  discardRecovery: (sessionId) => ipcRenderer.invoke(IPC.recoveryDiscard, sessionId) as Promise<void>,
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet) as ReturnType<PulseforgeApi['getSettings']>,
  updateSettings: (patch) => ipcRenderer.invoke(IPC.settingsUpdate, patch) as ReturnType<PulseforgeApi['updateSettings']>,
  settingsInfo: () => ipcRenderer.invoke(IPC.settingsInfo) as ReturnType<PulseforgeApi['settingsInfo']>,
  checkForUpdate: () => ipcRenderer.invoke(IPC.updateCheck) as ReturnType<PulseforgeApi['checkForUpdate']>,
  installUpdate: () => ipcRenderer.invoke(IPC.updateInstall) as Promise<void>,
  onUpdateProgress: (listener) => {
    const handler = (_event: unknown, progress: { received: number; total: number }) => listener(progress);
    ipcRenderer.on(IPC.updateProgress, handler);
    return () => {
      ipcRenderer.removeListener(IPC.updateProgress, handler);
    };
  },
  cacheInventory: () => ipcRenderer.invoke(IPC.cacheInventory) as ReturnType<PulseforgeApi['cacheInventory']>,
  cacheAction: (action) => ipcRenderer.invoke(IPC.cacheAction, action) as ReturnType<PulseforgeApi['cacheAction']>,
  revealCache: () => ipcRenderer.invoke(IPC.revealCache) as Promise<void>,
  onCacheNotice(listener) {
    const handler = (_event: unknown, text: string) => listener(text);
    ipcRenderer.on(IPC.cacheNotice, handler);
    return () => {
      ipcRenderer.removeListener(IPC.cacheNotice, handler);
    };
  },
  pickFolder: (title) => ipcRenderer.invoke(IPC.pickFolder, title) as Promise<string | null>,
  logInfo: () => ipcRenderer.invoke(IPC.logInfo) as ReturnType<PulseforgeApi['logInfo']>,
  revealLogs: () => ipcRenderer.invoke(IPC.revealLogs) as Promise<void>,
  copyDiagnostics: (options) => ipcRenderer.invoke(IPC.copyDiagnostics, options ?? {}) as ReturnType<PulseforgeApi['copyDiagnostics']>,
  revealPath: (which) => ipcRenderer.invoke(IPC.revealPath, which) as Promise<void>,
  milkdropIndex: () => ipcRenderer.invoke(IPC.milkdropIndex) as ReturnType<PulseforgeApi['milkdropIndex']>,
  componentsInfo: () => ipcRenderer.invoke(IPC.componentsInfo) as ReturnType<PulseforgeApi['componentsInfo']>,
  removeComponent: (id) => ipcRenderer.invoke(IPC.componentRemove, id) as ReturnType<PulseforgeApi['removeComponent']>,
  moveDataFolder: () => ipcRenderer.invoke(IPC.dataFolderMove) as ReturnType<PulseforgeApi['moveDataFolder']>,
  runSetup: (request) => ipcRenderer.invoke(IPC.setupRun, request) as ReturnType<PulseforgeApi['runSetup']>,
  cancelSetup: () => ipcRenderer.invoke(IPC.setupCancel) as Promise<void>,
  onSetupOutput(listener) {
    const handler = (_event: unknown, line: string) => listener(line);
    ipcRenderer.on(IPC.setupOutput, handler);
    return () => {
      ipcRenderer.removeListener(IPC.setupOutput, handler);
    };
  },
  openLyricsFile: () => ipcRenderer.invoke(IPC.lyricsOpen) as ReturnType<PulseforgeApi['openLyricsFile']>,
  saveLyricsFile: (suggestedName, text) => ipcRenderer.invoke(IPC.lyricsSave, suggestedName, text) as ReturnType<PulseforgeApi['saveLyricsFile']>,
  lyricsAlignAvailable: () => ipcRenderer.invoke(IPC.lyricsAlignAvailable) as ReturnType<PulseforgeApi['lyricsAlignAvailable']>,
  alignLyrics: (request) => ipcRenderer.invoke(IPC.lyricsAlign, request) as ReturnType<PulseforgeApi['alignLyrics']>,
  cancelLyricsAlign: () => ipcRenderer.invoke(IPC.lyricsAlignCancel) as Promise<void>,
  onLyricsAlignProgress(listener) {
    const handler = (_event: unknown, progress: Parameters<typeof listener>[0]) => listener(progress);
    ipcRenderer.on(IPC.lyricsAlignProgress, handler);
    return () => {
      ipcRenderer.removeListener(IPC.lyricsAlignProgress, handler);
    };
  },
  onStemsProgress(listener) {
    const handler = (_event: unknown, progress: Parameters<typeof listener>[0]) => listener(progress);
    ipcRenderer.on(IPC.stemsProgress, handler);
    return () => {
      ipcRenderer.removeListener(IPC.stemsProgress, handler);
    };
  },
  listModules: () => ipcRenderer.invoke(IPC.modulesList) as ReturnType<PulseforgeApi['listModules']>,
  revealModules: () => ipcRenderer.invoke(IPC.modulesReveal) as Promise<void>,
  addShadertoy: (request) => ipcRenderer.invoke(IPC.modulesAddShadertoy, request) as ReturnType<PulseforgeApi['addShadertoy']>,
  listPresets: () => ipcRenderer.invoke(IPC.presetsList) as ReturnType<PulseforgeApi['listPresets']>,
  savePreset: (preset) => ipcRenderer.invoke(IPC.presetsSave, preset) as ReturnType<PulseforgeApi['savePreset']>,
  deletePreset: (scope, slug) => ipcRenderer.invoke(IPC.presetsDelete, scope, slug) as ReturnType<PulseforgeApi['deletePreset']>,
  setPresetFavourite: (scope, slug, on) => ipcRenderer.invoke(IPC.presetsFavourite, scope, slug, on) as ReturnType<PulseforgeApi['setPresetFavourite']>,
  presetThumbnail: (key) => ipcRenderer.invoke(IPC.presetsThumbnail, key) as ReturnType<PulseforgeApi['presetThumbnail']>,
  storePresetThumbnail: (key, png) => ipcRenderer.invoke(IPC.presetsStoreThumbnail, key, png) as Promise<void>,
  revealPresets: () => ipcRenderer.invoke(IPC.presetsReveal) as Promise<void>,
  listTemplates: () => ipcRenderer.invoke(IPC.templatesList) as ReturnType<PulseforgeApi['listTemplates']>,
  revealTemplates: () => ipcRenderer.invoke(IPC.templatesReveal) as Promise<void>,
  saveTemplate: (stem, text) => ipcRenderer.invoke(IPC.templatesSave, stem, text) as Promise<string>,
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
  importLut: () => ipcRenderer.invoke(IPC.lutImport) as ReturnType<PulseforgeApi['importLut']>,
  loadLut: (path, projectPath) => ipcRenderer.invoke(IPC.lutLoad, path, projectPath) as ReturnType<PulseforgeApi['loadLut']>,
  defaultFont: () => ipcRenderer.invoke(IPC.fontDefault) as ReturnType<PulseforgeApi['defaultFont']>,
  fallbackFonts: () => ipcRenderer.invoke(IPC.fontFallbacks) as ReturnType<PulseforgeApi['fallbackFonts']>,
  colorEmojiFont: () => ipcRenderer.invoke(IPC.fontColorEmoji) as ReturnType<PulseforgeApi['colorEmojiFont']>,
  importImage: () => ipcRenderer.invoke(IPC.imageImport) as ReturnType<PulseforgeApi['importImage']>,
  loadCoverArt: (audioPath) => ipcRenderer.invoke(IPC.imageCoverArt, audioPath) as ReturnType<PulseforgeApi['loadCoverArt']>,
  loadImage: (path, projectPath) => ipcRenderer.invoke(IPC.imageLoad, path, projectPath) as ReturnType<PulseforgeApi['loadImage']>,
  environment: () => ipcRenderer.invoke(IPC.environment) as ReturnType<PulseforgeApi['environment']>,
  pickRenderOutput: (suggestedName) => ipcRenderer.invoke(IPC.renderPickOutput, suggestedName) as Promise<string | null>,
  renderReadiness: (outputPath) => ipcRenderer.invoke(IPC.renderReadiness, outputPath) as ReturnType<PulseforgeApi['renderReadiness']>,
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
  pickBatchTracks: () => ipcRenderer.invoke(IPC.batchPickTracks) as ReturnType<PulseforgeApi['pickBatchTracks']>,
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  startBatch: (request) => ipcRenderer.invoke(IPC.batchStart, request) as ReturnType<PulseforgeApi['startBatch']>,
  cancelBatch: () => ipcRenderer.invoke(IPC.batchCancel) as Promise<void>,
  batchStatus: () => ipcRenderer.invoke(IPC.batchStatus) as ReturnType<PulseforgeApi['batchStatus']>,
  onBatchChanged(listener) {
    const handler = (_event: unknown, status: Parameters<typeof listener>[0]) => listener(status);
    ipcRenderer.on(IPC.batchChanged, handler);
    return () => {
      ipcRenderer.removeListener(IPC.batchChanged, handler);
    };
  },
  setShutdownWhenDone: (on) => ipcRenderer.invoke(IPC.queueSetShutdown, on) as Promise<boolean>,
  cancelShutdown: () => ipcRenderer.invoke(IPC.queueCancelShutdown) as Promise<void>,
  onQueueFinished(listener) {
    const handler = (_event: unknown, finished: Parameters<typeof listener>[0]) => listener(finished);
    ipcRenderer.on(IPC.queueFinished, handler);
    return () => {
      ipcRenderer.removeListener(IPC.queueFinished, handler);
    };
  },
};

contextBridge.exposeInMainWorld('pulseforge', api);
