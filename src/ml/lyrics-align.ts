// Lyrics alignment, end to end (M26; lyrics-spec §4): transcription and forced alignment on the
// **vocal stem** — the single biggest accuracy factor; aligners degrade badly on full mixes.
//
//   1. find the track's vocal stem (kept as FLAC by the stem job, §4.48) — no stems, no alignment:
//      the caller is told to separate first, never silently given a mix alignment;
//   2. transcribe it (faster-whisper, Whisper medium, with voice-activity filtering);
//   3. **align mode** (text given): match the lyric lines to the transcript's words to find each
//      line's window (align-match.ts); **transcribe mode** (no text): cut the transcript into lines;
//   4. force-align each line's text inside its window (WhisperX / wav2vec2), line by line;
//   5. the sanity pass (align-result.ts): broken output is rejected and reported, never written.
//
// Only English alignment is provisioned (setup's lyrics tier). Another language is refused with
// the fallback the spec names — tap-to-sync — rather than a download (CLAUDE.md #3).
//
// Plain Node, like the stem job: tested with a fake sidecar, run by the main process with the real
// one through the GPU queue (M28).

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { decodeMono48k } from '../analysis/decode.ts';
import { TICKS_PER_SECOND, sourceToTimelineSeconds, type AudioPlacement } from '../engine/core/time.ts';
import { linesFromTranscript, matchLyricsToTranscript, type TranscriptSegment } from '../lyrics/align-match.ts';
import { alignedLineFrom, type AlignerWord } from '../lyrics/align-result.ts';
import type { VocalSegment } from '../lyrics/vocal-segments.ts';
import type { AlignedLine } from '../project/lyrics-commands.ts';
import type { StemSidecar } from './stems.ts';

/**
 * The alignment model file per language, as setup provisions them into vendor/models/align (the
 * lyrics tier: English; the extras tier: French, German, Spanish, Italian). WhisperX finds each by
 * this file name in the folder it is given.
 */
export const ALIGN_MODEL_FILES: Readonly<Record<string, string>> = {
  en: 'wav2vec2_fairseq_base_ls960_asr_ls960.pth',
  fr: 'wav2vec2_voxpopuli_base_10k_asr_fr.pt',
  de: 'wav2vec2_voxpopuli_base_10k_asr_de.pt',
  es: 'wav2vec2_voxpopuli_base_10k_asr_es.pt',
  it: 'wav2vec2_voxpopuli_base_10k_asr_it.pt',
};

/** The languages whose alignment model is installed in `alignDir`. */
export function installedAlignLanguages(alignDir: string): string[] {
  return Object.entries(ALIGN_MODEL_FILES).filter(([, file]) => existsSync(join(alignDir, file))).map(([language]) => language);
}

export type LyricsAlignMode = 'align' | 'transcribe';

export interface LyricsAlignProgress {
  readonly stage: 'decoding' | 'transcribing' | 'aligning';
  /** Overall 0..1. */
  readonly fraction: number;
}

export interface LyricsAlignOptions {
  readonly ffmpegExe: string;
  readonly sidecar: StemSidecar;
  /** `<root>/<audioHash>/<model>/vocals.flac`, as the stem job writes it. */
  readonly stemsRoot: string;
  readonly stemModel: string;
  readonly audioPath: string;
  readonly whisperDir: string;
  readonly alignDir: string;
  readonly language: string;
  readonly mode: LyricsAlignMode;
  /** Align mode: the lines to align (unlocked ones — the caller leaves locked lines out). */
  readonly lines: readonly { readonly id: string; readonly text: string }[];
  readonly placement: AudioPlacement;
  /** Singing on the vocal stem, timeline seconds, for the sanity pass. */
  readonly vocalSegments?: readonly VocalSegment[];
  readonly onProgress?: (progress: LyricsAlignProgress) => void;
  readonly signal?: AbortSignal;
}

export interface CreatedLine extends Omit<AlignedLine, 'lineId'> {
  readonly text: string;
}

export interface LyricsAlignResult {
  readonly mode: LyricsAlignMode;
  /** What Whisper heard the language as. */
  readonly detectedLanguage: string;
  /** Align mode: timings for existing lines. */
  readonly aligned: readonly AlignedLine[];
  /** Transcribe mode: new lines with their timings. */
  readonly created: readonly CreatedLine[];
  /** Lines the sanity pass refused, with why: they keep what they had. */
  readonly rejected: readonly { readonly lineId: string | null; readonly text: string; readonly reason: string }[];
  /** Align mode: lines no window was found for (a repeat Whisper did not hear, text not sung). */
  readonly unplaced: readonly string[];
}

/** The track has no vocal stem yet. The studio offers to separate first. */
export class LyricsNeedStemsError extends Error {
  override readonly name = 'LyricsNeedStemsError';
}

export class LyricsLanguageError extends Error {
  override readonly name = 'LyricsLanguageError';
}

