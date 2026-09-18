// Studio state (ui-spec §10, §13).
//
// Two rules shape this file:
//
//  1. **Every project mutation goes through the command stack.** The `History` instance is the
//     source of truth for the document; the store mirrors it so React can render, and bumps
//     `version` so components re-render. There is no path that edits the document directly —
//     if there were, undo would develop holes.
//  2. **Selection and panel state never enter history.** Undoing a selection change is
//     maddening (ui-spec §10), so they live here and only here.
//
// The preview loop and the WebGL context are deliberately *not* in this store. Re-rendering a
// React tree per frame is the standard way these tools become sluggish (ui-spec §13), so the
// host owns its own rAF loop and pushes a throttled summary in.

import { create } from 'zustand';

import { decodeAnalysis } from '../analysis/container.ts';
import { decodePeaks, type PeakPyramid } from '../analysis/peaks.ts';
import type { AnalysisSet } from '../engine/core/analysis.ts';
import { withAbsolutePaths, withStoredPaths } from '../project/asset-paths.ts';
import {
  addAsset, addLayer, findAssetByHash, relinkAsset, sequence, type EditTarget,
} from '../project/commands.ts';
import { createDocument, createModuleLayer } from '../project/create.ts';
import { timelineDurationTicks, toRenderProject } from '../project/snapshot.ts';
import { frameCount } from '../engine/core/time.ts';
import { videoFramesNeeded } from '../engine/modules/video.ts';
import type { AssetRef, ProjectDocument } from '../project/document.ts';
import type { DecodedImage } from '../engine/core/image.ts';
import { newId } from '../project/ids.ts';
import { History, type Command } from '../project/history.ts';
import { loadDocument } from '../project/load.ts';
import { ProjectFormatError, ProjectVersionError, type DocumentIssue } from '../project/parse.ts';
import { stringifyDocument } from '../project/serialize.ts';
import type { ImageBytes, LibraryListing, PresetLibraryListing, RenderJob } from '../shell/ipc.ts';
import type { ShaderModuleSource } from '../engine/modules/shader-module.ts';
import type { ModuleFolderProblem } from '../modules-folder/scan.ts';
import type { PreviewStats, Transport } from './clock.ts';

/** The one history for the open project. Module-level: there is exactly one document. */
export const history = new History(createDocument({ name: 'Untitled' }));

export interface Section {
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly label: string;
}

export interface AudioState {
  readonly path: string;
  /** Blob URL for the audio element. Revoked when replaced. */
  readonly url: string;
  readonly durationSeconds: number;
}

export type AnalysisState = 'idle' | 'working' | 'ready' | 'error';

export interface Toast {
  readonly text: string;
  readonly kind: 'ok' | 'warn' | 'bad';
}

export interface StudioState {
  /** Bumped on every document mutation; components read it to know they must re-render. */
  version: number;
  document: ProjectDocument;
  path: string | null;
  issues: readonly DocumentIssue[];
  migratedFrom: number | null;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | undefined;
  redoLabel: string | undefined;

  // UI-only, never undoable.
  selectedLayerId: string | null;
  /** Which aspect edits are written to (D44). 'base' edits the layer itself. */
  editTarget: EditTarget;
  /** Render scale for the preview, 0.25-1. Lower is grainier, never different (ui-spec §0.4). */
  previewScale: number;
  toast: Toast | null;

  audio: AudioState | null;
  analysis: AnalysisSet | null;
  peaks: PeakPyramid | null;
  sections: readonly Section[];
  analysisState: AnalysisState;
  analysisMessage: string | null;

  // Mirrored from the preview host, throttled.
  transport: Transport;
  timelineSeconds: number;
  stats: PreviewStats | null;

