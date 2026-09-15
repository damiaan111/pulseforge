// Small pure helpers in the studio that the audit found wrong (2026-09-15).

import { describe, expect, it } from 'vitest';

import { formatTime } from '../../src/ui/components/TransportBar.tsx';
import { resolveAgainstProject } from '../../src/ui/store.ts';

describe('formatTime', () => {
  it('rounds before splitting minutes, so it never prints 60 seconds', () => {
    expect(formatTime(59.996)).toBe('01:00.00');
    expect(formatTime(119.999)).toBe('02:00.00');
    expect(formatTime(61.5)).toBe('01:01.50');
    expect(formatTime(-3)).toBe('00:00.00');
    expect(formatTime(Number.NaN)).toBe('00:00.00');
  });
});

describe('resolveAgainstProject', () => {
  it('resolves relative paths against the project folder and leaves absolute ones', () => {
    expect(resolveAgainstProject('audio/song.wav', 'D:\\songs\\one.pvproj')).toBe('D:\\songs\\audio/song.wav');
    expect(resolveAgainstProject('song.wav', '/home/x/one.pvproj')).toBe('/home/x/song.wav');
    expect(resolveAgainstProject('D:/music/song.wav', 'C:\\p\\one.pvproj')).toBe('D:/music/song.wav');
    expect(resolveAgainstProject('\\\\server\\share\\a.wav', 'C:\\p\\one.pvproj')).toBe('\\\\server\\share\\a.wav');
    expect(resolveAgainstProject('song.wav', null)).toBe('song.wav');
    expect(resolveAgainstProject('', 'C:\\p\\one.pvproj')).toBe('');
  });
});
