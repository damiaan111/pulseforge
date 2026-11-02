// A render that has stopped moving (export-spec §14: "fail with diagnostics rather than hanging
// overnight"). The render runs in a child process, and a hung child neither fails nor finishes, so
// the queue behind it would wait for ever. Silence is the signal: the child reports as it works, so
// a long stretch with nothing from it is a stall, however slow the frames.

/** Longer than any honest silence: the slowest frame of a 4K, 32-sample render takes seconds. */
export const STALL_TIMEOUT_MS = 120_000;

/** Calls `onStall` once, if `alive()` goes unheard-of for `timeoutMs`. */
export function stallWatch(timeoutMs: number, onStall: () => void): { alive(): void; stop(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(onStall, timeoutMs);
  };
  arm();
  return {
    alive: arm,
    stop: () => clearTimeout(timer),
  };
}