  /**
   * Decoded image assets by content hash, for the preview. Not in the document: the document
   * records which file, this holds the pixels, and the pixels are never undoable state.
   */
  images: ReadonlyMap<string, DecodedImage>;
  /** Per asset id: loaded, missing, changed on disk, or unreadable — shown, never silent (M40). */
  assetStatus: Readonly<Record<string, AssetStatus>>;
  /** Font file bytes by content hash, for the preview's text rasteriser. */
  fonts: ReadonlyMap<string, Uint8Array>;
  /** The bundled default typeface; null until loaded at startup. */
  defaultFont: { readonly hash: string; readonly bytes: Uint8Array } | null;
  loadDefaultFont(): Promise<void>;
  /** Loads every image and font the document references that is not loaded yet. `recheck` retries failed ones. */
  loadAssets(recheck?: boolean): Promise<void>;
  /** Picks and decodes an image, keeping its pixels; the caller records the asset in the document. */
  importImage(): Promise<AssetRef | null>;
  /** Picks a font file, keeping its bytes; the caller records the asset in the document. */
  importFont(): Promise<AssetRef | null>;
  /** Picks a video; the caller records the asset, and its preview proxy extracts in the background. */
  importVideo(): Promise<AssetRef | null>;
  /**
   * Prepared preview proxies by clip hash (M39). `capped` means extraction stopped at what the
   * timeline needed, so a longer timeline must extract again; `fps` is what it was extracted at.
   */
  videos: ReadonlyMap<string, VideoProxy>;
  /** Progress from the main process while a clip extracts. */
  reportVideoProgress(hash: string, frames: number): void;
  /** Picks a replacement file for one asset and relinks it (asks first if the content differs). */
  relink(assetId: string): Promise<void>;
  /** Asks for a folder and relinks every missing asset found in it, by content. */
  findMissing(): Promise<void>;
  /** "Collect files": the project and its media copied into one folder. */
  collectFiles(): Promise<void>;

  /** Drop-in modules from modules/ (M35), and the folders that could not load, with why. */
  userModules: readonly ShaderModuleSource[];
  moduleProblems: readonly ModuleFolderProblem[];
  modulesFolder: string | null;
  loadModules(): Promise<void>;

  /** The preset library (S8): built-ins and the user's own, favourites marked; null until listed. */
  presets: PresetLibraryListing | null;
  /** The Save preset dialog, open for a scope, or closed. */
  presetDialog: 'layer' | 'project' | null;
  loadPresets(): Promise<void>;
  setPresets(listing: PresetLibraryListing): void;
  setPresetDialog(scope: 'layer' | 'project' | null): void;
  deletePreset(scope: 'layer' | 'project', slug: string): Promise<void>;
  setPresetFavourite(scope: 'layer' | 'project', slug: string, on: boolean): Promise<void>;

  /** The managed library folder (M40, D6); null until first listed. */
  library: LibraryListing | null;
  loadLibrary(): Promise<void>;
  addToLibrary(category: string): Promise<void>;
  /** A library image as a new background layer at the bottom of the stack. */
  useLibraryImage(path: string): Promise<void>;

  /** The render queue, pushed from the main process (M24). */
  renders: readonly RenderJob[];
  exportOpen: boolean;
  queueOpen: boolean;
  setRenders(jobs: readonly RenderJob[]): void;
  setExportOpen(open: boolean): void;
  setQueueOpen(open: boolean): void;

  run(command: Command, options?: { seal?: boolean }): void;
  undo(): void;
  redo(): void;
  jumpTo(index: number): void;
  select(layerId: string | null): void;
  setEditTarget(target: EditTarget): void;
  setPreviewScale(scale: number): void;
  notify(toast: Toast | null): void;
  newProject(): void;
  adopt(file: { path: string; text: string }): void;
  openProject(): Promise<void>;
  save(): Promise<void>;
  saveAs(): Promise<void>;
  loadAudio(path: string): Promise<void>;
  reportPreview(transport: Transport, timelineSeconds: number, stats: PreviewStats): void;
}

/** Everything derived from the history, recomputed after any command. */
function fromHistory() {
  return {
    document: history.current,
    dirty: history.dirty,
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    undoLabel: history.undoLabel,
    redoLabel: history.redoLabel,
  };
}

