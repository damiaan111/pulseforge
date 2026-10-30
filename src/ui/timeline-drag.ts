// Dragging on the timeline: a layer's time range and the audio clip's edges (M9, M29). Pure, so the
// rules are tested without a canvas; the component turns pointers into ticks and runs the commands.

import type { TimeRange } from '../project/document.ts';

export type LayerDragKind = 'move' | 'in' | 'out';

/** Shortest a layer can be dragged to: an empty range hides it and says nothing. */
const MIN_LAYER_TICKS = 4800;
/** Shortest the audio can be trimmed to, as the Clip panel allows. */
const MIN_CLIP_TICKS = 480;

/** What a press on a layer's block grabs: an edge within `grabPx` of it, otherwise the block. */
export function layerDragKind(px: number, left: number, right: number, grabPx: number): LayerDragKind | null {
  if (px < left - grabPx || px > right + grabPx) return null;
  // A short block keeps a middle to hold it by.
  const grab = Math.min(grabPx, (right - left) / 3);
  if (px <= left + grab) return 'in';
  if (px >= right - grab) return 'out';
  return 'move';
}

/**
 * The range after a drag of `delta` ticks. "To the end" stays that way: moving such a layer moves its
 * start, and dragging an out point past the end of the timeline gives it back.
 */
export function dragLayerRange(start: Pick<TimeRange, 'inTicks' | 'outTicks'>, kind: LayerDragKind, delta: number, durationTicks: number): { inTicks: number; outTicks: number | null } {
  const out = start.outTicks ?? durationTicks;
  if (kind === 'in') {
    return { inTicks: Math.max(0, Math.min(start.inTicks + delta, out - MIN_LAYER_TICKS)), outTicks: start.outTicks };
  }
  if (kind === 'out') {
    const moved = Math.max(start.inTicks + MIN_LAYER_TICKS, out + delta);
    return { inTicks: start.inTicks, outTicks: moved >= durationTicks ? null : moved };
  }
  if (start.outTicks === null) {
    return { inTicks: Math.max(0, Math.min(start.inTicks + delta, durationTicks - MIN_LAYER_TICKS)), outTicks: null };
  }
  // A fixed length: stopped at zero rather than shortened.
  const shift = Math.max(-start.inTicks, delta);
  return { inTicks: start.inTicks + shift, outTicks: start.outTicks + shift };
}

export interface ClipPlacement {
  readonly leadInTicks: number;
  readonly clipInTicks: number;
  /** Null: to the end of the file. */
  readonly clipOutTicks: number | null;
  /** The audio file's length. */
  readonly durationTicks: number;
}

/**
 * The clip after trimming one edge by `delta` timeline ticks. The sound stays where it is on the
 * timeline, as a trim does in any editor: taking from the start moves the lead-in along with it, so
 * what is left is not slid back to meet the playhead's memory of it.
 */
export function trimClip(start: ClipPlacement, edge: 'in' | 'out', delta: number): Pick<ClipPlacement, 'leadInTicks' | 'clipInTicks'> & { clipOutTicks: number | null } {
  const out = start.clipOutTicks ?? start.durationTicks;
  if (edge === 'out') {
    const moved = Math.max(start.clipInTicks + MIN_CLIP_TICKS, Math.min(start.durationTicks, out + delta));
    return { leadInTicks: start.leadInTicks, clipInTicks: start.clipInTicks, clipOutTicks: moved >= start.durationTicks ? null : moved };
  }
  // Limited by the start of the file, the start of the timeline and the other edge.
  const applied = Math.max(-start.clipInTicks, -start.leadInTicks, Math.min(delta, out - MIN_CLIP_TICKS - start.clipInTicks));
  return { leadInTicks: start.leadInTicks + applied, clipInTicks: start.clipInTicks + applied, clipOutTicks: start.clipOutTicks };
}
