// `pulseforge render project.pvproj -o out.mp4` (PROJECT.md S14, export-spec §18).
//
// The headless path, end to end: a project document on disk becomes an encoded MP4 with no UI
// involved. It exists as much to prove the architecture as to be used — if this works, the
// engine really is separable from the shell, and batch rendering (S13) and CI are a short step
// away rather than a rewrite.
//
// A WebGL2 context still needs Chromium, so the render itself runs in Electron via the same
// harness the spikes use. Everything before and after it — loading, analysis, reporting — is
// plain Node.
//
// Usage:
//   npm run render -- <project.pvproj> -o <out.mp4> [options]
//
//   --aspect 16:9|9:16|1:1|4:5   render at that shape, keeping the project's pixel count
//   --size WxH                   explicit canvas size, overriding the project's
//   --codec h264|hevc            default h264
//   --audio <file>               override the document's audio path
//   --no-cache                   re-analyse instead of reading the analysis cache
//   --seconds N                  render only the first N seconds
//   --quiet                      only errors and the final line

import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { AnalysisCache } from '../analysis/cache.ts';
import { analyzeCached } from '../analysis/cached.ts';
import { decodeMono48k } from '../analysis/decode.ts';
import { rational, TICKS_PER_SECOND } from '../engine/core/time.ts';
import { frameCount } from '../engine/core/time.ts';
import { defaultEncodeSettings } from '../export/ffmpeg-args.ts';
import { loadDocument } from '../project/load.ts';
import { timelineDurationTicks, toRenderProject } from '../project/snapshot.ts';
import { FFMPEG_EXE, ROOT } from '../../setup/lib/paths.ts';
import { bundleElectron } from '../../spike/harness.ts';
import { runExportSpike } from '../../spike/lib/export-run.ts';

export class CliError extends Error {
  readonly fixes: readonly string[];
  constructor(message: string, fixes: readonly string[] = []) {
    super(message);
    this.name = 'CliError';
    this.fixes = fixes;
  }
}

export interface Options {
  readonly projectPath: string;
  readonly outputPath: string;
  readonly aspect: string | undefined;
  readonly size: { width: number; height: number } | undefined;
  readonly codec: 'h264' | 'hevc';
  readonly audioOverride: string | undefined;
  readonly noCache: boolean;
  readonly seconds: number | undefined;
  readonly quiet: boolean;
}

/** Flags that stand alone. Everything else consumes the next token as its value. */
const BOOLEAN_FLAGS = new Set(['--quiet', '--no-cache']);

export function parseArgs(argv: readonly string[]): Options {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  // A leading "-" does not make a token a flag: "-30" is a value. Without this, no option
  // could ever take a negative number, which is a trap that only shows up much later.
  const isFlag = (token: string) => token.startsWith('-') && !Number.isFinite(Number(token));

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (BOOLEAN_FLAGS.has(arg)) {
      flags.set(arg.replace(/^--?/, ''), 'true');
    } else if (isFlag(arg)) {
      const value = argv[i + 1];
      if (value === undefined || isFlag(value)) throw new CliError(`${arg} needs a value`);
      flags.set(arg.replace(/^--?/, ''), value);
      i += 1;
    } else {
      positional.push(arg);
    }
  }

  const projectPath = positional[0];
  if (projectPath === undefined) {
    throw new CliError('No project file given.', ['npm run render -- path/to/project.pvproj -o out.mp4']);
  }
  const outputPath = flags.get('o') ?? flags.get('out');
  if (outputPath === undefined) {
    throw new CliError('No output file given.', ['Add -o out.mp4']);
  }

  const codec = flags.get('codec') ?? 'h264';
  if (codec !== 'h264' && codec !== 'hevc') {
    // AV1 encode does not exist on Ampere (PROJECT.md §4); saying so beats a render-time failure.
    throw new CliError(`Unknown codec "${codec}".`, ['Use --codec h264 (default) or --codec hevc']);
  }

  let size: { width: number; height: number } | undefined;
  const sizeFlag = flags.get('size');
  if (sizeFlag !== undefined) {
    const match = /^(\d+)x(\d+)$/i.exec(sizeFlag);
    if (match === null) throw new CliError(`--size must look like 1920x1080, got "${sizeFlag}"`);
    size = { width: Number(match[1]), height: Number(match[2]) };
  }

  const secondsFlag = flags.get('seconds');
  const seconds = secondsFlag === undefined ? undefined : Number(secondsFlag);
  if (seconds !== undefined && (!Number.isFinite(seconds) || seconds <= 0)) {
    throw new CliError(`--seconds must be a positive number, got "${secondsFlag}"`);
  }

  return {
    projectPath: resolve(projectPath),
    outputPath: resolve(outputPath),
    aspect: flags.get('aspect'),
    size,
    codec,
    audioOverride: flags.get('audio'),
    seconds,
    quiet: flags.has('quiet'),
    noCache: flags.has('no-cache'),
  };
}

/**
 * The canvas for a named aspect, keeping roughly the project's pixel count so "the same project
 * as a Short" does not silently become a different resolution class.
 */
