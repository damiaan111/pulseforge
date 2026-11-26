// Batch mode (S13, export-spec §12 "overnight batch"): drop tracks in, and each becomes an
// auto-directed project and a queued render. This file is the pure part — what each track will be
// called, where its project and video go, and which seed it is directed with — so the studio, the
// CLI and the tests agree on it exactly.

import { hash32 } from '../engine/core/prng.ts';
import { suggestedOutputName, type ExportPreset } from '../export/export-presets.ts';

/** Audio the batch accepts: what the import dialog offers. */
export const BATCH_AUDIO_EXTENSIONS: readonly string[] = ['.mp3', '.wav', '.flac', '.m4a', '.ogg', '.opus', '.aac', '.aiff'];

export function isBatchAudio(path: string): boolean {
  const dot = path.lastIndexOf('.');
  return dot >= 0 && BATCH_AUDIO_EXTENSIONS.includes(path.slice(dot).toLowerCase());
}

export interface BatchOptions {
  /** One folder receives every project and every video. */
  readonly outDir: string;
  readonly preset: ExportPreset;
  /** The batch's master seed; each track draws its own from it and its name. */
  readonly seed: number;
  /** An explicit template for every track, or null for each track's best match. */
  readonly templateId: string | null;
}

export interface BatchTrack {
  readonly audioPath: string;
  /** The project's name and the stem of both file names: the track's file name, made unique. */
  readonly name: string;
  readonly projectPath: string;
  readonly outputPath: string;
  readonly seed: number;
}

/** The last path segment, either separator (a batch plan is built in the renderer as well as in Node). */
function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function joinPath(folder: string, name: string): string {
  const separator = folder.includes('\\') && !folder.includes('/') ? '\\' : '/';
  return folder.endsWith('/') || folder.endsWith('\\') ? folder + name : folder + separator + name;
}

/** Characters Windows refuses in a file name, and control characters, removed. */
function cleanName(name: string): string {
  const clean = [...name].filter((ch) => ch.charCodeAt(0) >= 32 && !'<>:"/\\|?*'.includes(ch)).join('').trim().replace(/[. ]+$/, '');
  return clean === '' ? 'Untitled' : clean;
}

/**
 * One entry per track, in the order given. Two tracks with the same file name (from different
 * folders) get "name (2)", so neither project nor video overwrites the other. A track listed twice
 * is kept twice: it is asked for, so it is rendered, and the names keep them apart.
 */
export function planBatch(tracks: readonly string[], options: BatchOptions): BatchTrack[] {
  const used = new Map<string, number>();
  return tracks.map((audioPath) => {
    const base = cleanName(fileName(audioPath).replace(/\.[^.]+$/, ''));
    const count = (used.get(base.toLowerCase()) ?? 0) + 1;
    used.set(base.toLowerCase(), count);
    const name = count === 1 ? base : `${base} (${count})`;
    return {
      audioPath,
      name,
      projectPath: joinPath(options.outDir, `${name}.pvproj`),
      outputPath: joinPath(options.outDir, suggestedOutputName(name, options.preset)),
      // Seeds are 1..2^31−2, as the studio's are; the same batch seed and name give the same look.
      seed: 1 + (hash32(options.seed, 'batch', name) % 2_147_483_646),
    };
  });
}
