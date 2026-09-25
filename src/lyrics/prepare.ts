// Pasted or typed lyrics → lines and section markers (lyrics-spec §2.1–§2.2).
//
// Pasting lyrics from the web is the normal case, and web lyrics come with annotations: "[Verse 1]",
// "[Chorus: Artist]", "(x2)". Those are not sung, so they must not be drawn — but they are not
// noise either: they say where the chorus starts. They become **section markers** kept beside the
// lines (document `LyricSection`), shown in the editor and never rendered.
//
// Rules, stated so they can be relied on and tested:
//  - Text is NFC-normalised; non-breaking and other exotic spaces become plain spaces; zero-width
//    characters are removed; runs of spaces collapse; lines are trimmed. Blank lines separate
//    stanzas and produce no line.
//  - A line that is entirely in square brackets is a marker ("[Chorus]" → "Chorus").
//  - A line entirely in round brackets is a marker when it names a section or a repeat ("(Chorus)",
//    "(x2)"); otherwise it is a sung line whose role is **backing** ("(ooh, yeah)") — the usual
//    meaning of a parenthesised line in pasted lyrics. The role is a starting point, editable.
//  - A repeat count at the end of a line ("Hold on (x2)", "Hold on x2", "[2x]") is stripped from the
//    text and becomes a "×2" marker before that line.
//  - Nothing else is changed: case, punctuation and inline parentheses stay as typed.

import type { LyricRole } from '../project/document.ts';

export interface PreparedLine {
  readonly text: string;
  readonly role: LyricRole;
}

export interface PreparedSection {
  readonly label: string;
  /** Index into `lines` of the line the marker precedes; `lines.length` means after the last line. */
  readonly beforeIndex: number;
}

export interface PreparedLyrics {
  readonly lines: readonly PreparedLine[];
  readonly sections: readonly PreparedSection[];
}

const SECTION_WORDS = /^(?:verse|chorus|pre[- ]?chorus|post[- ]?chorus|bridge|intro|outro|hook|refrain|interlude|instrumental|solo|break|breakdown|drop|build|coda|ad[- ]?libs?|spoken|rap|vamp|tag)\b/i;
const REPEAT = /^(?:x\s?(\d{1,2})|(\d{1,2})\s?x|×\s?(\d{1,2}))$/i;
const TRAILING_REPEAT = /\s*[([]\s*(?:x\s?(\d{1,2})|(\d{1,2})\s?x|×\s?(\d{1,2}))\s*[)\]]\s*$|\s+(?:x(\d{1,2})|×(\d{1,2}))\s*$/i;

/** One line of text, cleaned: the same normalisation the editor and the importers use. */
export function cleanLyricText(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\s\u00A0\u2000-\u200A\u202F\u205F\u3000]+/g, ' ')
    .trim();
}

function repeatLabel(match: RegExpMatchArray): string {
  const count = match.slice(1).find((group) => group !== undefined);
  return `×${Number(count)}`;
}

/** What a marker line says, or null when the line is sung. */
function markerOf(line: string): { label: string } | { backing: true } | null {
  const square = /^\[(.*)\]$/.exec(line);
  if (square !== null) {
    const inner = cleanLyricText(square[1] ?? '');
    const repeat = REPEAT.exec(inner);
    return { label: repeat !== null ? repeatLabel(repeat) : inner };
  }
  const round = /^\((.*)\)$/.exec(line);
  if (round !== null) {
    const inner = cleanLyricText(round[1] ?? '');
    const repeat = REPEAT.exec(inner);
    if (repeat !== null) return { label: repeatLabel(repeat) };
    if (SECTION_WORDS.test(inner)) return { label: inner };
    return { backing: true };
  }
  return null;
}

export function prepareLyricsText(text: string): PreparedLyrics {
  const lines: PreparedLine[] = [];
  const sections: PreparedSection[] = [];
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    let line = cleanLyricText(raw);
    if (line === '') continue;
    const marker = markerOf(line);
    if (marker !== null && 'label' in marker) {
      if (marker.label !== '') sections.push({ label: marker.label, beforeIndex: lines.length });
      continue;
    }
    const trailing = TRAILING_REPEAT.exec(line);
    if (trailing !== null && trailing.index > 0) {
      sections.push({ label: repeatLabel(trailing), beforeIndex: lines.length });
      line = line.slice(0, trailing.index).trim();
    }
    lines.push({ text: line, role: marker !== null ? 'backing' : 'lead' });
  }
  return { lines, sections };
}

/**
 * Assisted splitting (§2.2): a line longer than `maxChars` splits at the punctuation nearest its
 * middle, or failing that at the space nearest its middle, recursively — preserving phrasing
 * rather than cutting at a fixed width. A single word longer than the limit stays whole.
 */
export function splitLongLine(text: string, maxChars: number): readonly string[] {
  const clean = cleanLyricText(text);
  if (clean.length <= maxChars || !clean.includes(' ')) return [clean];
  const middle = clean.length / 2;
  const candidates = (pattern: RegExp) => {
    const out: number[] = [];
    for (let m = pattern.exec(clean); m !== null; m = pattern.exec(clean)) out.push(m.index + m[0].length);
    return out;
  };
  // A split after punctuation reads naturally; only accept one reasonably near the middle.
  const punctuation = candidates(/[,;:.!?…—–]\s/g).filter((i) => i > clean.length * 0.25 && i < clean.length * 0.75);
  const spaces = candidates(/\s/g);
  const pool = punctuation.length > 0 ? punctuation : spaces;
  const at = pool.reduce((best, i) => (Math.abs(i - middle) < Math.abs(best - middle) ? i : best), pool[0] as number);
  const left = clean.slice(0, at).trim();
  const right = clean.slice(at).trim();
  if (left === '' || right === '') return [clean];
  return [...splitLongLine(left, maxChars), ...splitLongLine(right, maxChars)];
}
