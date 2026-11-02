// Batch mode (S13): the plan (names, files, seeds), the CLI's arguments and track collection, and one
// track directed end to end into a project file that opens again.

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FFMPEG_EXE, ROOT } from '../../setup/lib/paths.ts';
import { synthesizeTestTrack } from '../../src/analysis/reference-track.ts';
import { directTrack } from '../../src/batch/direct-track.ts';
import { isBatchAudio, planBatch } from '../../src/batch/plan.ts';
import { collectTracks, parseBatchArgs } from '../../src/cli/batch.ts';
import { loadTemplates } from '../../src/director/template-library.ts';
import { readTemplateFiles } from '../../src/director/template-store.ts';
import { BUILTIN_MODULES } from '../../src/engine/engine.ts';
import { encodeWavFloat32 } from '../../src/export/audio.ts';
import { findExportPreset } from '../../src/export/export-presets.ts';
import { withAbsolutePaths } from '../../src/project/asset-paths.ts';
import { loadDocument } from '../../src/project/load.ts';

const preset = findExportPreset('youtube-1080p')!;

describe('planBatch', () => {
  it('names each track after its file, one project and one video per track, in one folder', () => {
    const plan = planBatch(['C:/music/One.wav', 'D:\\other\\Two: live?.mp3'], { outDir: 'E:/out', preset, seed: 1, templateId: null });
    expect(plan.map((t) => t.name)).toEqual(['One', 'Two live']);
    expect(plan[0]).toMatchObject({ projectPath: 'E:/out/One.pvproj', outputPath: 'E:/out/One - youtube-1080p.mp4' });
  });

  it('keeps two tracks with the same name apart, and a track listed twice twice', () => {
    const plan = planBatch(['a/Song.wav', 'b/song.flac', 'a/Song.wav'], { outDir: 'out', preset, seed: 1, templateId: null });
    expect(plan.map((t) => t.name)).toEqual(['Song', 'song (2)', 'Song (3)']);
    expect(new Set(plan.map((t) => t.outputPath)).size).toBe(3);
  });

  it('draws each seed from the batch seed and the name: repeatable, and different per track', () => {
    const a = planBatch(['x/A.wav', 'x/B.wav'], { outDir: 'o', preset, seed: 7, templateId: null });
    const again = planBatch(['x/A.wav', 'x/B.wav'], { outDir: 'o', preset, seed: 7, templateId: null });
    const other = planBatch(['x/A.wav'], { outDir: 'o', preset, seed: 8, templateId: null });
    expect(a.map((t) => t.seed)).toEqual(again.map((t) => t.seed));
    expect(a[0]!.seed).not.toBe(a[1]!.seed);
    expect(other[0]!.seed).not.toBe(a[0]!.seed);
    for (const t of a) expect(t.seed).toBeGreaterThanOrEqual(1);
  });

  it('knows audio files by extension', () => {
    expect(['a.WAV', 'b.mp3', 'c.flac', 'desktop.ini', 'noext'].map(isBatchAudio)).toEqual([true, true, true, false, false]);
  });
});

describe('npm run batch arguments', () => {
  it('defaults, and every option', () => {
    const plain = parseBatchArgs(['tracks', '-o', 'out']);
    expect(plain).toMatchObject({ templateId: null, seed: 1, stems: false, motionBlur: undefined, directOnly: false });
    expect(plain.preset.id).toBe('youtube-1080p');
    const all = parseBatchArgs(['a.wav', 'b.wav', '-o', 'out', '--preset', 'shorts', '--template', 'neon-pulse', '--seed', '9', '--stems', '--motion-blur', '--seconds', '5', '--direct-only']);
    expect(all.inputs).toHaveLength(2);
    expect(all).toMatchObject({ templateId: 'neon-pulse', seed: 9, stems: true, seconds: 5, directOnly: true, motionBlur: { samples: 8, shutterDegrees: 180 } });
    expect(all.preset.id).toBe('shorts');
  });

  it('says what is missing or wrong', () => {
    expect(() => parseBatchArgs([])).toThrow(/No tracks/);
    expect(() => parseBatchArgs(['a.wav'])).toThrow(/No output folder/);
    expect(() => parseBatchArgs(['a.wav', '-o', 'o', '--preset', 'vhs'])).toThrow(/Unknown preset/);
  });
});

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pulseforge-batch-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('collectTracks', () => {
  it('takes files as given and the audio directly inside folders, and reports the rest', async () => {
    await mkdir(join(root, 'album'));
    for (const name of ['02 b.flac', '01 a.wav', 'cover.jpg']) await writeFile(join(root, 'album', name), '');
    await writeFile(join(root, 'single.mp3'), '');
    await writeFile(join(root, 'notes.txt'), '');
    const { tracks, skipped } = await collectTracks([join(root, 'single.mp3'), join(root, 'album'), join(root, 'notes.txt'), join(root, 'gone.wav')]);
    expect(tracks.map((t) => t.split(/[\\/]/).pop())).toEqual(['single.mp3', '01 a.wav', '02 b.flac']);
    expect(skipped).toHaveLength(2);
  });
});

