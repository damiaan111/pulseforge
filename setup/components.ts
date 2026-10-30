import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEMUCS_HTDEMUCS, EXTRA_ARTEFACTS, FALLBACK_FONTS, FFMPEG, FONT_INTER, LYRICS_MODELS, PYTHON, PYTHON_PACKAGES, PYTHON_PACKAGES_BEATS,
  PYTHON_PACKAGES_LYRICS, UV, type ExtraId, type Tier,
} from './manifest.ts';
import { DEFAULT_FONT_FILE, FFMPEG_EXE, MODELS, VENDOR } from './lib/paths.ts';

// What a person chooses from (the first-run chooser, Settings, `--components`), as opposed to the
// tiers and steps that are how those choices get installed. One list, so the chooser, the command
// line and the install agree on what exists, what it costs and what it depends on.

export type ComponentGroup = 'required' | 'feature' | 'model';

export interface Component {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly group: ComponentGroup;
  /** Rough, for the chooser: the Python wheels are not known to the byte before they are resolved. */
  readonly bytes: number;
  readonly license: string;
  /** Other components this one cannot work without; choosing it chooses them. */
  readonly requires: readonly string[];
  /** The NVIDIA driver it needs (CUDA), or null when it runs on the CPU. */
  readonly minDriver: number | null;
  readonly nonCommercial: boolean;
}

export const NON_COMMERCIAL_NOTICE = 'These alignment models are licensed CC BY-NC 4.0 by their authors: non-commercial use only. '
  + 'They time your lyrics inside the app and are not part of a video, but videos you make for money may fall under that licence. '
  + 'Check the licence before using them commercially. English alignment is not affected.';

const python = PYTHON.sizeBytes + UV.sizeBytes;
const sum = (files: readonly { readonly sizeBytes: number }[]) => files.reduce((total, file) => total + file.sizeBytes, 0);

const EXTRA_TEXT: Readonly<Record<ExtraId, { readonly title: string; readonly summary: string; readonly requires: string }>> = {
  htdemucs_ft: { title: 'Finer stems (htdemucs_ft)', summary: 'Four fine-tuned Demucs models: cleaner separation in about 1.7× the time.', requires: 'stems' },
  htdemucs_6s: { title: 'Six stems (htdemucs_6s)', summary: 'Guitar and piano split out of "other", as stems of their own.', requires: 'stems' },
  'whisper-large-v3': { title: 'Larger transcription model (Whisper large-v3)', summary: 'Hears more of the words, in more time and more video memory.', requires: 'lyrics' },
  'align-fr': { title: 'Word alignment: French', summary: 'Word-by-word lyric timing for French.', requires: 'lyrics' },
  'align-de': { title: 'Word alignment: German', summary: 'Word-by-word lyric timing for German.', requires: 'lyrics' },
  'align-es': { title: 'Word alignment: Spanish', summary: 'Word-by-word lyric timing for Spanish.', requires: 'lyrics' },
  'align-it': { title: 'Word alignment: Italian', summary: 'Word-by-word lyric timing for Italian.', requires: 'lyrics' },
};

