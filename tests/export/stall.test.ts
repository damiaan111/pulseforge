import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { stallWatch } from '../../src/export/stall.ts';

describe('stallWatch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires once after a silence', () => {
    const onStall = vi.fn();
    stallWatch(1000, onStall);
    vi.advanceTimersByTime(999);
    expect(onStall).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5000);
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it('never fires while the child keeps talking, however long it takes', () => {
    const onStall = vi.fn();
    const watch = stallWatch(1000, onStall);
    for (let i = 0; i < 100; i += 1) {
      vi.advanceTimersByTime(900);
      watch.alive();
    }
    expect(onStall).not.toHaveBeenCalled();
    watch.stop();
    vi.advanceTimersByTime(5000);
    expect(onStall).not.toHaveBeenCalled();
  });
});