/** Increments per `loadAudio` call; a response for an older call is dropped. */
let audioRequest = 0;

export interface AssetStatus {
  readonly state: 'loading' | 'ok' | 'missing' | 'changed' | 'error';
  readonly detail: string;
  /**
   * The path and hash this status was determined for. An undo, redo or relink changes an asset's
   * path or hash without touching its id; a status for other values is stale and is re-checked.
   */
  readonly path: string;
  readonly hash: string;
}

export interface VideoProxy {
  readonly frameCount: number;
  readonly fps: string;
  readonly capped: boolean;
}

const fpsKey = (fps: { num: number; den: number }) => `${fps.num}/${fps.den}`;

/** The preview proxy a clip needs for the document as it is now: its fps, and how many frames. */
function proxyNeeds(document: ProjectDocument, assetId: string): { fps: string; maxFrames: number } {
  const { project } = toRenderProject(document);
  const timeline = frameCount(timelineDurationTicks(document), document.canvas.fps);
  // With no audio yet the timeline is empty; a minute's worth keeps the preview useful meanwhile.
  const frames = Math.max(timeline, Math.round((60 * document.canvas.fps.num) / document.canvas.fps.den));
  return { fps: fpsKey(document.canvas.fps), maxFrames: videoFramesNeeded(project, assetId, frames) };
}

function imageOf(bytes: ImageBytes): DecodedImage {
  return { width: bytes.width, height: bytes.height, pixels: bytes.pixels };
}

/**
 * Asks before throwing away unsaved work. `window.confirm` is a real modal in Electron, and a
 * dialog of our own would be the same question with more code.
 */
function discardOk(action: string): boolean {
  return !history.dirty || window.confirm(`The project has unsaved changes. ${action} anyway and lose them?`);
}

/** Never a raw stack trace (ui-spec §11). */
function describeError(error: unknown, whileDoing: string): string {
  if (error instanceof ProjectVersionError) return error.message;
  if (error instanceof ProjectFormatError) return `That file is not a Pulseforge project. ${error.message}`;
  return `${whileDoing} failed. ${error instanceof Error ? error.message : String(error)}`;
}