export const COMPONENTS: readonly Component[] = [
  {
    id: 'core',
    title: 'Pulseforge essentials',
    summary: 'FFmpeg for audio and video, and the fonts for every script. The app needs these.',
    group: 'required',
    bytes: FFMPEG.sizeBytes + FONT_INTER.sizeBytes + sum(FALLBACK_FONTS),
    license: 'FFmpeg GPL; fonts OFL-1.1',
    requires: [],
    minDriver: null,
    nonCommercial: false,
  },
  {
    id: 'stems',
    title: 'Stem separation',
    summary: 'Splits a song into vocals, drums, bass and the rest, so visuals can react to each one. Needed for karaoke export.',
    group: 'feature',
    bytes: python + PYTHON_PACKAGES.approxWheelhouseBytes + DEMUCS_HTDEMUCS.sizeBytes,
    license: 'Demucs MIT; PyTorch BSD; NVIDIA CUDA libraries under their own terms',
    requires: [],
    minDriver: PYTHON_PACKAGES.minDriverMajor,
    nonCommercial: false,
  },
  {
    id: 'lyrics',
    title: 'Lyric transcription and timing',
    summary: 'Writes down the lyrics and times them word by word, in English. Other languages are below.',
    group: 'feature',
    bytes: python + PYTHON_PACKAGES.approxWheelhouseBytes + PYTHON_PACKAGES_LYRICS.approxWheelhouseBytes + sum(LYRICS_MODELS),
    license: 'WhisperX BSD; Whisper MIT; wav2vec2 MIT',
    requires: [],
    minDriver: PYTHON_PACKAGES.minDriverMajor,
    nonCommercial: false,
  },
  {
    id: 'beats',
    title: 'Beat refinement',
    summary: 'Follows a tempo that moves: rubato, live drums, sparse percussion. Runs on the CPU.',
    group: 'feature',
    bytes: python + PYTHON_PACKAGES_BEATS.approxWheelhouseBytes,
    license: 'librosa ISC',
    requires: [],
    minDriver: null,
    nonCommercial: false,
  },
  ...(Object.keys(EXTRA_TEXT) as ExtraId[]).map((id): Component => ({
    id,
    title: EXTRA_TEXT[id].title,
    summary: EXTRA_TEXT[id].summary,
    group: 'model',
    bytes: sum(EXTRA_ARTEFACTS[id]),
    license: EXTRA_ARTEFACTS[id][0]?.license ?? '',
    requires: [EXTRA_TEXT[id].requires],
    minDriver: PYTHON_PACKAGES.minDriverMajor,
    nonCommercial: id.startsWith('align-'),
  })),
];

const BY_ID = new Map(COMPONENTS.map((component) => [component.id, component]));

export interface ResolvedChoice {
  /** What was asked for, plus the essentials and everything those need. */
  readonly components: readonly Component[];
  readonly tiers: readonly Tier[];
  readonly extras: readonly ExtraId[];
}

/** The whole of a choice. Throws a sentence for a name that does not exist. */
export function resolveChoice(ids: readonly string[]): ResolvedChoice {
  const chosen = new Set(['core']);
  const add = (id: string) => {
    const component = BY_ID.get(id);
    if (component === undefined) throw new Error(`Unknown component "${id}". Available: ${COMPONENTS.map((c) => c.id).join(', ')}.`);
    chosen.add(id);
    component.requires.forEach(add);
  };
  ids.forEach(add);
  const components = COMPONENTS.filter((c) => chosen.has(c.id));
  const extras = components.filter((c) => c.group === 'model').map((c) => c.id as ExtraId);
  const tiers = components.filter((c) => c.group !== 'model').map((c) => c.id as Tier);
  return { components, tiers: extras.length > 0 ? [...tiers, 'extras'] : tiers, extras };
}

/** Whether a component is on disk. Files, not the lock: a person deleting a folder should see it go. */
export function componentInstalled(id: string, exists: (path: string) => boolean = existsSync): boolean {
  const marker = (name: string) => exists(join(VENDOR, 'python', name));
  if (id === 'core') return exists(FFMPEG_EXE) && exists(DEFAULT_FONT_FILE);
  if (id === 'stems') return marker('.pulseforge-env.json') && exists(join(MODELS, 'demucs', DEMUCS_HTDEMUCS.fileName));
  if (id === 'lyrics') return marker('.pulseforge-lyrics-env.json') && LYRICS_MODELS.every((file) => exists(join(VENDOR, file.installDir, file.fileName)));
  if (id === 'beats') return marker('.pulseforge-beats-env.json');
  const files = EXTRA_ARTEFACTS[id as ExtraId];
  return files !== undefined && files.every((file) => exists(join(VENDOR, file.installDir, file.fileName)));
}
