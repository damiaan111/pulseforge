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
import type { EditTarget } from '../project/commands.ts';
import { createDocument } from '../project/create.ts';
import type { ProjectDocument } from '../project/document.ts';
import { History, type Command } from '../project/history.ts';
import { loadDocument } from '../project/load.ts';
import { ProjectFormatError, ProjectVersionError, type DocumentIssue } from '../project/parse.ts';
import { stringifyDocument } from '../project/serialize.ts';
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

  run(command, options) {
    try {
      history.run(command);
      if (options?.seal !== false) history.seal();
      set((state) => ({ ...fromHistory(), version: state.version + 1 }));
    } catch (error) {
      // A command that cannot apply is a bug in the caller, but the user still needs a sentence
      // rather than a silently ignored click.
      set({ toast: { text: error instanceof Error ? error.message : String(error), kind: 'bad' } });
    }
  },

  undo() {
    history.undo();
    set((state) => ({ ...fromHistory(), version: state.version + 1 }));
  },

  redo() {
    history.redo();
    set((state) => ({ ...fromHistory(), version: state.version + 1 }));
  },

  jumpTo(index) {
    history.jumpTo(index);
    set((state) => ({ ...fromHistory(), version: state.version + 1 }));
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
    history.reset(createDocument({ name: 'Untitled' }), 'New project');
    set((state) => ({
      ...fromHistory(),
      version: state.version + 1,
      path: null,
      issues: [],
      migratedFrom: null,
      selectedLayerId: null,
      toast: null,
    }));
  },

  adopt(file) {
    const loaded = loadDocument(file.text);
    // Opening replaces the history: the previous project's undo steps do not apply here.
    history.reset(loaded.document, 'Opened');
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
    const audioPath = loaded.document.audio.path;
    if (audioPath !== '') void get().loadAudio(audioPath);
  },

  async openProject() {
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
        text: stringifyDocument(history.current),
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
      const result = await window.pulseforge.saveProjectAs(
        stringifyDocument(history.current),
        `${clean === '' ? 'untitled' : clean}.pvproj`,
      );
      if (result === null) return;
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
    const previous = get().audio;
    set({ analysisState: 'working', analysisMessage: 'Reading audio...' });
    try {
      const file = await window.pulseforge.readAudio(path);
      // A Blob URL, not file://: the page's CSP allows blob: media, and the sandboxed renderer
      // has no filesystem of its own to point an element at.
      const url = URL.createObjectURL(new Blob([file.bytes as unknown as BlobPart]));
      if (previous !== null) URL.revokeObjectURL(previous.url);

      set({ analysisMessage: 'Analysing...' });
      const payload = await window.pulseforge.analyzeAudio(path);
      const { analysis } = decodeAnalysis(payload.container);
      set({
        audio: { path, url, durationSeconds: payload.durationSeconds },
        analysis,
        peaks: decodePeaks(payload.peaks),
        sections: payload.sections,
        analysisState: 'ready',
        analysisMessage: payload.fromCache ? 'Analysis: cache hit' : 'Analysed and cached',
      });
    } catch (error) {
      const text = describeError(error, 'Loading the audio');
      set({ analysisState: 'error', analysisMessage: text, toast: { text, kind: 'bad' } });
    }
  },

  reportPreview(transport, timelineSeconds, stats) {
    set({ transport, timelineSeconds, stats });
  },
}));
