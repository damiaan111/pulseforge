// `npm run batch -- <tracks or folders…> -o <folder>` — batch mode (PROJECT.md S13, export-spec §12).
//
// "Drop 10 tracks in, auto-direct and render them all overnight." Every track becomes a project
// (auto-directed, saved as `<name>.pvproj` so it can be opened and changed later) and a video
// beside it, rendered by the same pipeline as `npm run render` and the studio's queue. All tracks
// are directed first — a bad file shows up in the first minute, not at 3 a.m. — and then rendered
// one after another. A track that fails is reported and the batch carries on; the summary, and
// `batch-report.json` in the output folder, list every track and what became of it.
//
// Usage:
//   npm run batch -- <track or folder>… -o <folder> [options]
//
//   --preset ID          an export preset (default youtube-1080p); the canvas follows its shape
//   --template ID        one template for every track (default: each track's best match)
//   --seed N             the batch seed (default 1); each track draws its own from it and its name
//   --stems              separate stems first (Demucs on the GPU); stem-driven looks read better
//   --motion-blur        8 subframes at a 180° shutter (export-spec §9)
//   --seconds N          render only the first N seconds of each (a quick look at a batch)
//   --direct-only        write the projects, render nothing

import { existsSync, statSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { pythonEnv } from '../../setup/lib/env.ts';
import { FFMPEG_EXE, MODELS, MODULES_DIR, PYTHON_EXE, ROOT } from '../../setup/lib/paths.ts';
import { directTrack, type DirectedTrack } from '../batch/direct-track.ts';
import { isBatchAudio, planBatch, type BatchTrack } from '../batch/plan.ts';
import { loadTemplates } from '../director/template-library.ts';
import { readTemplateFiles } from '../director/template-store.ts';
import { MOTION_BLUR_DEFAULT, type MotionBlur } from '../engine/core/time.ts';
import { BUILTIN_MODULES } from '../engine/engine.ts';
import { shaderModuleDefinition } from '../engine/modules/shader-module.ts';
import { EXPORT_PRESETS, findExportPreset, type ExportPreset } from '../export/export-presets.ts';
import { renderDocument } from '../export/render-document.ts';
import { separateStems } from '../ml/stems.ts';
import { SidecarSupervisor, spawnPythonSidecar } from '../ml/supervisor.ts';
import { scanModules } from '../modules-folder/scan.ts';
import { DEFAULT_ANALYSIS_SETTINGS } from '../project/create.ts';
import { CliError } from './render.ts';

export interface BatchCliOptions {
  readonly inputs: readonly string[];
  readonly outDir: string;
  readonly preset: ExportPreset;
  readonly templateId: string | null;
  readonly seed: number;
  readonly stems: boolean;
  readonly motionBlur: MotionBlur | undefined;
  readonly seconds: number | undefined;
  readonly directOnly: boolean;
}

const BOOLEAN_FLAGS = new Set(['--stems', '--motion-blur', '--direct-only']);

export function parseBatchArgs(argv: readonly string[]): BatchCliOptions {
  const inputs: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (BOOLEAN_FLAGS.has(arg)) {
      flags.set(arg.slice(2), 'true');
    } else if (arg.startsWith('-')) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('-')) throw new CliError(`${arg} needs a value`);
      flags.set(arg.replace(/^--?/, ''), value);
      i += 1;
    } else {
      inputs.push(arg);
    }
  }
  if (inputs.length === 0) throw new CliError('No tracks given.', ['npm run batch -- path/to/tracks -o out/batch']);
  const out = flags.get('o') ?? flags.get('out');
  if (out === undefined) throw new CliError('No output folder given.', ['Add -o <folder>: every project and video goes there']);
  const presetId = flags.get('preset') ?? 'youtube-1080p';
  const preset = findExportPreset(presetId);
  if (preset === undefined) throw new CliError(`Unknown preset "${presetId}".`, [`Use one of ${EXPORT_PRESETS.map((p) => p.id).join(', ')}`]);
  const seed = Number(flags.get('seed') ?? '1');
  if (!Number.isSafeInteger(seed)) throw new CliError(`--seed must be a whole number, got "${flags.get('seed') ?? ''}"`);
  const secondsFlag = flags.get('seconds');
  const seconds = secondsFlag === undefined ? undefined : Number(secondsFlag);
  if (seconds !== undefined && (!Number.isFinite(seconds) || seconds <= 0)) throw new CliError(`--seconds must be a positive number, got "${secondsFlag}"`);
  return {
    inputs: inputs.map((p) => resolve(p)),
    outDir: resolve(out),
    preset,
    templateId: flags.get('template') ?? null,
    seed,
    stems: flags.has('stems'),
    motionBlur: flags.has('motion-blur') ? MOTION_BLUR_DEFAULT : undefined,
    seconds,
    directOnly: flags.has('direct-only'),
  };
}

