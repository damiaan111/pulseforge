// The lyrics checklist (lyrics-spec §9): what catches a timing error before a 20-minute 4K render
// rather than after. Pure, run continuously by the lyrics panel; every check names the lines it is
// about so the panel can jump to them.
//
// Two checks from the spec's table live elsewhere, because they need the renderer: **text
// overflowing the safe area** and **missing fonts** are reported by the lyrics layer itself, per
// frame, through the same warning path every layer uses.

import { lyricTokens } from '../engine/core/lyrics.ts';
import { TICKS_PER_SECOND } from '../engine/core/time.ts';
import type { LyricLine, Lyrics } from '../project/document.ts';
import { coveredSeconds, type VocalSegment } from './vocal-segments.ts';

export type CheckSeverity = 'error' | 'warning' | 'info';

export type CheckKind =
  | 'untimed'
  | 'overlap'
  | 'out-of-order'
  | 'too-short'
  | 'too-long'
  | 'reading-speed'
  | 'word-timing'
  | 'word-mismatch'
  | 'no-singing'
  | 'unassigned-singing'
  | 'low-confidence';

export interface LyricsCheck {
  readonly kind: CheckKind;
  readonly severity: CheckSeverity;
  readonly message: string;
  readonly lineIds: readonly string[];
  /** Where on the timeline it is, for a jump-to; ticks. */
  readonly atTicks: number | null;
}

export interface ValidateOptions {
  /** Singing detected on the vocal stem, in **timeline** seconds. Absent: the vocal checks are skipped. */
  readonly vocalSegments?: readonly VocalSegment[];
  /** Characters (letters and digits) per second above which a line is too fast to read. */
  readonly maxCharsPerSecond?: number;
}

export const MIN_LINE_SECONDS = 0.25;
export const MAX_LINE_SECONDS = 15;
export const DEFAULT_MAX_CHARS_PER_SECOND = 25;
const LOW_CONFIDENCE = 0.5;

const sec = (ticks: number) => ticks / TICKS_PER_SECOND;

export function formatClock(ticks: number): string {
  const s = Math.max(0, sec(ticks));
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}

const quote = (line: LyricLine) => `“${line.text.length > 32 ? `${line.text.slice(0, 31)}…` : line.text}”`;

