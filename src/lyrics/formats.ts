// Timed-lyrics files in and out (lyrics-spec §2.1, §10).
//
// Import: `.lrc` (line), enhanced `.lrc` (A2 word tags `<mm:ss.xx>`), `.srt`, `.vtt` (with inline
// word timestamps), `.ttml`. Export: `.lrc`, enhanced `.lrc`, `.srt`, `.vtt`, `.ass` (karaoke `\k`).
// Everything lands in, and comes out of, timeline ticks (1/48000 s), so what is exported re-imports
// with the same timings — to the precision the format can hold: centiseconds for LRC and ASS,
// milliseconds for SRT, VTT and TTML (§10 "round-trips").
//
// Pure string work, no DOM (TTML is read with a small tag scanner, not a DOM parser), so the same
// code runs in the studio, the main process and Node tests.
//
// Rules worth knowing, because they are choices:
//  - **LRC has no line ends.** A line ends at the next line's start, or at an empty time tag
//    (`[01:02.00]` alone — the common "line off" convention), but never more than
//    `max(3 s, 0.6 s × words)` after it starts: a line otherwise "sings" through an instrumental
//    break. Enhanced LRC's trailing tag, when present, is the exact end.
//  - A line with several time tags (`[00:12.00][00:45.00]Chorus line`) is one line per tag.
//  - `[offset:+500]` is applied as LRC defines it: positive shows lyrics earlier.
//  - Word stamps that do not match the line's words one to one are spread over the words they
//    cover by character count, never assigned to the wrong word.
//  - SRT/VTT cues spanning several text lines become one lyric line (subtitle wrapping is not
//    phrasing). Formatting tags are dropped.

import { lyricTokens, wordSpans, type RenderLyricLine } from '../engine/core/lyrics.ts';
import { TICKS_PER_SECOND } from '../engine/core/time.ts';
import type { Lyrics } from '../project/document.ts';
import { cleanLyricText } from './prepare.ts';

export const LYRICS_IMPORT_FORMATS = ['lrc', 'srt', 'vtt', 'ttml'] as const;
export type LyricsImportFormat = (typeof LYRICS_IMPORT_FORMATS)[number];

export const LYRICS_EXPORT_FORMATS = ['lrc', 'elrc', 'srt', 'vtt', 'ass'] as const;
export type LyricsExportFormat = (typeof LYRICS_EXPORT_FORMATS)[number];

export interface ImportedWord {
  readonly text: string;
  readonly startTicks: number;
  readonly endTicks: number;
}

export interface ImportedLine {
  readonly text: string;
  readonly startTicks: number;
  readonly endTicks: number;
  /** One per token of `text`, or null when the file has line timing only. */
  readonly words: readonly ImportedWord[] | null;
}

export interface ImportedLyrics {
  readonly format: LyricsImportFormat;
  /** Sorted by start. */
  readonly lines: readonly ImportedLine[];
  /** LRC `[ar:]`, `[ti:]`, … — kept for display; not applied. */
  readonly metadata: Readonly<Record<string, string>>;
  /** Things skipped or guessed, in plain language. */
  readonly warnings: readonly string[];
}

export class LyricsFormatError extends Error {
  override readonly name = 'LyricsFormatError';
}

const TICKS_PER_MS = TICKS_PER_SECOND / 1000;
const msToTicks = (ms: number) => Math.round(ms * TICKS_PER_MS);
const secondsToTicksExact = (s: number) => Math.round(s * TICKS_PER_SECOND);