export function canvasForAspect(aspect: string, base: { width: number; height: number }): { width: number; height: number } {
  const ratios: Record<string, number> = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5 };
  const ratio = ratios[aspect];
  if (ratio === undefined) {
    throw new CliError(`Unknown aspect "${aspect}".`, [`Use one of ${Object.keys(ratios).join(', ')}, or --size WxH`]);
  }
  const pixels = base.width * base.height;
  // Even dimensions: 4:2:0 chroma subsampling cannot encode an odd one.
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return { width: even(Math.sqrt(pixels * ratio)), height: even(Math.sqrt(pixels / ratio)) };
}

export async function render(argv: readonly string[]): Promise<void> {
  const options = parseArgs(argv);
  const say = (line: string) => {
    if (!options.quiet) console.log(line);
  };

  if (!existsSync(options.projectPath)) {
    throw new CliError(`Project file not found: ${options.projectPath}`);
  }
  if (!existsSync(FFMPEG_EXE)) {
    throw new CliError('The vendored FFmpeg is missing.', ['Run `npm run setup` to provision vendor/']);
  }

  const { document, issues, migratedFrom } = loadDocument(await readFile(options.projectPath, 'utf8'));
  if (migratedFrom !== null) say(`Migrated from schema version ${migratedFrom}.`);
  for (const issue of issues) console.warn(`  warning ${issue.path}: ${issue.detail}`);

  // Audio paths are stored relative to the project when possible (data-formats §1.2).
  const audioPath = options.audioOverride !== undefined
    ? resolve(options.audioOverride)
    : document.audio.path === ''
      ? undefined
      : isAbsolute(document.audio.path) ? document.audio.path : join(dirname(options.projectPath), document.audio.path);
  if (audioPath === undefined || !existsSync(audioPath)) {
    throw new CliError(
      audioPath === undefined ? 'The project has no audio file.' : `Audio file not found: ${audioPath}`,
      ['Point at one with --audio <file>', 'Or fix the path stored in the project'],
    );
  }

  say(`Decoding ${audioPath}`);
  const decoded = await decodeMono48k(FFMPEG_EXE, audioPath);

  // Analysis goes through the on-disk cache (data-formats §4): the same audio and settings are
  // analysed once, ever. `--no-cache` recomputes, which is the first thing to try if a render
  // looks like it is reacting to the wrong numbers.
  const cache = new AnalysisCache({ root: join(ROOT, 'cache') });
  const analysed = await analyzeCached(decoded.pcm, cache, { force: options.noCache });
  say(analysed.fromCache
    ? `Analysis: cache hit (${analysed.audioHash.slice(0, 12)}…)`
    : `Analysis: computed and cached (${analysed.audioHash.slice(0, 12)}…)`);

  const canvas = options.size ?? (options.aspect !== undefined
    ? canvasForAspect(options.aspect, document.canvas)
    : { width: document.canvas.width, height: document.canvas.height });
  const resized = { ...document, canvas: { ...document.canvas, ...canvas } };

  const { project, notes, aspect } = toRenderProject(resized);
  // Notes are the engine saying what it could not do. Never swallowed: a silently missing
  // effect looks like a broken module, and gets debugged as one.
  for (const note of notes) console.warn(`  note ${note.path}: ${note.detail}`);

  const documentTicks = timelineDurationTicks(document);
  const durationTicks = options.seconds !== undefined
    ? Math.round(options.seconds * TICKS_PER_SECOND)
    : documentTicks > 0 ? documentTicks : Math.round((decoded.pcm.length / decoded.sampleRate) * TICKS_PER_SECOND);
  if (durationTicks <= 0) {
    throw new CliError('The timeline has no length.', ['Set the audio duration in the project, or pass --seconds N']);
  }

  const fps = rational(project.canvas.fps.num, project.canvas.fps.den);
  const frames = frameCount(durationTicks, fps);
  say(`Rendering ${project.layers.length} layer(s) at ${canvas.width}×${canvas.height} (${aspect}) `
    + `${fps.num / fps.den} fps, ${frames} frames, ${options.codec}`);

  await mkdir(dirname(options.outputPath), { recursive: true });
  await bundleElectron();

  const summary = await runExportSpike({
    workDir: join(ROOT, 'out', 'render'),
    name: 'cli',
    project: { ...project, durationTicks },
    analysisPcm: decoded.pcm,
    analysis: { analysis: analysed.analysis, beatGrid: analysed.beatGrid },
    audioPath,
    audioLabel: audioPath,
    audioPlacement: {
      leadInSamples: document.audio.leadInTicks,
      clipInSamples: document.audio.clipInTicks,
      clipOutSamples: document.audio.clipOutTicks ?? undefined,
    },
    durationTicks,
    settings: defaultEncodeSettings(options.codec),
    outputPath: options.outputPath,
    readbackMode: 'sync',
    readbackDepth: 1,
    hashFrames: false,
    dither: true,
    runs: 1,
    onProgress: (line) => say(`  ${line}`),
  });

  const { report } = summary.first;
  const seconds = report.timing.wallMs / 1000;
  console.log(`Wrote ${options.outputPath}`);
  console.log(`  ${report.timing.frames} frames in ${seconds.toFixed(1)} s `
    + `(${(report.timing.frames / seconds).toFixed(1)} fps), verification ${report.verification.ok ? 'ok' : 'FAILED'}`);
  if (!report.verification.ok) {
    throw new CliError('The exported file did not pass verification.', ['See the render report written beside the output']);
  }
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  try {
    await render(process.argv.slice(2));
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
