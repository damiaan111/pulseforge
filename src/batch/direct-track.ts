// One track of a batch (S13): decode, analyse (through the studio's cache, so a track the studio has
// seen is a hit and the other way round), optionally separate stems first, auto-direct, and write
// the project beside the videos. Plain Node, so the studio's main process and `npm run batch` run
// the same code.

import { AnalysisCache } from '../analysis/cache.ts';
import { analyzeCached } from '../analysis/cached.ts';
import { decodeMono48k } from '../analysis/decode.ts';
import { cacheOptionsFor } from '../analysis/project-settings.ts';
import { direct } from '../director/direct.ts';
import { buildTrackDigest, styleVector } from '../director/digest.ts';
import type { DirectorModules } from '../director/match.ts';
import type { Template } from '../director/template.ts';
import type { ExportPreset } from '../export/export-presets.ts';
import { detectVocalSegments } from '../lyrics/vocal-segments.ts';
import { withStoredPaths } from '../project/asset-paths.ts';
import { DEFAULT_ANALYSIS_SETTINGS, createDocument } from '../project/create.ts';
import type { ProjectDocument } from '../project/document.ts';
import { stringifyDocument } from '../project/serialize.ts';
import { writeProjectText } from '../shell/project-io.ts';
import type { BatchTrack } from './plan.ts';

export interface DirectTrackOptions {
  readonly ffmpegExe: string;
  readonly cacheRoot: string;
  readonly templates: readonly Template[];
  readonly modules: DirectorModules;
  /** The canvas follows the preset's shape, so the director lays out for the frame it will render. */
  readonly preset: ExportPreset;
  readonly templateId: string | null;
  /** Separates stems before directing (stem-driven templates read better); absent skips it. */
  readonly separateStems?: (audioPath: string) => Promise<void>;
  readonly appVersion?: string;
}

export interface DirectedTrack {
  readonly document: ProjectDocument;
  readonly templateName: string;
  /** The roll's one-line summary ("Neon Pulse, split palette, …"). */
  readonly summary: string;
  /** Anything worth telling the user that did not stop the track: a failed separation, say. */
  readonly notes: readonly string[];
  readonly durationSeconds: number;
}

export async function directTrack(track: BatchTrack, options: DirectTrackOptions): Promise<DirectedTrack> {
  const notes: string[] = [];
  if (options.separateStems !== undefined) {
    try {
      await options.separateStems(track.audioPath);
    } catch (error) {
      // Stems make some templates better, but a track without them still makes a video.
      notes.push(`Stems were not separated (${error instanceof Error ? error.message : String(error)}); directed from the mix alone.`);
    }
  }

  const settings = DEFAULT_ANALYSIS_SETTINGS;
  const decoded = await decodeMono48k(options.ffmpegExe, track.audioPath);
  const cache = new AnalysisCache({ root: options.cacheRoot });
  const result = await analyzeCached(decoded.pcm, cache, { ...cacheOptionsFor(settings), audioHash: decoded.pcmSha256 });
  const durationSeconds = decoded.pcm.length / 48_000;

  const base = createDocument({
    name: track.name,
    seed: track.seed,
    ...(options.appVersion === undefined ? {} : { appVersion: options.appVersion }),
    ...(options.preset.size === null ? {} : { canvas: options.preset.size }),
  });
  const document: ProjectDocument = { ...base, audio: { ...base.audio, path: track.audioPath, durationTicks: decoded.pcm.length } };

  const digest = buildTrackDigest({ analysis: result.analysis, durationSeconds, onsetTimes: result.onsetTimes, sections: result.sections });
  const vocals = result.analysis.sources.get('vocals')?.features.get('rms');
  const directed = direct({
    document,
    templates: options.templates,
    modules: options.modules,
    digest,
    style: styleVector(digest),
    analysis: result.analysis,
    beats: result.beatGrid?.beats ?? [],
    onsets: result.onsetTimes,
    vocalSegments: vocals === undefined ? [] : detectVocalSegments(vocals.data, vocals.rate),
    title: track.name,
  }, { seed: track.seed, templateId: options.templateId });

  await writeProjectText(track.projectPath, stringifyDocument(withStoredPaths(directed.document, track.projectPath)));
  return { document: directed.document, templateName: directed.template.name, summary: directed.roll.summary, notes, durationSeconds };
}