/** Which importer a file needs, from its extension first and its content second. */
export function detectLyricsFormat(fileName: string, text: string): LyricsImportFormat | null {
  const ext = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase();
  if (ext === 'lrc' || ext === 'elrc') return 'lrc';
  if (ext === 'srt') return 'srt';
  if (ext === 'vtt') return 'vtt';
  if (ext === 'ttml' || ext === 'dfxp' || ext === 'xml') return 'ttml';
  const head = text.replace(/^\uFEFF/, '').trimStart();
  if (head.startsWith('WEBVTT')) return 'vtt';
  if (/^<\?xml|^<tt[\s>]/.test(head)) return 'ttml';
  if (/^\d+\s*\r?\n\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/.test(head)) return 'srt';
  if (/^\[(\d+:\d{1,2}|[a-z]+:)/i.test(head)) return 'lrc';
  return null;
}

export function importLyricsFile(fileName: string, text: string): ImportedLyrics {
  const format = detectLyricsFormat(fileName, text);
  if (format === null) {
    throw new LyricsFormatError('This file is not a lyrics format Pulseforge reads (.lrc, .srt, .vtt, .ttml). For plain text, paste it into the lyrics editor instead.');
  }
  const body = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  switch (format) {
    case 'lrc':
      return importLrc(body);
    case 'srt':
      return importSrt(body);
    case 'vtt':
      return importVtt(body);
    case 'ttml':
      return importTtml(body);
  }
}

// ---------------------------------------------------------------------------
// Shared: words from time-stamped segments
// ---------------------------------------------------------------------------

interface Segment {
  readonly text: string;
  readonly startTicks: number;
}

/**
 * Stamped segments of one line → the line's text and one word per token. Each segment's span
 * (its stamp to the next stamp, or to `endTicks`) is spread over the tokens inside it by
 * character count; a segment with no words (a stamp before a space) just moves time along.
 */
function wordsFromSegments(segments: readonly Segment[], endTicks: number): { text: string; words: ImportedWord[] } {
  const text = cleanLyricText(segments.map((s) => s.text).join(''));
  const words: ImportedWord[] = [];
  segments.forEach((segment, i) => {
    const next = i + 1 < segments.length ? (segments[i + 1] as Segment).startTicks : endTicks;
    const tokens = lyricTokens(cleanLyricText(segment.text));
    if (tokens.length === 0) return;
    const spans = wordSpans({ id: '', text: tokens.map((t) => t.text).join(' '), startTicks: segment.startTicks, endTicks: Math.max(segment.startTicks, next), role: 'lead', words: [], style: null });
    tokens.forEach((token, j) => {
      const span = spans[j] as { start: number; end: number };
      words.push({ text: token.text, startTicks: secondsToTicksExact(span.start), endTicks: secondsToTicksExact(span.end) });
    });
  });
  // Segment boundaries can split one token ("<t>don'<t>t"): only keep words when they line up.
  const tokens = lyricTokens(text);
  if (tokens.length !== words.length || tokens.some((t, i) => t.text !== (words[i] as ImportedWord).text)) {
    return { text, words: [] };
  }
  return { text, words };
}

// ---------------------------------------------------------------------------
// LRC
// ---------------------------------------------------------------------------

/** `mm:ss`, `mm:ss.x`, `mm:ss.xx`, `mm:ss.xxx`, `mm:ss:xx` (some writers use a colon). */
function lrcTime(stamp: string): number | null {
  const m = /^(\d+):(\d{1,2})(?:[.:](\d{1,3}))?$/.exec(stamp.trim());
  if (m === null) return null;
  const fraction = m[3] === undefined ? 0 : Number(m[3]) / 10 ** m[3].length;
  return msToTicks((Number(m[1]) * 60 + Number(m[2]) + fraction) * 1000);
}

function importLrc(body: string): ImportedLyrics {
  const metadata: Record<string, string> = {};
  const warnings: string[] = [];
  const stamped: { ticks: number; raw: string; order: number }[] = [];
  let order = 0;
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    const head = /^((?:\[[^\]]*\])+)(.*)$/.exec(line);
    if (head === null) {
      warnings.push(`A line without a time tag was skipped: "${line.slice(0, 40)}"`);
      continue;
    }
    const tags = [...(head[1] ?? '').matchAll(/\[([^\]]*)\]/g)].map((m) => m[1] ?? '');
    const rest = head[2] ?? '';
    const times: number[] = [];
    for (const tag of tags) {
      const ticks = lrcTime(tag);
      if (ticks !== null) {
        times.push(ticks);
        continue;
      }
      const meta = /^([a-z#]+)\s*:(.*)$/i.exec(tag);
      if (meta !== null) metadata[(meta[1] ?? '').toLowerCase()] = (meta[2] ?? '').trim();
    }
    for (const ticks of times) stamped.push({ ticks, raw: rest, order: order++ });
  }
  const offsetMs = Number(metadata['offset'] ?? 0);
  const offset = Number.isFinite(offsetMs) ? msToTicks(offsetMs) : 0;
  if (!Number.isFinite(offsetMs)) warnings.push(`The [offset:] tag "${metadata['offset']}" is not a number and was ignored.`);
  stamped.sort((a, b) => a.ticks - b.ticks || a.order - b.order);

  const lines: ImportedLine[] = [];
  stamped.forEach((entry, i) => {
    const start = Math.max(0, entry.ticks - offset);
    const text = cleanLyricText(entry.raw.replace(/<[^>]*>/g, ''));
    if (text === '') return; // an empty tag ends the line before it
    const nextTicks = i + 1 < stamped.length ? Math.max(0, (stamped[i + 1] as { ticks: number }).ticks - offset) : null;
    // Word tags: `<mm:ss.xx>word <mm:ss.xx>word <mm:ss.xx>` (A2 extension).
    const wordTags = [...entry.raw.matchAll(/<(\d+:\d{1,2}(?:[.:]\d{1,3})?)>/g)];
    const tokenCount = lyricTokens(text).length;
    const cap = start + secondsToTicksExact(Math.max(3, 0.6 * tokenCount));
    let end = nextTicks === null ? cap : Math.min(nextTicks, cap);
    if (wordTags.length === 0) {
      lines.push({ text, startTicks: start, endTicks: Math.max(start, end), words: null });
      return;
    }
    const segments: Segment[] = [];
    const leading = entry.raw.slice(0, wordTags[0]?.index ?? 0);
    if (cleanLyricText(leading.replace(/<[^>]*>/g, '')) !== '') segments.push({ text: leading, startTicks: start });
    wordTags.forEach((tag, j) => {
      const from = (tag.index ?? 0) + tag[0].length;
      const to = j + 1 < wordTags.length ? ((wordTags[j + 1] as RegExpMatchArray).index ?? from) : entry.raw.length;
      const ticks = Math.max(0, (lrcTime(tag[1] ?? '') ?? start) - offset);
      segments.push({ text: entry.raw.slice(from, to), startTicks: ticks });
    });
    // A trailing tag with nothing after it is the exact end of the last word.
    const last = segments[segments.length - 1] as Segment;
    if (cleanLyricText(last.text) === '' && segments.length > 1) {
      end = last.startTicks;
      segments.pop();
    } else if (nextTicks !== null) {
      end = Math.max(end, Math.min(nextTicks, last.startTicks + secondsToTicksExact(Math.max(1, 0.6 * lyricTokens(cleanLyricText(last.text)).length))));
    }
    const { text: joined, words } = wordsFromSegments(segments, end);
    const first = words[0]?.startTicks ?? start;
    lines.push({ text: joined, startTicks: Math.min(start, first), endTicks: Math.max(start, end), words: words.length > 0 ? words : null });
    if (words.length === 0) warnings.push(`Word tags on "${joined.slice(0, 40)}" did not line up with its words; the line keeps line timing only.`);
  });
  return { format: 'lrc', lines, metadata, warnings };
}

