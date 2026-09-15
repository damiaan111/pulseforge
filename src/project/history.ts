// Undo/redo (M8, ui-spec §10).
//
// Every project mutation goes through here. A creative tool where some actions cannot be undone
// teaches you to be timid, and timid is the opposite of what this is for.
//
// **The document is immutable, so history is a list of documents, not a list of inverse
// operations.** Undo restores a previous reference; there is no `revert` to write and therefore
// no way for apply and revert to disagree — which is the bug every apply/revert design
// eventually has, and which shows up as a project that is subtly wrong after a few undos.
// The cost is bounded: commands rebuild only the path they touch and share the rest, so an
// entry is a handful of small objects, not a copy of the project.
//
// Two things deliberately stay out:
//  - **Selection and panel state.** Undoing a selection change is maddening, so the command
//    stack never sees them; they live in UI state alongside it.
//  - **The clock.** `modifiedAt` is stamped here from an injectable `now`, so commands remain
//    pure functions of the document and tests produce byte-stable output.

import type { ProjectDocument } from './document.ts';

/** A single undoable mutation. `apply` must be pure: same document in, same document out. */
export interface Command {
  /** Shown in the history list, so it reads as a sentence: "Set bar count", "Delete layer". */
  readonly label: string;
  readonly apply: (document: ProjectDocument) => ProjectDocument;
  /**
   * Consecutive commands sharing a merge key collapse into one entry — a slider drag is one
   * undo step, not two hundred. The key identifies *what* is being edited
   * (`param:<layerId>:<key>`), so dragging two different sliders never merges.
   */
  readonly mergeKey?: string;
}

export interface HistoryEntry {
  readonly label: string;
  /** Position in the history list; 0 is the state the project opened in. */
  readonly index: number;
  readonly current: boolean;
}

export interface HistoryOptions {
  /** How many undo steps to keep. Oldest are dropped first. */
  readonly limit?: number;
  /** ISO 8601 timestamps for `modifiedAt`. Injectable so tests are deterministic. */
  readonly now?: () => string;
}

const DEFAULT_LIMIT = 200;

export class History {
  private readonly limit: number;
  private readonly now: () => string;
  /** Index 0 is the opened state; every later entry is the result of one command. */
  private states: ProjectDocument[];
  private labels: string[];
  private mergeKeys: (string | undefined)[];
  private position: number;
  private savedAt: number;
  /** Set by `seal()`; stops the next command merging into the previous one. */
  private sealed: boolean;

  constructor(initial: ProjectDocument, options: HistoryOptions = {}) {
    this.limit = Math.max(1, options.limit ?? DEFAULT_LIMIT);
    this.now = options.now ?? (() => new Date().toISOString());
    this.states = [initial];
    this.labels = ['Opened'];
    this.mergeKeys = [undefined];
    this.position = 0;
    this.savedAt = 0;
    this.sealed = true;
  }

  get current(): ProjectDocument {
    return this.states[this.position] as ProjectDocument;
  }

  get canUndo(): boolean {
    return this.position > 0;
  }

  get canRedo(): boolean {
    return this.position < this.states.length - 1;
  }

  /** True when the current state differs from the one last marked saved. */
  get dirty(): boolean {
    return this.position !== this.savedAt;
  }

  /** The label of the change that undo would reverse, for "Undo Set bar count". */
  get undoLabel(): string | undefined {
    return this.canUndo ? this.labels[this.position] : undefined;
  }

  get redoLabel(): string | undefined {
    return this.canRedo ? this.labels[this.position + 1] : undefined;
  }

  /** The whole list, so the UI can offer "undo 12 steps" instead of Ctrl+Z and hope. */
  get entries(): readonly HistoryEntry[] {
    return this.labels.map((label, index) => ({ label, index, current: index === this.position }));
  }

  /**
   * Ends a run of mergeable edits — call it on pointer-up, on blur, or before an unrelated
   * action. Without it a slider drag and the next edit of the same parameter would collapse
   * together, and the user would undo more than they did.
   */
  seal(): void {
    this.sealed = true;
  }

  run(command: Command): ProjectDocument {
    const applied = command.apply(this.current);
    // A command that changed nothing — re-importing an asset the project already has — is not a
    // step: an undo entry that undoes nothing, and a project marked unsaved with nothing to save.
    if (applied === this.current) return this.current;
    const next = this.stamp(applied);

    const canMerge = !this.sealed
      && command.mergeKey !== undefined
      && this.mergeKeys[this.position] === command.mergeKey
      && this.position > 0;

    if (canMerge) {
      // Replace the entry in place: the drag is still one step, now with a newer value.
      this.states[this.position] = next;
      this.labels[this.position] = command.label;
      return next;
    }

    // A new branch discards the redo tail — the redone future no longer follows from here. If the
    // saved state was in that tail it is gone: without this, the new branch's entry at the same
    // index would read as "saved" while holding different content.
    if (this.savedAt > this.position) this.savedAt = -1;
    this.states.length = this.position + 1;
    this.labels.length = this.position + 1;
    this.mergeKeys.length = this.position + 1;

    this.states.push(next);
    this.labels.push(command.label);
    this.mergeKeys.push(command.mergeKey);
    this.position += 1;
    this.sealed = command.mergeKey === undefined;
    this.trim();
    return next;
  }

  undo(): ProjectDocument | undefined {
    if (!this.canUndo) return undefined;
    this.position -= 1;
    this.sealed = true;
    return this.current;
  }

  redo(): ProjectDocument | undefined {
    if (!this.canRedo) return undefined;
    this.position += 1;
    this.sealed = true;
    return this.current;
  }

  /** Jumps to any point in the list. Out-of-range indices are clamped, never thrown. */
  jumpTo(index: number): ProjectDocument {
    this.position = Math.min(this.states.length - 1, Math.max(0, Math.round(index)));
    this.sealed = true;
    return this.current;
  }

  /** Called after a successful save, so `dirty` reflects the file on disk. */
  markSaved(): void {
    this.savedAt = this.position;
    // Otherwise the next keystroke of a merging edit replaces the saved entry in place, and the
    // project reads as saved while the file on disk is behind.
    this.sealed = true;
  }

  /** Replaces the whole history — opening a different project, or accepting a recovery file. */
  reset(document: ProjectDocument, label = 'Opened'): void {
    this.states = [document];
    this.labels = [label];
    this.mergeKeys = [undefined];
    this.position = 0;
    this.savedAt = 0;
    this.sealed = true;
  }

  private stamp(document: ProjectDocument): ProjectDocument {
    return { ...document, modifiedAt: this.now() };
  }

  private trim(): void {
    // limit counts undoable steps, so the array holds limit + 1 states (including "Opened").
    const excess = this.states.length - (this.limit + 1);
    if (excess <= 0) return;
    this.states.splice(0, excess);
    this.labels.splice(0, excess);
    this.mergeKeys.splice(0, excess);
    this.position -= excess;
    // The saved point may have fallen off the end; then nothing in history matches the file,
    // and the project must read as dirty rather than as saved.
    this.savedAt = this.savedAt >= excess ? this.savedAt - excess : -1;
  }
}