/** Where the vocal stem of a track is, once separated — or why not. */
export async function vocalStemPath(ffmpegExe: string, stemsRoot: string, stemModel: string, audioPath: string): Promise<string> {
  const decoded = await decodeMono48k(ffmpegExe, audioPath);
  const path = join(stemsRoot, decoded.pcmSha256, stemModel, 'vocals.flac');
  if (!existsSync(path)) {
    throw new LyricsNeedStemsError('Alignment runs on the isolated vocals, and this track has not been separated into stems yet. Separate stems (Audio panel) first.');
  }
  return path;
}

export async function alignLyrics(options: LyricsAlignOptions): Promise<LyricsAlignResult> {
  const { signal } = options;
  const language = options.language.toLowerCase().split(/[-_]/)[0] ?? '';
  const installed = installedAlignLanguages(options.alignDir);
  if (!installed.includes(language)) {
    const more = language === 'en'
      ? ' It comes with Lyric transcription and timing, in Settings → Components.'
      : ALIGN_MODEL_FILES[language] !== undefined ? ' Its model is optional: Settings → Components installs it.' : '';
    throw new LyricsLanguageError(`Word alignment is installed for ${installed.join(', ') || 'no language'}, not “${options.language}”.${more} Tap-to-sync works for every language.`);
  }
  if (options.mode === 'align' && options.lines.length === 0) {
    throw new Error('There are no unlocked lines with text to align.');
  }
  const report = (stage: LyricsAlignProgress['stage'], within: number) => {
    const [from, span] = stage === 'decoding' ? [0, 0.05] : stage === 'transcribing' ? [0.05, 0.55] : [0.6, 0.4];
    options.onProgress?.({ stage, fraction: from + span * Math.min(1, Math.max(0, within)) });
  };
  const withSignal = signal === undefined ? {} : { signal };

  report('decoding', 0);
  const audio = await vocalStemPath(options.ffmpegExe, options.stemsRoot, options.stemModel, options.audioPath);
  report('decoding', 1);

  const transcript = await options.sidecar.request('transcribe', { audio, modelDir: options.whisperDir, language, device: 'cuda' }, {
    onProgress: (p) => report('transcribing', p.fraction ?? 0),
    ...withSignal,
  }) as unknown as { language: string; duration: number; segments: TranscriptSegment[] };

  // The windows to align in, and the text for each.
  let windows: { id: string; text: string; start: number; end: number }[];
  let unplaced: readonly string[] = [];
  if (options.mode === 'align') {
    const matched = matchLyricsToTranscript(options.lines, transcript.segments, { duration: transcript.duration });
    windows = matched.windows.map((w) => ({ id: w.lineId, text: w.text, start: w.start, end: w.end }));
    unplaced = matched.unplaced;
  } else {
    windows = linesFromTranscript(transcript.segments).map((line, i) => ({
      id: `new-${i}`,
      text: line.text,
      start: Math.max(0, line.start - 0.35),
      end: Math.min(transcript.duration, line.end + 0.35),
    }));
  }

  const alignment = windows.length === 0
    ? { lines: [] as { id: string; words: AlignerWord[]; error: string | null }[] }
    : await options.sidecar.request('align', { audio, language, modelDir: options.alignDir, device: 'cuda', segments: windows }, {
      onProgress: (p) => report('aligning', p.fraction ?? 0),
      ...withSignal,
    }) as unknown as { lines: { id: string; words: AlignerWord[]; error: string | null }[] };

  const byId = new Map(alignment.lines.map((line) => [line.id, line]));
  const aligned: AlignedLine[] = [];
  const created: CreatedLine[] = [];
  const rejected: { lineId: string | null; text: string; reason: string }[] = [];
  const resultOptions = { placement: options.placement, ...(options.vocalSegments === undefined ? {} : { vocalSegments: options.vocalSegments }) };
  for (const window of windows) {
    const line = byId.get(window.id);
    const isNew = options.mode === 'transcribe';
    if (line === undefined || line.error !== null) {
      rejected.push({ lineId: isNew ? null : window.id, text: window.text, reason: line?.error ?? 'the aligner returned nothing for it' });
      continue;
    }
    const outcome = alignedLineFrom(window.id, window.text, line.words, resultOptions);
    if (!outcome.ok) {
      if (isNew) {
        // A transcribed line that will not align still exists: keep it with its window's time.
        const toTicks = (s: number) => Math.round(sourceToTimelineSeconds(s, options.placement) * TICKS_PER_SECOND);
        created.push({ text: window.text, startTicks: toTicks(window.start + 0.35), endTicks: toTicks(window.end - 0.35), words: [], confidence: null });
      }
      rejected.push({ lineId: isNew ? null : window.id, text: window.text, reason: outcome.reason });
      continue;
    }
    if (isNew) {
      const { lineId: _id, ...timing } = outcome.line;
      created.push({ ...timing, text: window.text });
    } else {
      aligned.push(outcome.line);
    }
  }
  return { mode: options.mode, detectedLanguage: transcript.language, aligned, created, rejected, unplaced };
}
