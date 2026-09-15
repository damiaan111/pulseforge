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
import { IPC, type ProjectFile, type PulseforgeApi, type SaveRequest, type SaveResult } from './ipc.ts';

const api: PulseforgeApi = {
  initialProject: () => ipcRenderer.invoke(IPC.projectInitial) as Promise<ProjectFile | null>,
  openProject: () => ipcRenderer.invoke(IPC.projectOpen) as Promise<ProjectFile | null>,
  readProject: (path) => ipcRenderer.invoke(IPC.projectRead, path) as Promise<ProjectFile>,
  saveProject: (request: SaveRequest) => ipcRenderer.invoke(IPC.projectSave, request) as Promise<SaveResult>,
  saveProjectAs: (text, suggestedName) =>
    ipcRenderer.invoke(IPC.projectSaveAs, text, suggestedName) as Promise<SaveResult | null>,
  pickAudio: () => ipcRenderer.invoke(IPC.audioPick) as ReturnType<PulseforgeApi['pickAudio']>,
  readAudio: (path) => ipcRenderer.invoke(IPC.audioRead, path) as ReturnType<PulseforgeApi['readAudio']>,
  analyzeAudio: (path) => ipcRenderer.invoke(IPC.audioAnalyze, path) as ReturnType<PulseforgeApi['analyzeAudio']>,
  environment: () => ipcRenderer.invoke(IPC.environment) as ReturnType<PulseforgeApi['environment']>,
};

contextBridge.exposeInMainWorld('pulseforge', api);