// ---------------------------------------------------------------------------
// SRT and VTT
// ---------------------------------------------------------------------------

/** `hh:mm:ss,mmm`, `hh:mm:ss.mmm` or (VTT) `mm:ss.mmm`. */
function clockTime(stamp: string): number | null {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/.exec(stamp.trim());
  if (m === null) return null;
  const ms = Number((m[4] ?? '0').padEnd(3, '0'));
  return msToTicks(((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + ms);
}

function stripTags(text: string): string {
  return text.replace(/\{\\[^}]*\}/g, '').replace(/<[^>]*>/g, '');
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

interface Cue {
  readonly start: number;
  readonly end: number;
  readonly lines: readonly string[];
}

function cues(body: string, warnings: string[], isVtt: boolean): Cue[] {
  const out: Cue[] = [];
  for (const block of body.split(/\n\s*\n/)) {
    const rows = block.split('\n').map((row) => row.trimEnd()).filter((row) => row.trim() !== '');
    if (rows.length === 0) continue;
    const timingIndex = rows.findIndex((row) => row.includes('-->'));
    if (timingIndex < 0) {
      const first = rows[0] ?? '';
      if (!isVtt || !/^(WEBVTT|NOTE|STYLE|REGION)\b/.test(first)) warnings.push(`A block without a time line was skipped: "${first.slice(0, 40)}"`);
      continue;
    }
    const [from, rest] = (rows[timingIndex] as string).split('-->');
    const start = clockTime(from ?? '');
    const end = clockTime((rest ?? '').trim().split(/\s+/)[0] ?? '');
    if (start === null || end === null) {
      warnings.push(`A cue with an unreadable time line was skipped: "${rows[timingIndex]}"`);
      continue;
    }
    out.push({ start, end: Math.max(start, end), lines: rows.slice(timingIndex + 1) });
  }
  return out.sort((a, b) => a.start - b.start);
}

function importSrt(body: string): ImportedLyrics {
  const warnings: string[] = [];
  const lines = cues(body, warnings, false)
    .map((cue): ImportedLine => ({ text: cleanLyricText(decodeEntities(stripTags(cue.lines.join(' ')))), startTicks: cue.start, endTicks: cue.end, words: null }))
    .filter((line) => line.text !== '');
  return { format: 'srt', lines, metadata: {}, warnings };
}

function importVtt(body: string): ImportedLyrics {
  const warnings: string[] = [];
  const lines: ImportedLine[] = [];
  for (const cue of cues(body, warnings, true)) {
    const raw = cue.lines.join(' ');
    const stamps = [...raw.matchAll(/<((?:\d+:)?\d{1,2}:\d{1,2}\.\d{1,3})>/g)];
    if (stamps.length === 0) {
      const text = cleanLyricText(decodeEntities(stripTags(raw)));
      if (text !== '') lines.push({ text, startTicks: cue.start, endTicks: cue.end, words: null });
      continue;
    }
    const segments: Segment[] = [{ text: decodeEntities(stripTags(raw.slice(0, stamps[0]?.index ?? 0))), startTicks: cue.start }];
    stamps.forEach((stamp, j) => {
      const from = (stamp.index ?? 0) + stamp[0].length;
      const to = j + 1 < stamps.length ? ((stamps[j + 1] as RegExpMatchArray).index ?? from) : raw.length;
      segments.push({ text: decodeEntities(stripTags(raw.slice(from, to))), startTicks: clockTime(stamp[1] ?? '') ?? cue.start });
    });
    const { text, words } = wordsFromSegments(segments.filter((s, i) => i > 0 || cleanLyricText(s.text) !== ''), cue.end);
    if (text === '') continue;
    lines.push({ text, startTicks: cue.start, endTicks: cue.end, words: words.length > 0 ? words : null });
  }
  return { format: 'vtt', lines, metadata: {}, warnings };
}

// ---------------------------------------------------------------------------
// TTML
// ---------------------------------------------------------------------------

/** TTML clock (`hh:mm:ss.fff`, `mm:ss.fff`) or offset (`12.5s`, `1500ms`, `2m`, `1h`) time. */
function ttmlTime(value: string | undefined): number | null {
  if (value === undefined) return null;
  const v = value.trim();
  const offset = /^(\d+(?:\.\d+)?)(h|m|s|ms)$/.exec(v);
  if (offset !== null) {
    const n = Number(offset[1]);
    const unit = offset[2];
    const seconds = unit === 'h' ? n * 3600 : unit === 'm' ? n * 60 : unit === 'ms' ? n / 1000 : n;
    return secondsToTicksExact(seconds);
  }
  const clock = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(v);
  if (clock !== null) return secondsToTicksExact((Number(clock[1] ?? 0) * 60 + Number(clock[2])) * 60 + Number(clock[3]));
  if (/^\d+(?:\.\d+)?$/.test(v)) return secondsToTicksExact(Number(v));
  return null;
}

function attribute(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(tag);
  return m === null ? undefined : (m[2] ?? m[3]);
}

function importTtml(body: string): ImportedLyrics {
  const warnings: string[] = [];
  const lines: ImportedLine[] = [];
  if (/ttp:tickRate|\d+t["']/.test(body)) warnings.push('Tick-based TTML times are not supported; affected lines were skipped.');
  for (const p of body.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)) {
    const attrs = p[1] ?? '';
    const inner = (p[2] ?? '').replace(/<br\s*\/?>/g, ' ');
    const start = ttmlTime(attribute(attrs, 'begin'));
    const endAttr = ttmlTime(attribute(attrs, 'end'));
    const dur = ttmlTime(attribute(attrs, 'dur'));
    if (start === null) {
      warnings.push('A paragraph without a begin time was skipped.');
      continue;
    }
    const end = endAttr ?? (dur !== null ? start + dur : start);
    const spans = [...inner.matchAll(/<span\b([^>]*)>([\s\S]*?)<\/span>/g)]
      .map((s) => ({ begin: ttmlTime(attribute(s[1] ?? '', 'begin')), text: decodeEntities(stripTags(s[2] ?? '')), index: s.index ?? 0, length: s[0].length }));
    const timedSpans = spans.filter((s) => s.begin !== null);
    if (timedSpans.length === 0) {
      const text = cleanLyricText(decodeEntities(stripTags(inner)));
      if (text !== '') lines.push({ text, startTicks: start, endTicks: Math.max(start, end), words: null });
      continue;
    }
    // Span times are relative to the paragraph in TTML's model, but widely written as absolute
    // (Apple's lyrics TTML among them). Absolute when every span falls inside the paragraph.
    const absolute = timedSpans.every((s) => (s.begin as number) >= start && (s.begin as number) <= Math.max(start, end));
    const segments: Segment[] = [];
    let cursor = 0;
    /** Untimed text between spans belongs to the span before it (or starts the paragraph). */
    const attach = (raw: string) => {
      const between = cleanLyricText(decodeEntities(stripTags(raw)));
      if (between === '') return;
      const last = segments.pop();
      segments.push(last === undefined ? { text: ` ${between} `, startTicks: start } : { ...last, text: `${last.text} ${between} ` });
    };
    for (const span of spans) {
      attach(inner.slice(cursor, span.index));
      const begin = span.begin === null ? (segments[segments.length - 1]?.startTicks ?? start) : absolute ? span.begin : start + span.begin;
      segments.push({ text: ` ${span.text} `, startTicks: begin });
      cursor = span.index + span.length;
    }
    attach(inner.slice(cursor));
    const { text, words } = wordsFromSegments(segments, Math.max(start, end));
    if (text === '') continue;
    lines.push({ text, startTicks: start, endTicks: Math.max(start, end), words: words.length > 0 ? words : null });
  }
  lines.sort((a, b) => a.startTicks - b.startTicks);
  return { format: 'ttml', lines, metadata: {}, warnings };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function timedLines(lyrics: Lyrics): RenderLyricLine[] {
  return lyrics.lines
    .map((line, order) => ({ line, order }))
    .filter(({ line }) => line.startTicks !== null && line.endTicks !== null)
    .map(({ line, order }) => ({
      order,
      line: {
        id: line.id,
        text: line.text,
        startTicks: line.startTicks as number,
        endTicks: Math.max(line.startTicks as number, line.endTicks as number),
        role: line.role,
        words: line.words.map((w) => ({ startTicks: w.startTicks, endTicks: w.endTicks })),
        style: null,
      },
    }))
    .sort((a, b) => a.line.startTicks - b.line.startTicks || a.order - b.order)
    .map(({ line }) => line);
}

const centis = (ticks: number) => Math.round(ticks / (TICKS_PER_SECOND / 100));
const millis = (ticks: number) => Math.round(ticks / TICKS_PER_MS);

function lrcStamp(ticks: number): string {
  const cs = centis(Math.max(0, ticks));
  const minutes = Math.floor(cs / 6000);
  const secs = Math.floor((cs % 6000) / 100);
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

function clockStamp(ticks: number, separator: ',' | '.'): string {
  const ms = millis(Math.max(0, ticks));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${separator}${String(ms % 1000).padStart(3, '0')}`;
}

function assStamp(ticks: number): string {
  const cs = centis(Math.max(0, ticks));
  const h = Math.floor(cs / 360_000);
  const m = Math.floor((cs % 360_000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

/** Word spans in ticks for export: explicit when the line has them, otherwise interpolated (§6.4). */
function spansInTicks(line: RenderLyricLine): { text: string; start: number; end: number }[] {
  const tokens = lyricTokens(line.text);
  return wordSpans(line).map((span, i) => ({ text: (tokens[i] as { text: string }).text, start: secondsToTicksExact(span.start), end: secondsToTicksExact(span.end) }));
}

export interface ExportOptions {
  readonly title?: string;
  /** For `.ass`: the script's play resolution, so positions and sizes match the video. */
  readonly canvas?: { readonly width: number; readonly height: number };
}

export function exportLyrics(lyrics: Lyrics, format: LyricsExportFormat, options: ExportOptions = {}): string {
  const lines = timedLines(lyrics);
  switch (format) {
    case 'lrc':
    case 'elrc': {
      const out: string[] = [];
      if (options.title !== undefined && options.title !== '') out.push(`[ti:${options.title}]`);
      out.push('[re:Pulseforge]');
      lines.forEach((line, i) => {
        if (format === 'lrc') {
          out.push(`[${lrcStamp(line.startTicks)}]${line.text}`);
        } else {
          const words = spansInTicks(line).map((w) => `<${lrcStamp(w.start)}>${w.text}`).join(' ');
          out.push(`[${lrcStamp(line.startTicks)}]${words} <${lrcStamp(line.endTicks)}>`);
        }
        const next = lines[i + 1];
        // LRC has no line ends; an empty tag marks one when the next line does not start there.
        if (format === 'lrc' && (next === undefined || centis(next.startTicks) > centis(line.endTicks))) out.push(`[${lrcStamp(line.endTicks)}]`);
      });
      return `${out.join('\n')}\n`;
    }
    case 'srt':
      return lines.map((line, i) => `${i + 1}\n${clockStamp(line.startTicks, ',')} --> ${clockStamp(line.endTicks, ',')}\n${line.text}\n`).join('\n');
    case 'vtt': {
      const cuesOut = lines.map((line, i) => {
        const hasWords = line.words.length > 0 && line.words.length === lyricTokens(line.text).length;
        const text = hasWords
          ? spansInTicks(line).map((w) => (millis(w.start) > millis(line.startTicks) ? `<${clockStamp(w.start, '.')}>${w.text}` : w.text)).join(' ')
          : line.text;
        return `${i + 1}\n${clockStamp(line.startTicks, '.')} --> ${clockStamp(line.endTicks, '.')}\n${text}\n`;
      });
      return `WEBVTT\n\n${cuesOut.join('\n')}`;
    }
    case 'ass': {
      const width = options.canvas?.width ?? 1920;
      const height = options.canvas?.height ?? 1080;
      const size = Math.round(Math.min(width, height) * 0.07);
      const events = lines.map((line) => {
        let cursor = line.startTicks;
        const parts: string[] = [];
        for (const word of spansInTicks(line)) {
          const gap = centis(word.start) - centis(cursor);
          if (gap > 0) parts.push(`{\\k${gap}}`);
          parts.push(`{\\k${Math.max(0, centis(word.end) - centis(word.start))}}${word.text.replace(/[{}]/g, '')} `);
          cursor = word.end;
        }
        return `Dialogue: 0,${assStamp(line.startTicks)},${assStamp(line.endTicks)},Default,,0,0,0,,${parts.join('').trimEnd()}`;
      });
      return [
        '[Script Info]',
        `Title: ${options.title ?? 'Lyrics'}`,
        'ScriptType: v4.00+',
        `PlayResX: ${width}`,
        `PlayResY: ${height}`,
        'WrapStyle: 0',
        '',
        '[V4+ Styles]',
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
        // ASS colours are &HAABBGGRR: sung #ff2d95 after the \k sweep, white before it.
        `Style: Default,Inter,${size},&H00952DFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,40,40,${Math.round(height * 0.08)},1`,
        '',
        '[Events]',
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
        ...events,
        '',
      ].join('\n');
    }
  }
}
