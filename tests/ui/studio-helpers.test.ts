// Small pure helpers in the studio that the audit found wrong (2026-09-15).
// (Path resolution moved to src/project/asset-paths.ts and is tested there.)

import { describe, expect, it } from 'vitest';

import { formatTime } from '../../src/ui/components/TransportBar.tsx';

describe('formatTime', () => {
  it('rounds before splitting minutes, so it never prints 60 seconds', () => {
    expect(formatTime(59.996)).toBe('01:00.00');
    expect(formatTime(119.999)).toBe('02:00.00');
    expect(formatTime(61.5)).toBe('01:01.50');
    expect(formatTime(-3)).toBe('00:00.00');
    expect(formatTime(Number.NaN)).toBe('00:00.00');
  });
});
