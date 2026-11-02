// A song-shaped fixture for the auto-director: the reference beat track (120 BPM) shaped into a
// quiet intro, a build, a loud main part, a breakdown and a loud return, so section detection has
// structure to find. Analysed once per test file (a minute and a half of audio is a second or two).

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { analyzeMix } from '../../src/analysis/analyze.ts';
import { synthesizeTestTrack } from '../../src/analysis/reference-track.ts';
import { detectSections } from '../../src/analysis/sections.ts';
import { buildTrackDigest, styleVector } from '../../src/director/digest.ts';
import type { DirectorInput } from '../../src/director/direct.ts';
import type { DirectorModules } from '../../src/director/match.ts';
import { parseTemplate, type Template } from '../../src/director/template.ts';
import { BUILTIN_MODULES } from '../../src/engine/engine.ts';
import type { AnalysisSet } from '../../src/engine/core/analysis.ts';
import { createDocument } from '../../src/project/create.ts';
import type { ProjectDocument } from '../../src/project/document.ts';

export const TEMPLATE_DIR = resolve(import.meta.dirname, '..', '..', 'templates', 'builtin');

export function builtinTemplateTexts(): { file: string; raw: unknown }[] {
  return readdirSync(TEMPLATE_DIR).filter((f) => f.endsWith('.json')).sort()
    .map((file) => ({ file, raw: JSON.parse(readFileSync(join(TEMPLATE_DIR, file), 'utf8')) as unknown }));
}

export function builtinTemplates(): Template[] {
  return builtinTemplateTexts().map(({ raw }) => parseTemplate(raw).template);
}

export const MODULES: DirectorModules = {
  get: (id) => BUILTIN_MODULES.find((m) => m.manifest.id === id)?.manifest,
  all: BUILTIN_MODULES.map((m) => m.manifest),
};

/** Loudness over the song, piecewise: [until second, gain]. */
const SHAPE: readonly (readonly [number, number])[] = [[20, 0.12], [34, 0.45], [60, 1], [76, 0.2], [96, 1]];
export const SONG_SECONDS = 96;

let cached: { analysis: AnalysisSet; onsets: readonly number[]; beats: readonly number[]; sections: ReturnType<typeof detectSections>['sections'] } | undefined;

export function song() {
  if (cached !== undefined) return cached;
  const pcm = synthesizeTestTrack(SONG_SECONDS);
  for (let i = 0; i < pcm.length; i += 1) {
    const t = i / 48_000;
    pcm[i] = (pcm[i] as number) * (SHAPE.find(([until]) => t < until)?.[1] ?? 1);
  }
  const { analysis, beatGrid, onsetTimes } = analyzeMix(pcm);
  const mix = analysis.sources.get('mix')!;
  const sections = detectSections(mix, SONG_SECONDS).sections;
  cached = { analysis: { ...analysis, beatGrid }, onsets: onsetTimes, beats: beatGrid.beats, sections };
  return cached;
}

/** A project with the song on the timeline, ready to direct. */
export function songDocument(overrides: Partial<ProjectDocument> = {}): ProjectDocument {
  const base = createDocument({ name: 'Night Drive', id: '0000000000P000000000000001', timestamp: '2026-09-25T00:00:00.000Z' });
  return {
    ...base,
    audio: { ...base.audio, path: 'C:/music/night-drive.wav', durationTicks: SONG_SECONDS * 48_000 },
    ...overrides,
  };
}

export function directorInput(document: ProjectDocument = songDocument(), templates: readonly Template[] = builtinTemplates()): DirectorInput {
  const s = song();
  const digest = buildTrackDigest({ analysis: s.analysis, durationSeconds: SONG_SECONDS, onsetTimes: s.onsets, sections: s.sections });
  return {
    document,
    templates,
    modules: MODULES,
    digest,
    style: styleVector(digest),
    analysis: s.analysis,
    beats: s.beats,
    onsets: s.onsets,
    vocalSegments: [],
    title: document.name,
    milkdropPresets: [],
  };
}
