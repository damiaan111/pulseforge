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
//   --motion-blur                average 8 subframes across a 180° shutter (export-spec §9)
//   --blur-samples N             subframes per frame, 2–32 (implies --motion-blur)
//   --shutter DEG                shutter angle, 1–360 (implies --motion-blur)
//   --instrumental               karaoke: the soundtrack is every stem but the vocals (S15; needs
//                                the track's stems separated)
//   --from X / --to X            render part of the timeline: X is a marker's name, or a time
//                                (seconds, or m:ss); either may be left out (S9)
//   --quiet                      only errors and the final line

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { MOTION_BLUR_DEFAULT, TICKS_PER_SECOND, motionBlurProblems, type MotionBlur } from '../engine/core/time.ts';
import { RenderDocumentError, canvasForAspect as sharedCanvasForAspect, renderDocument } from '../export/render-document.ts';
import { DiskSpaceError } from '../export/disk-space.ts';
import type { Marker } from '../project/document.ts';
import { loadDocument } from '../project/load.ts';
import { ROOT } from '../../setup/lib/paths.ts';

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
  readonly motionBlur: MotionBlur | undefined;
  /** Marker names or times, resolved against the project once it is read. */
  readonly from: string | undefined;
  readonly to: string | undefined;
  readonly instrumental: boolean;
  readonly quiet: boolean;
}

/** Flags that stand alone. Everything else consumes the next token as its value. */
const BOOLEAN_FLAGS = new Set(['--quiet', '--no-cache', '--motion-blur', '--instrumental']);

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

  let motionBlur: MotionBlur | undefined;
  const samplesFlag = flags.get('blur-samples');
  const shutterFlag = flags.get('shutter');
  if (flags.has('motion-blur') || samplesFlag !== undefined || shutterFlag !== undefined) {
    motionBlur = {
      samples: samplesFlag === undefined ? MOTION_BLUR_DEFAULT.samples : Number(samplesFlag),
      shutterDegrees: shutterFlag === undefined ? MOTION_BLUR_DEFAULT.shutterDegrees : Number(shutterFlag),
    };
    const problems = motionBlurProblems(motionBlur);
    if (problems.length > 0) throw new CliError(problems.join('; '), ['Use --blur-samples 2–32 and --shutter 1–360']);
  }

  return {
    projectPath: resolve(projectPath),
    outputPath: resolve(outputPath),
    aspect: flags.get('aspect'),
    size,
    codec,
    audioOverride: flags.get('audio'),
    seconds,
    motionBlur,
    from: flags.get('from'),
    to: flags.get('to'),
    instrumental: flags.has('instrumental'),
    quiet: flags.has('quiet'),
    noCache: flags.has('no-cache'),
  };
}

/**
 * The canvas for a named aspect, keeping roughly the project's pixel count so "the same project
 * as a Short" does not silently become a different resolution class.
 */
export function canvasForAspect(aspect: string, base: { width: number; height: number }): { width: number; height: number } {
  try {
    return sharedCanvasForAspect(aspect, base);
  } catch (error) {
    if (error instanceof RenderDocumentError) throw new CliError(error.message, [...error.fixes.map((f) => `${f}, or --size WxH`)]);
    throw error;
  }
}

/**
 * `--from` / `--to` to ticks: a marker's name (case-insensitive, exact), or a time as seconds
 * ("90", "12.5") or m:ss ("1:30.5"). A name that is not a marker is refused with the list.
 */
export function resolveRangeBound(value: string, markers: readonly Marker[]): number {
  const byName = markers.filter((m) => m.name.toLowerCase() === value.trim().toLowerCase());
  if (byName.length === 1) return (byName[0] as Marker).ticks;
  if (byName.length > 1) throw new CliError(`Two markers are called "${value}".`, ['Rename one in the studio, or give a time instead']);
  const clock = /^(\d+):(\d+(?:\.\d+)?)$/.exec(value.trim());
  const seconds = clock !== null ? Number(clock[1]) * 60 + Number(clock[2]) : Number(value);
  if (value.trim() !== '' && Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * TICKS_PER_SECOND);
  throw new CliError(`"${value}" is neither a marker nor a time.`, [
    markers.length === 0 ? 'The project has no markers; give seconds or m:ss' : `Markers: ${markers.map((m) => m.name).join(', ')}`,
  ]);
}

export async function render(argv: readonly string[]): Promise<void> {
  const options = parseArgs(argv);
  const say = (line: string) => {
    if (!options.quiet) console.log(line);
  };

  if (!existsSync(options.projectPath)) {
    throw new CliError(`Project file not found: ${options.projectPath}`);
  }
  if (options.aspect !== undefined) canvasForAspect(options.aspect, { width: 16, height: 9 }); // validate up front

  let result;
  try {
    // The same pipeline the studio's render queue uses (src/export/render-document.ts), so the
    // CLI cannot render differently from the app.
    const documentText = await readFile(options.projectPath, 'utf8');
    let range: { inTicks: number; outTicks: number } | undefined;
    if (options.from !== undefined || options.to !== undefined) {
      const { document } = loadDocument(documentText);
      range = {
        inTicks: options.from === undefined ? 0 : resolveRangeBound(options.from, document.markers),
        outTicks: options.to === undefined ? Number.MAX_SAFE_INTEGER : resolveRangeBound(options.to, document.markers),
      };
    }
    result = await renderDocument({
      documentText,
      range,
      audioMix: options.instrumental ? 'instrumental' : 'full',
      projectPath: options.projectPath,
      audioOverride: options.audioOverride,
      aspect: options.aspect,
      size: options.size,
      seconds: options.seconds,
      codec: options.codec,
      motionBlur: options.motionBlur,
      outputPath: options.outputPath,
      workDir: join(ROOT, 'out', 'render'),
      cacheRoot: join(ROOT, 'cache'),
      name: 'cli',
      // `--no-cache` recomputes, which is the first thing to try if a render looks like it is
      // reacting to the wrong numbers.
      noCache: options.noCache,
      log: say,
    });
  } catch (error) {
    if (error instanceof DiskSpaceError) throw new CliError(error.message, error.fixes);
    if (error instanceof RenderDocumentError) {
      throw new CliError(error.message, error.message.startsWith('The project has no audio') || error.message.startsWith('Audio file not found')
        ? ['Point at one with --audio <file>', 'Or fix the path stored in the project']
        : error.fixes);
    }
    throw error;
  }

  if (result.migratedFrom !== null) say(`Migrated from schema version ${result.migratedFrom}.`);
  for (const issue of result.issues) console.warn(`  warning ${issue.path}: ${issue.detail}`);
  // Notes are the engine saying what it could not do. Never swallowed: a silently missing
  // effect looks like a broken module, and gets debugged as one.
  for (const note of result.notes) console.warn(`  note ${note.path}: ${note.detail}`);

  const { report } = result;
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