/** Files as given, and the audio files directly inside any folder given (sorted), in order. */
export async function collectTracks(inputs: readonly string[]): Promise<{ tracks: string[]; skipped: string[] }> {
  const tracks: string[] = [];
  const skipped: string[] = [];
  for (const input of inputs) {
    if (!existsSync(input)) {
      skipped.push(`${input}: not found`);
    } else if (statSync(input).isDirectory()) {
      const names = (await readdir(input)).filter(isBatchAudio).sort((a, b) => a.localeCompare(b));
      if (names.length === 0) skipped.push(`${input}: no audio files in this folder`);
      tracks.push(...names.map((n) => join(input, n)));
    } else if (isBatchAudio(input)) {
      tracks.push(input);
    } else {
      skipped.push(`${input}: not an audio file this app reads`);
    }
  }
  return { tracks, skipped };
}

interface TrackOutcome {
  readonly track: BatchTrack;
  directed?: DirectedTrack;
  status: 'directed' | 'done' | 'failed';
  error?: string;
  renderSeconds?: number;
}

export async function batch(argv: readonly string[]): Promise<number> {
  const options = parseBatchArgs(argv);
  if (!existsSync(FFMPEG_EXE)) throw new CliError('The vendored FFmpeg is missing.', ['Run `npm run setup`']);
  const { tracks, skipped } = await collectTracks(options.inputs);
  for (const line of skipped) console.warn(`  skipped ${line}`);
  if (tracks.length === 0) throw new CliError('No tracks to render.', ['Give audio files, or folders that contain them']);

  const templatesFolder = process.env['PULSEFORGE_TEMPLATES'] ?? join(homedir(), 'Documents', 'Pulseforge', 'Templates');
  const library = loadTemplates(await readTemplateFiles({ builtin: join(ROOT, 'templates', 'builtin'), user: templatesFolder }));
  for (const p of library.problems) console.warn(`  template problem: ${p.path}: ${p.message}`);
  const templates = library.templates.map((t) => t.template);
  if (options.templateId !== null && !templates.some((t) => t.id === options.templateId)) {
    throw new CliError(`Unknown template "${options.templateId}".`, [`Use one of ${templates.map((t) => t.id).join(', ')}`, 'Or leave --template out for each track\'s best match']);
  }
  const scanned = await scanModules(MODULES_DIR, new Set(BUILTIN_MODULES.map((m) => m.manifest.id)));
  // Drop-in modules count: a template may name one (M35), and the render path compiles them the same way.
  const manifests = [...BUILTIN_MODULES, ...scanned.modules.map(shaderModuleDefinition)].map((m) => m.manifest);
  const byId = new Map(manifests.map((m) => [m.id, m]));
  const modules = { get: (id: string) => byId.get(id), all: manifests };

  const plan = planBatch(tracks, { outDir: options.outDir, preset: options.preset, seed: options.seed, templateId: options.templateId });
  const cacheRoot = join(ROOT, 'cache');
  console.log(`${plan.length} track(s) → ${options.outDir} (${options.preset.label}${options.motionBlur === undefined ? '' : ', motion blur'})`);

  let counter = 0;
  const supervisor = options.stems
    ? new SidecarSupervisor({ spawn: spawnPythonSidecar(PYTHON_EXE, join(ROOT, 'python'), pythonEnv()), newId: () => `b${counter++}`, idleTimeoutMs: 0 })
    : undefined;
  const outcomes: TrackOutcome[] = plan.map((track) => ({ track, status: 'failed' }));
  try {
    // 1. Direct every track first: fast, and it surfaces a bad file before the long part starts.
    for (const outcome of outcomes) {
      const started = performance.now();
      try {
        outcome.directed = await directTrack(outcome.track, {
          ffmpegExe: FFMPEG_EXE,
          cacheRoot,
          templates,
          modules,
          preset: options.preset,
          templateId: options.templateId,
          ...(supervisor === undefined ? {} : {
            separateStems: async (audioPath: string) => {
              await separateStems({
                ffmpegExe: FFMPEG_EXE, sidecar: supervisor, cacheRoot, stemsRoot: join(cacheRoot, 'stems'),
                scratchDir: join(ROOT, 'out', 'batch-scratch'), modelRepo: join(MODELS, 'demucs'), audioPath,
                settings: DEFAULT_ANALYSIS_SETTINGS,
              });
            },
          }),
        });
        outcome.status = 'directed';
        console.log(`  directed ${outcome.track.name}: ${outcome.directed.summary} (${((performance.now() - started) / 1000).toFixed(1)} s)`);
        for (const note of outcome.directed.notes) console.warn(`    note: ${note}`);
      } catch (error) {
        outcome.error = error instanceof Error ? error.message : String(error);
        console.error(`  ✖ ${outcome.track.name}: ${outcome.error}`);
      }
    }
  } finally {
    await supervisor?.stop();
  }

  // 2. Render them, one after another (they share one GPU — export-spec §12).
  if (!options.directOnly) {
    for (const [index, outcome] of outcomes.entries()) {
      if (outcome.status !== 'directed') continue;
      const started = performance.now();
      try {
        const result = await renderDocument({
          documentText: await readFile(outcome.track.projectPath, 'utf8'),
          projectPath: outcome.track.projectPath,
          size: options.preset.size ?? undefined,
          codec: options.preset.codec,
          seconds: options.seconds,
          motionBlur: options.motionBlur,
          outputPath: outcome.track.outputPath,
          workDir: join(ROOT, 'out', 'batch-render'),
          cacheRoot,
          name: 'batch',
        });
        if (!result.report.verification.ok) throw new Error(`the video failed verification: ${result.report.verification.issues.join('; ')}`);
        outcome.status = 'done';
        outcome.renderSeconds = (performance.now() - started) / 1000;
        console.log(`  [${index + 1}/${outcomes.length}] rendered ${outcome.track.outputPath} (${outcome.renderSeconds.toFixed(1)} s)`);
      } catch (error) {
        outcome.status = 'failed';
        outcome.error = error instanceof Error ? error.message : String(error);
        console.error(`  ✖ ${outcome.track.name}: ${outcome.error}`);
      }
    }
  }

  const report = {
    preset: options.preset.id,
    seed: options.seed,
    template: options.templateId,
    stems: options.stems,
    motionBlur: options.motionBlur ?? null,
    skipped,
    tracks: outcomes.map((o) => ({
      name: o.track.name, audioPath: o.track.audioPath, projectPath: o.track.projectPath,
      outputPath: options.directOnly ? null : o.track.outputPath, seed: o.track.seed, status: o.status,
      template: o.directed?.templateName ?? null, summary: o.directed?.summary ?? null, notes: o.directed?.notes ?? [],
      ...(o.error === undefined ? {} : { error: o.error }),
      ...(o.renderSeconds === undefined ? {} : { renderSeconds: Math.round(o.renderSeconds * 10) / 10 }),
    })),
  };
  await writeFile(join(options.outDir, 'batch-report.json'), JSON.stringify(report, null, 2) + '\n');
  const failed = outcomes.filter((o) => o.status === 'failed').length;
  const good = outcomes.length - failed;
  console.log(`${good} of ${outcomes.length} ${options.directOnly ? 'directed' : 'rendered'}${failed > 0 ? `, ${failed} failed` : ''}. Report: ${join(options.outDir, 'batch-report.json')}`);
  return failed === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  try {
    process.exitCode = await batch(process.argv.slice(2));
  } catch (error) {
    if (error instanceof CliError) {
      console.error(`\n✖ ${error.message}`);
      if (error.fixes.length > 0) console.error(`\n  Try:\n${error.fixes.map((f, i) => `    ${i + 1}. ${f}`).join('\n')}`);
      console.error('');
      process.exit(1);
    }
    throw error;
  }
}
