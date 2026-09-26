// Previous / next marker (S9, PROJECT.md §8 "transport: prev/next marker"): shared by the transport
// buttons and the [ and ] keys. With no markers yet, section boundaries are stops too, so the keys
// are useful from the first minute.

import { sourceToTimelineSeconds, TICKS_PER_SECOND, ticksToSeconds } from '../engine/core/time.ts';
import { markerTicks, neighbourStop } from '../project/markers.ts';
import { previewControls } from './components/CanvasPane.tsx';
import { useStudio } from './store.ts';

export function markerStops(): number[] {
  const state = useStudio.getState();
  const placement = state.document.audio;
  return [
    ...markerTicks(state.document),
    ...state.sections.flatMap((sec) => [sec.startSeconds, sec.endSeconds]).map((sec) => Math.round(sourceToTimelineSeconds(sec, placement) * TICKS_PER_SECOND)),
  ];
}

/** Moves the playhead to the previous or next stop; false when there is none that way. */
export function jumpToStop(direction: 1 | -1): boolean {
  const stop = neighbourStop(markerStops(), Math.round(useStudio.getState().timelineSeconds * TICKS_PER_SECOND), direction);
  if (stop === null) return false;
  previewControls.seek(ticksToSeconds(stop));
  return true;
}
