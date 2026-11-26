// Timecodes for editing lyric times by hand: `m:ss.cc` out, and a forgiving reader in.

import { TICKS_PER_SECOND } from '../engine/core/time.ts';

/** `1:02.35` — minutes, seconds, hundredths. The editor's precision; ticks stay exact underneath. */
export function formatLyricTime(ticks: number | null): string {
  if (ticks === null) return '';
  const hundredths = Math.round(Math.max(0, ticks) / (TICKS_PER_SECOND / 100));
  const minutes = Math.floor(hundredths / 6000);
  const rest = hundredths - minutes * 6000;
  return `${minutes}:${String(Math.floor(rest / 100)).padStart(2, '0')}.${String(rest % 100).padStart(2, '0')}`;
}

/**
 * Reads what a person types: `1:02.35`, `62.35`, `1:02`, `0:01:02.350`. Returns ticks, or null for
 * text that is not a time (the field then keeps its value and says so). Empty text is `undefined`:
 * "clear this time".
 */
export function parseLyricTime(text: string): number | null | undefined {
  const value = text.trim().replace(',', '.');
  if (value === '') return undefined;
  const m = /^(?:(\d+):)?(?:(\d+):)?(\d+(?:\.\d*)?)$/.exec(value);
  if (m === null) return null;
  const parts = [m[1], m[2]].filter((p): p is string => p !== undefined).map(Number);
  const seconds = Number(m[3]);
  const hours = parts.length === 2 ? (parts[0] as number) : 0;
  const minutes = parts.length === 2 ? (parts[1] as number) : parts.length === 1 ? (parts[0] as number) : 0;
  if (parts.length > 0 && seconds >= 60) return null;
  return Math.round((hours * 3600 + minutes * 60 + seconds) * TICKS_PER_SECOND);
}