export const useStudio = create<StudioState>((set, get) => ({
  version: 0,
  ...fromHistory(),
  path: null,
  issues: [],
  migratedFrom: null,

  selectedLayerId: null,
  editTarget: 'base',
  previewScale: 1,
  toast: null,

  audio: null,
  analysis: null,
  peaks: null,
  sections: [],
  analysisState: 'idle',
  analysisMessage: null,

  transport: 'stopped',
  timelineSeconds: 0,
  stats: null,

  images: new Map(),
  fonts: new Map(),
  defaultFont: null,
  assetStatus: {},

  async loadAssets(recheck = false) {
    const document = history.current;
    const projectPath = get().path;
    for (const asset of document.assets) {
      // Another project was opened meanwhile: stop, rather than attach this one's problems to it.
      if (history.current.id !== document.id) return;
      if (asset.kind !== 'image' && asset.kind !== 'font' && asset.kind !== 'video') continue;
      const setStatus = (state: AssetStatus['state'], detail: string) =>
        set({ assetStatus: { ...get().assetStatus, [asset.id]: { state, detail, path: asset.path, hash: asset.hash } } });
      const known = get().assetStatus[asset.id];
      const fresh = known !== undefined && known.path === asset.path && known.hash === asset.hash;
      const failed = known?.state === 'missing' || known?.state === 'error';
      // A video is also stale when the project's fps changed, or the timeline grew past a proxy
      // that was cut to the old length.
      const proxy = asset.kind === 'video' ? get().videos.get(asset.hash) : undefined;
      const needs = asset.kind === 'video' ? proxyNeeds(document, asset.id) : undefined;
      const videoStale = needs !== undefined && known?.state === 'ok'
        && (proxy === undefined || proxy.fps !== needs.fps || (proxy.capped && needs.maxFrames > proxy.frameCount));
      if (fresh && !(recheck && failed) && !videoStale) continue;
      setStatus('loading', asset.kind === 'video' ? 'Extracting preview frames…' : asset.path);

      if (asset.kind === 'video' && needs !== undefined) {
        try {
          const result = await window.pulseforge.prepareVideo({
            path: asset.path, projectPath, hash: asset.hash, fps: document.canvas.fps, maxFrames: needs.maxFrames,
          });
          if (history.current.id !== document.id) return;
          if (result.status === 'missing') {
            setStatus('missing', `Not found: ${result.path}`);
          } else if (result.status === 'error') {
            setStatus('error', result.message);
          } else {
            set({
              videos: new Map(get().videos).set(asset.hash, {
                frameCount: result.sequence.frameCount,
                fps: needs.fps,
                capped: result.sequence.frameCount >= needs.maxFrames,
              }),
            });
            setStatus('ok', `${result.sequence.frameCount} frames at ${needs.fps} fps`);
          }
        } catch (error) {
          setStatus('error', error instanceof Error ? error.message : String(error));
        }
        continue;
      }
      try {
        const result = asset.kind === 'image'
          ? await window.pulseforge.loadImage(asset.path, projectPath)
          : await window.pulseforge.loadFont(asset.path, projectPath);
        if (history.current.id !== document.id) return;
        if (result.status === 'missing') {
          setStatus('missing', `Not found: ${result.path}`);
          continue;
        }
        if (result.status === 'error') {
          setStatus('error', result.message);
          continue;
        }
        // Under the recorded hash, which is what the snapshot looks up; a changed file still draws.
        const loaded = 'image' in result ? result.image : result.font;
        if ('image' in result) {
          set({ images: new Map(get().images).set(asset.hash, imageOf(result.image)) });
        } else {
          set({ fonts: new Map(get().fonts).set(asset.hash, result.font.bytes) });
        }
        if (loaded.hash === asset.hash) setStatus('ok', loaded.path);
        else setStatus('changed', `"${asset.name}" has changed on disk since it was chosen, so it may look different. Relink to accept the new file.`);
      } catch (error) {
        setStatus('error', error instanceof Error ? error.message : String(error));
      }
    }
  },

  async importImage() {
    try {
      const image = await window.pulseforge.importImage();
      if (image === null) return null;
      const images = new Map(get().images);
      images.set(image.hash, imageOf(image));
      set({ images });
      const id = newId();
      set({ assetStatus: { ...get().assetStatus, [id]: { state: 'ok', detail: image.path, path: image.path, hash: image.hash } } });
      return { id, kind: 'image', path: image.path, hash: image.hash, size: image.size, name: image.name, extra: {} };
    } catch (error) {
      set({ toast: { text: describeError(error, 'Importing the image'), kind: 'bad' } });
      return null;
    }
  },

  async importFont() {
    try {
      const font = await window.pulseforge.importFont();
      if (font === null) return null;
      const id = newId();
      set({
        fonts: new Map(get().fonts).set(font.hash, font.bytes),
        assetStatus: { ...get().assetStatus, [id]: { state: 'ok', detail: font.path, path: font.path, hash: font.hash } },
      });
      return { id, kind: 'font', path: font.path, hash: font.hash, size: font.size, name: font.name, extra: {} };
    } catch (error) {
      set({ toast: { text: describeError(error, 'Choosing the font'), kind: 'bad' } });
      return null;
    }
  },

  videos: new Map(),

  reportVideoProgress(hash, frames) {
    const statuses = get().assetStatus;
    const updated: Record<string, AssetStatus> = { ...statuses };
    let changed = false;
    for (const [id, status] of Object.entries(statuses)) {
      if (status.hash !== hash || status.state !== 'loading') continue;
      updated[id] = { ...status, detail: `Extracting preview frames… ${frames}` };
      changed = true;
    }
    if (changed) set({ assetStatus: updated });
  },

  async importVideo() {
    try {
      const video = await window.pulseforge.importVideo();
      if (video === null) return null;
      // Extraction starts once the asset is in the document: loadAssets runs after the command.
      const asset: AssetRef = { id: newId(), kind: 'video', path: video.path, hash: video.hash, size: video.size, name: video.name, extra: {} };
      return asset;
    } catch (error) {
      set({ toast: { text: describeError(error, 'Importing the video'), kind: 'bad' } });
      return null;
    }
  },

  async loadDefaultFont() {
    if (get().defaultFont !== null) return;
    try {
      const font = await window.pulseforge.defaultFont();
      set({ defaultFont: { hash: font.hash, bytes: font.bytes } });
    } catch (error) {
      set({ toast: { text: describeError(error, 'Loading the default font'), kind: 'bad' } });
    }
  },

  async relink(assetId) {
    const asset = history.current.assets.find((a) => a.id === assetId);
    if (asset === undefined) return;
    try {
      const picked = asset.kind === 'font'
        ? await window.pulseforge.importFont()
        : asset.kind === 'video'
          ? await window.pulseforge.importVideo()
          : await window.pulseforge.importImage();
      if (picked === null) return;
      // A different file is allowed — a re-export is often the point — but never silently
      // (data-formats §1.2): the look of every layer using it changes.
      if (asset.hash !== '' && picked.hash !== asset.hash
        && !window.confirm(`"${picked.name}" is not the same file as "${asset.name}" (the content differs). Use it anyway?`)) {
        return;
      }
      if ('pixels' in picked) set({ images: new Map(get().images).set(picked.hash, imageOf(picked)) });
      else if ('bytes' in picked) set({ fonts: new Map(get().fonts).set(picked.hash, picked.bytes) });
      // A relinked video has no proxy yet: leave its status for loadAssets, which extracts it.
      if (!('durationSeconds' in picked)) {
        set({ assetStatus: { ...get().assetStatus, [assetId]: { state: 'ok', detail: picked.path, path: picked.path, hash: picked.hash } } });
      }
      get().run(relinkAsset(assetId, { path: picked.path, hash: picked.hash, size: picked.size, name: picked.name }));
    } catch (error) {
      set({ toast: { text: describeError(error, 'Relinking'), kind: 'bad' } });
    }
  },

  async findMissing() {
    const { assetStatus } = get();
    const wanted = history.current.assets
      .filter((a) => assetStatus[a.id]?.state === 'missing')
      .map((a) => ({ id: a.id, name: a.name, size: a.size, hash: a.hash }));
    if (wanted.length === 0) return;
    try {
      const result = await window.pulseforge.findAssetsInFolder(wanted);
      if (result === null) return;
      if (result.found.length > 0) {
        get().run(sequence(
          `Relink ${result.found.length} file${result.found.length === 1 ? '' : 's'}`,
          result.found.map((f) => relinkAsset(f.id, { path: f.path, hash: f.hash, size: f.size, name: f.name })),
        ));
        await get().loadAssets(true);
      }
      const still = wanted.length - result.found.length;
      set({
        toast: {
          text: `Found ${result.found.length} of ${wanted.length} missing file${wanted.length === 1 ? '' : 's'} in ${result.folder}.`
            + (still > 0 ? ` ${still} still missing — only files with identical content are relinked automatically; use Relink… for a changed file.` : '')
            + (result.truncated ? ` The search stopped after ${result.filesListed} files; pick a narrower folder to look further.` : ''),
          kind: still > 0 ? 'warn' : 'ok',
        },
      });
    } catch (error) {
      set({ toast: { text: describeError(error, 'Searching for files'), kind: 'bad' } });
    }
  },

  async collectFiles() {
    try {
      const result = await window.pulseforge.collectProject(stringifyDocument(history.current));
      if (result === null) return;
      const megabytes = (result.bytes / 1_048_576).toFixed(1);
      set({
        toast: {
          text: `Collected ${result.copied} file${result.copied === 1 ? '' : 's'} (${megabytes} MB) and the project into\n${result.projectPath}`
            + (result.problems.length > 0 ? `\n\nNot collected:\n${result.problems.map((p) => `• ${p}`).join('\n')}` : ''),
          kind: result.problems.length > 0 ? 'warn' : 'ok',
        },
      });
    } catch (error) {
      set({ toast: { text: describeError(error, 'Collecting files'), kind: 'bad' } });
    }
  },

  userModules: [],
  moduleProblems: [],
  modulesFolder: null,

  async loadModules() {
    try {
      const scan = await window.pulseforge.listModules();
      set({ userModules: scan.modules, moduleProblems: scan.problems, modulesFolder: scan.root });
    } catch (error) {
      set({ toast: { text: describeError(error, 'Reading the modules folder'), kind: 'bad' } });
    }
  },

  presets: null,
  presetDialog: null,

  async loadPresets() {
    try {
      set({ presets: await window.pulseforge.listPresets() });
    } catch (error) {
      set({ toast: { text: describeError(error, 'Reading the presets'), kind: 'bad' } });
    }
  },

  setPresets(listing) {
    set({ presets: listing });
  },

  setPresetDialog(scope) {
    set({ presetDialog: scope });
  },

  async deletePreset(scope, slug) {
    try {
      set({ presets: await window.pulseforge.deletePreset(scope, slug) });
    } catch (error) {
      set({ toast: { text: describeError(error, 'Deleting the preset'), kind: 'bad' } });
    }
  },

  async setPresetFavourite(scope, slug, on) {
    try {
      set({ presets: await window.pulseforge.setPresetFavourite(scope, slug, on) });
    } catch (error) {
      set({ toast: { text: describeError(error, 'Starring the preset'), kind: 'bad' } });
    }
  },

  library: null,

  async loadLibrary() {
    try {
      set({ library: await window.pulseforge.listLibrary() });
    } catch (error) {
      set({ toast: { text: describeError(error, 'Reading the library'), kind: 'bad' } });
    }
  },

  async addToLibrary(category) {
    try {
      set({ library: await window.pulseforge.addToLibrary(category) });
    } catch (error) {
      set({ toast: { text: describeError(error, 'Adding to the library'), kind: 'bad' } });
    }
  },

  async useLibraryImage(path) {
    try {
      const result = await window.pulseforge.loadImage(path, null);
      if (result.status !== 'ok') {
        set({ toast: { text: result.status === 'missing' ? `Not found: ${result.path}` : result.message, kind: 'bad' } });
        void get().loadLibrary();
        return;
      }
      const { image } = result;
      const images = new Map(get().images);
      images.set(image.hash, imageOf(image));
      const existing = findAssetByHash(history.current, image.hash);
      const asset: AssetRef = existing ?? { id: newId(), kind: 'image', path: image.path, hash: image.hash, size: image.size, name: image.name, extra: {} };
      set({ images, assetStatus: { ...get().assetStatus, [asset.id]: { state: 'ok', detail: image.path, path: image.path, hash: image.hash } } });
      const layer = createModuleLayer('core.source.background', {
        id: newId(),
        name: image.name.replace(/\.[^.]+$/, ''),
        params: { mode: 'image', image: asset.id, fit: 'cover' },
      });
      // Just above the topmost existing background, and so below every visualizer. At the very
      // bottom it landed behind an opaque background already there and could not be seen.
      const layers = history.current.layers;
      let index = 0;
      layers.forEach((l, i) => {
        if (l.kind === 'module' && l.module === 'core.source.background') index = i + 1;
      });
      get().run(sequence(`Add background ${image.name}`, [
        ...(existing === undefined ? [addAsset(asset)] : []),
        addLayer(layer, { index }),
      ]));
      set({ selectedLayerId: layer.id });
    } catch (error) {
      set({ toast: { text: describeError(error, 'Using the library image'), kind: 'bad' } });
    }
  },

  renders: [],
  exportOpen: false,
  queueOpen: false,
  setRenders(jobs) {
    set({ renders: jobs });
  },
  setExportOpen(open) {
    set({ exportOpen: open });
  },
  setQueueOpen(open) {
    set({ queueOpen: open });
  },

  run(command, options) {
    try {
      const before = history.current.assets;
      history.run(command);
      if (options?.seal !== false) history.seal();
      set((state) => ({ ...fromHistory(), version: state.version + 1 }));
      // Assets changed, or — for videos — the fps, the timeline or a clip's speed may have, any of
      // which can make a preview proxy stale. loadAssets returns at once when nothing is.
      if (history.current.assets !== before || history.current.assets.some((a) => a.kind === 'video')) void get().loadAssets();
    } catch (error) {
      // A command that cannot apply is a bug in the caller, but the user still needs a sentence
      // rather than a silently ignored click.
      set({ toast: { text: error instanceof Error ? error.message : String(error), kind: 'bad' } });
    }
  },

  undo() {
    history.undo();
    set((state) => ({ ...fromHistory(), version: state.version + 1 }));
    // An undone relink points an asset back at its old file; its status has to follow.
    void get().loadAssets();
  },

  redo() {
    history.redo();
    set((state) => ({ ...fromHistory(), version: state.version + 1 }));
    void get().loadAssets();
  },

  jumpTo(index) {
    history.jumpTo(index);
    set((state) => ({ ...fromHistory(), version: state.version + 1 }));
    void get().loadAssets();
  },

  select(layerId) {
    set({ selectedLayerId: layerId });
  },

  setEditTarget(target) {
    set({ editTarget: target });
  },

  setPreviewScale(scale) {
    set({ previewScale: Math.min(1, Math.max(0.25, scale)) });
  },

  notify(toast) {
    set({ toast });
  },

  newProject() {
    if (!discardOk('Start a new project')) return;
    history.reset(createDocument({ name: 'Untitled' }), 'New project');
    audioRequest += 1;
    const previous = get().audio;
    if (previous !== null) URL.revokeObjectURL(previous.url);
    set((state) => ({
      ...fromHistory(),
      version: state.version + 1,
      path: null,
      issues: [],
      migratedFrom: null,
      selectedLayerId: null,
      toast: null,
      images: new Map(),
      fonts: new Map(),
      videos: new Map(),
      assetStatus: {},
      // A new project has no audio; keeping the old track made "New" still react to the last song.
      audio: null,
      analysis: null,
      peaks: null,
      sections: [],
      analysisState: 'idle' as const,
      analysisMessage: null,
    }));
  },

  adopt(file) {
    const loaded = loadDocument(file.text);
    // The studio holds absolute paths and writes them relative again on save, against whichever
    // file it saves to (asset-paths.ts) — so "Save as" into another folder cannot break links.
    const document = withAbsolutePaths(loaded.document, file.path);
    // Opening replaces the history: the previous project's undo steps do not apply here.
    history.reset(document, 'Opened');
    set((state) => ({
      ...fromHistory(),
      version: state.version + 1,
      path: file.path,
      issues: loaded.issues,
      migratedFrom: loaded.migratedFrom,
      selectedLayerId: null,
      toast: loaded.migratedFrom === null
        ? { text: `Opened ${file.path}`, kind: 'ok' as const }
        : { text: `Migrated from schema v${loaded.migratedFrom}. The original is backed up on the first save.`, kind: 'warn' as const },
    }));
    const audioPath = document.audio.path;
    if (audioPath !== '') {
      void get().loadAudio(audioPath);
    } else {
      // The previous project's track must not stay loaded under a project that has none.
      audioRequest += 1;
      const previous = get().audio;
      if (previous !== null) URL.revokeObjectURL(previous.url);
      set({ audio: null, analysis: null, peaks: null, sections: [], analysisState: 'idle', analysisMessage: null });
    }
    set({ images: new Map(), fonts: new Map(), videos: new Map(), assetStatus: {} });
    void get().loadAssets();
  },

  async openProject() {
    if (!discardOk('Open another project')) return;
    try {
      const file = await window.pulseforge.openProject();
      if (file !== null) get().adopt(file);
    } catch (error) {
      set({ toast: { text: describeError(error, 'Opening the project'), kind: 'bad' } });
    }
  },

  async save() {
    const { path, migratedFrom } = get();
    if (path === null) {
      await get().saveAs();
      return;
    }
    try {
      const result = await window.pulseforge.saveProject({
        path,
        text: stringifyDocument(withStoredPaths(history.current, path)),
        ...(migratedFrom === null ? {} : { backupFromVersion: migratedFrom }),
      });
      history.markSaved();
      set((state) => ({
        ...fromHistory(),
        version: state.version + 1,
        migratedFrom: null,
        toast: {
          text: result.backupPath === undefined
            ? `Saved ${result.path}`
            : `Saved; the original is backed up at ${result.backupPath}`,
          kind: 'ok' as const,
        },
      }));
    } catch (error) {
      set({ toast: { text: describeError(error, 'Saving'), kind: 'bad' } });
    }
  },

  async saveAs() {
    try {
      const clean = history.current.name.replace(/[^\w\- ]+/g, '');
      const target = await window.pulseforge.pickProjectSavePath(`${clean === '' ? 'untitled' : clean}.pvproj`);
      if (target === null) return;
      // Serialised only now, against the chosen file: that decides which paths become relative.
      const result = await window.pulseforge.saveProject({ path: target, text: stringifyDocument(withStoredPaths(history.current, target)) });
      history.markSaved();
      set((state) => ({
        ...fromHistory(),
        version: state.version + 1,
        path: result.path,
        migratedFrom: null,
        toast: { text: `Saved ${result.path}`, kind: 'ok' as const },
      }));
    } catch (error) {
      set({ toast: { text: describeError(error, 'Saving'), kind: 'bad' } });
    }
  },

  async loadAudio(path) {
    // Only the latest request may land. Opening project B while A's track is still analysing
    // otherwise shows B with A's audio and analysis once A finishes.
    const request = ++audioRequest;
    set({ analysisState: 'working', analysisMessage: 'Reading audio...' });
    let url: string | undefined;
    try {
      const file = await window.pulseforge.readAudio(path);
      if (request !== audioRequest) return;
      // A Blob URL, not file://: the page's CSP allows blob: media, and the sandboxed renderer
      // has no filesystem of its own to point an element at.
      url = URL.createObjectURL(new Blob([file.bytes as unknown as BlobPart]));

      set({ analysisMessage: 'Analysing...' });
      const payload = await window.pulseforge.analyzeAudio(path);
      if (request !== audioRequest) {
        URL.revokeObjectURL(url);
        return;
      }
      const { analysis } = decodeAnalysis(payload.container);
      // Revoked only once the replacement is ready: revoking up front left a failed load with
      // the old track's element pointing at a dead URL.
      const previous = get().audio;
      if (previous !== null) URL.revokeObjectURL(previous.url);
      set({
        audio: { path, url, durationSeconds: payload.durationSeconds },
        analysis,
        peaks: decodePeaks(payload.peaks),
        sections: payload.sections,
        analysisState: 'ready',
        analysisMessage: payload.fromCache ? 'Analysis: cache hit' : 'Analysed and cached',
      });
    } catch (error) {
      if (url !== undefined) URL.revokeObjectURL(url);
      if (request !== audioRequest) return;
      const text = describeError(error, 'Loading the audio');
      set({ analysisState: 'error', analysisMessage: text, toast: { text, kind: 'bad' } });
    }
  },

  reportPreview(transport, timelineSeconds, stats) {
    set({ transport, timelineSeconds, stats });
  },
}));
