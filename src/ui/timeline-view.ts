// The timeline's visible range (ui-spec §3: zoom, pan, playhead-anchored zoom, fit). UI state only,
// never undoable. Pure, so the arithmetic that decides what is on screen is tested.

export interface TimelineView {
  /** Seconds at the left edge. */
  readonly start: number;
  /** Seconds across the width. */
  readonly span: number;
}

/** The closest zoom: a second across the timeline — enough to place a word by eye. */
export const MIN_SPAN_SECONDS = 1;

export function fitView(duration: number): TimelineView {
  return { start: 0, span: Math.max(MIN_SPAN_SECONDS, duration) };
}

export function clampView(view: TimelineView, duration: number): TimelineView {
  const total = Math.max(MIN_SPAN_SECONDS, duration);
  const span = Math.min(total, Math.max(MIN_SPAN_SECONDS, view.span));
  const start = Math.min(total - span, Math.max(0, view.start));
  return { start, span };
}

/** Zooms by `factor` (< 1 zooms in) keeping `anchorSeconds` under the pointer. */
export function zoomAt(view: TimelineView, anchorSeconds: number, factor: number, duration: number): TimelineView {
  const span = view.span * factor;
  const fraction = view.span > 0 ? (anchorSeconds - view.start) / view.span : 0;
  return clampView({ start: anchorSeconds - fraction * span, span }, duration);
}

export function panBy(view: TimelineView, deltaSeconds: number, duration: number): TimelineView {
  return clampView({ start: view.start + deltaSeconds, span: view.span }, duration);
}

/** Pages the view so a playhead that has run off the right (or left) edge is back in sight. */
export function follow(view: TimelineView, t: number, duration: number): TimelineView {
  if (t >= view.start && t <= view.start + view.span) return view;
  return clampView({ start: t - view.span * 0.1, span: view.span }, duration);
}
