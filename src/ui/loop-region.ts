// The preview's loop region: I and O set its ends at the playhead, L turns it on and off. A way of
// listening, not part of the project, so it is neither undone nor saved, and it never reaches a render.

export interface LoopState {
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly on: boolean;
}

/** Shortest loop: anything less is a stutter, and the clock needs a frame to wrap. */
const MIN_LOOP_SECONDS = 0.1;

/** Sets one end; an end that would pass the other moves the other, keeping the minimum between them. */
export function setLoopEnd(loop: LoopState | null, end: 'in' | 'out', seconds: number, duration: number): LoopState {
  const start = end === 'in' ? seconds : loop?.startSeconds ?? 0;
  const stop = end === 'out' ? seconds : loop?.endSeconds ?? duration;
  if (stop - start >= MIN_LOOP_SECONDS) return { startSeconds: start, endSeconds: stop, on: true };
  return end === 'in'
    ? { startSeconds: start, endSeconds: Math.min(duration, start + MIN_LOOP_SECONDS), on: true }
    : { startSeconds: Math.max(0, stop - MIN_LOOP_SECONDS), endSeconds: stop, on: true };
}

/** On and off, keeping the region; the first press with no region does nothing to say so. */
export function toggleLoop(loop: LoopState | null): LoopState | null {
  return loop === null ? null : { ...loop, on: !loop.on };
}