describe.skipIf(!existsSync(FFMPEG_EXE))('directTrack', () => {
  it('writes an auto-directed project that opens again, pointing at its track', async () => {
    const audioPath = join(root, 'Reference Song.wav');
    const mono = synthesizeTestTrack(8);
    await writeFile(audioPath, encodeWavFloat32([mono, mono], 48_000));
    const library = loadTemplates(await readTemplateFiles({ builtin: join(ROOT, 'templates', 'builtin'), user: join(root, 'no-user-templates') }));
    const manifests = BUILTIN_MODULES.map((m) => m.manifest);
    const [track] = planBatch([audioPath], { outDir: join(root, 'out'), preset: findExportPreset('shorts')!, seed: 3, templateId: null });

    const directed = await directTrack(track!, {
      milkdropPresets: [],
      ffmpegExe: FFMPEG_EXE,
      cacheRoot: join(root, 'cache'),
      templates: library.templates.map((t) => t.template),
      modules: { get: (id) => manifests.find((m) => m.id === id), all: manifests },
      preset: findExportPreset('shorts')!,
      templateId: null,
      separateStems: async () => { throw new Error('no GPU here'); },
    });
    expect(directed.notes.join(' ')).toContain('no GPU here');

    const loaded = loadDocument(await readFile(track!.projectPath, 'utf8'));
    expect(loaded.issues).toEqual([]);
    const document = withAbsolutePaths(loaded.document, track!.projectPath);
    expect(document.name).toBe('Reference Song');
    expect(document.canvas).toMatchObject({ width: 1080, height: 1920 });
    expect(document.seed).toBe(track!.seed);
    expect(document.layers.length).toBeGreaterThan(0);
    expect(document.director?.current.summary).toBe(directed.summary);
    expect(document.audio.path.replace(/\\/g, '/')).toBe(audioPath.replace(/\\/g, '/'));
  }, 60_000);

  it('reports the fallback when a template wants its colours from an image a batch does not have', async () => {
    const audioPath = join(root, 'Colour Song.wav');
    const mono = synthesizeTestTrack(8);
    await writeFile(audioPath, encodeWavFloat32([mono, mono], 48_000));
    const library = loadTemplates(await readTemplateFiles({ builtin: join(ROOT, 'templates', 'builtin'), user: join(root, 'no-user-templates') }));
    const templates = library.templates.map(({ template }) => ({ ...template, palette: { ...template.palette, strategy: 'derive-from-image' as const } }));
    const manifests = BUILTIN_MODULES.map((m) => m.manifest);
    const [track] = planBatch([audioPath], { outDir: join(root, 'out'), preset: findExportPreset('youtube-1080p')!, seed: 3, templateId: 'tpl.neon.pulse' });
    const directed = await directTrack(track!, {
      milkdropPresets: [],
      ffmpegExe: FFMPEG_EXE,
      cacheRoot: join(root, 'cache'),
      templates,
      modules: { get: (id) => manifests.find((m) => m.id === id), all: manifests },
      preset: findExportPreset('youtube-1080p')!,
      templateId: 'tpl.neon.pulse',
    });
    expect(directed.notes.join(' ')).toContain('generated them from the track instead');
    expect(directed.document.palette.colors.length).toBeGreaterThan(0);
  }, 60_000);
});