export function validateLyrics(lyrics: Lyrics, options: ValidateOptions = {}): readonly LyricsCheck[] {
  const checks: LyricsCheck[] = [];
  const maxCps = options.maxCharsPerSecond ?? DEFAULT_MAX_CHARS_PER_SECOND;
  const timed = lyrics.lines.filter((l): l is LyricLine & { startTicks: number; endTicks: number } => l.startTicks !== null && l.endTicks !== null);

  const untimed = lyrics.lines.filter((l) => l.startTicks === null || l.endTicks === null);
  if (untimed.length > 0) {
    checks.push({
      kind: 'untimed',
      severity: 'info',
      message: `${untimed.length} line${untimed.length === 1 ? ' has' : 's have'} no timing yet and will not be shown — tap-to-sync, import timings or align.`,
      lineIds: untimed.map((l) => l.id),
      atTicks: null,
    });
  }

  // Reading order vs time order, and overlaps — per role: backing vocals overlapping the lead is
  // the normal case (D35), not an error.
  const byRole = new Map<string, typeof timed>();
  for (const line of timed) byRole.set(line.role, [...(byRole.get(line.role) ?? []), line]);
  for (const lines of byRole.values()) {
    for (let i = 1; i < lines.length; i += 1) {
      const a = lines[i - 1] as (typeof timed)[number];
      const b = lines[i] as (typeof timed)[number];
      if (b.startTicks < a.startTicks) {
        checks.push({ kind: 'out-of-order', severity: 'warning', message: `${quote(b)} is timed before the line above it — a tap on the wrong line?`, lineIds: [a.id, b.id], atTicks: b.startTicks });
      } else if (b.startTicks < a.endTicks) {
        checks.push({ kind: 'overlap', severity: 'warning', message: `${quote(a)} and ${quote(b)} overlap by ${(sec(a.endTicks - b.startTicks)).toFixed(2)} s — usually a mis-tap; it renders as garbled text.`, lineIds: [a.id, b.id], atTicks: b.startTicks });
      }
    }
  }

  for (const line of timed) {
    const duration = sec(line.endTicks - line.startTicks);
    if (duration < MIN_LINE_SECONDS) {
      checks.push({ kind: 'too-short', severity: 'warning', message: `${quote(line)} lasts ${duration.toFixed(2)} s — almost always an error.`, lineIds: [line.id], atTicks: line.startTicks });
    } else if (duration > MAX_LINE_SECONDS) {
      checks.push({ kind: 'too-long', severity: 'warning', message: `${quote(line)} lasts ${duration.toFixed(1)} s — it probably runs through a break.`, lineIds: [line.id], atTicks: line.startTicks });
    }
    const chars = [...line.text].filter((ch) => /[\p{L}\p{N}]/u.test(ch)).length;
    if (duration >= MIN_LINE_SECONDS && chars / duration > maxCps) {
      checks.push({ kind: 'reading-speed', severity: 'warning', message: `${quote(line)} needs ${(chars / duration).toFixed(0)} characters a second to read — technically right, practically unreadable.`, lineIds: [line.id], atTicks: line.startTicks });
    }

    if (line.words.length > 0) {
      const tokens = lyricTokens(line.text);
      if (line.words.length !== tokens.length) {
        checks.push({ kind: 'word-mismatch', severity: 'info', message: `${quote(line)} has ${line.words.length} word timings for ${tokens.length} words; they are ignored and the words interpolated.`, lineIds: [line.id], atTicks: line.startTicks });
      } else {
        const broken = line.words.some((w, i) => w.endTicks <= w.startTicks || (i > 0 && w.startTicks < (line.words[i - 1] as { startTicks: number }).startTicks)
          || w.startTicks < line.startTicks || w.endTicks > line.endTicks);
        if (broken) {
          checks.push({ kind: 'word-timing', severity: 'error', message: `${quote(line)} has words out of order, zero-length or outside the line.`, lineIds: [line.id], atTicks: line.startTicks });
        }
      }
    }
  }

  // Low confidence (alignment output): lines below the threshold, or with three words in a row
  // below it — a cluster points at the region worth reviewing (§4).
  const suspect = timed.filter((line) => {
    if (line.confidence !== null && line.confidence < LOW_CONFIDENCE) return true;
    let run = 0;
    for (const w of line.words) {
      run = w.confidence !== null && w.confidence < LOW_CONFIDENCE ? run + 1 : 0;
      if (run >= 3) return true;
    }
    return false;
  });
  if (suspect.length > 0) {
    checks.push({
      kind: 'low-confidence',
      severity: 'info',
      message: `${suspect.length} aligned line${suspect.length === 1 ? ' is' : 's are'} low-confidence — worth a look before rendering.`,
      lineIds: suspect.map((l) => l.id),
      atTicks: (suspect[0] as { startTicks: number }).startTicks,
    });
  }

  const segments = options.vocalSegments;
  if (segments !== undefined) {
    for (const line of timed) {
      if (line.role === 'instrumental-note') continue;
      const duration = sec(line.endTicks - line.startTicks);
      if (duration <= 0) continue;
      const covered = coveredSeconds(segments, sec(line.startTicks), sec(line.endTicks));
      if (covered / duration < 0.15) {
        checks.push({ kind: 'no-singing', severity: 'warning', message: `No singing detected under ${quote(line)} at ${formatClock(line.startTicks)} — timing drifted, or the line is in the wrong place.`, lineIds: [line.id], atTicks: line.startTicks });
      }
    }
    const sung = timed.filter((l) => l.role !== 'instrumental-note').map((l) => ({ start: sec(l.startTicks), end: sec(l.endTicks) })).sort((a, b) => a.start - b.start);
    const merged: { start: number; end: number }[] = [];
    for (const s of sung) {
      const last = merged[merged.length - 1];
      if (last !== undefined && s.start <= last.end) last.end = Math.max(last.end, s.end);
      else merged.push({ ...s });
    }
    for (const segment of segments) {
      const length = segment.end - segment.start;
      if (length < 1.5) continue;
      if (coveredSeconds(merged, segment.start, segment.end) / length < 0.3) {
        const at = Math.round(segment.start * TICKS_PER_SECOND);
        checks.push({
          kind: 'unassigned-singing',
          severity: 'info',
          message: `Singing at ${formatClock(at)}–${formatClock(Math.round(segment.end * TICKS_PER_SECOND))} has no line — a skipped repeat?`,
          lineIds: [],
          atTicks: at,
        });
      }
    }
  }

  const rank: Record<CheckSeverity, number> = { error: 0, warning: 1, info: 2 };
  return checks.sort((a, b) => rank[a.severity] - rank[b.severity] || (a.atTicks ?? Infinity) - (b.atTicks ?? Infinity));
}
