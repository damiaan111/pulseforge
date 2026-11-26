// Working audio files, made with the vendored FFmpeg and kept in the library's Audio folder so a
// project can point at them for good: the sound of a video (C14) and several files joined into one
// song (C13). `document.audio` is one file, and stays one file; these are how more arrive as one.
//
// FLAC, 24-bit: it plays in the preview, it is lossless at the precision the export can use, and a
// float WAV of an album is ten times the size for nothing audible.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

import { renameIntoPlace } from '../node/rename-into-place.ts';

/** How much of each file name goes into a combined file's name; the metadata has them all. */
const NAMES_IN_FILE_NAME = 3;

export class AudioWorkError extends Error {
  /** What FFmpeg said, all of it: its last line is usually a generic "could not open". */
  readonly stderr: string;
  constructor(message: string, stderr = '') {
    super(message);
    this.name = 'AudioWorkError';
    this.stderr = stderr;
  }
}

export interface CombinedAudio {
  readonly path: string;
  /** The files that went in, by name, in order. */
  readonly parts: readonly string[];
}

/** Windows' reserved characters, and anything else a file name should not carry. */
function safeName(name: string): string {
  return name.replace(/[<>:"/\\|?*\p{Cc}]/gu, ' ').replace(/\s+/g, ' ').trim();
}

const stemOf = (path: string) => basename(path, extname(path));

/** The first audio stream, as 24-bit FLAC at its own rate and layout: nothing resampled or mixed. */
export function extractAudioArgs(input: string, output: string): string[] {
  return ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-map', '0:a:0', '-vn', '-c:a', 'flac', '-sample_fmt', 's32', '-f', 'flac', output];
}

/**
 * One after the other, in the order given, at 48 kHz stereo. The files need not agree: each is
 * converted on its way into the join, so a 44.1 kHz mono demo can follow a 48 kHz master. The comment
 * names the parts, so the file itself says what it is made of.
 */
export function combineAudioArgs(inputs: readonly string[], output: string, parts: readonly string[]): string[] {
  const shaped = inputs.map((_, i) => `[${i}:a:0]aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a${i}]`);
  const joined = `${inputs.map((_, i) => `[a${i}]`).join('')}concat=n=${inputs.length}:v=0:a=1[out]`;
  return [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    ...inputs.flatMap((input) => ['-i', input]),
    '-filter_complex', [...shaped, joined].join(';'),
    '-map', '[out]',
    '-metadata', `comment=Combined from: ${parts.join('; ')}`,
    '-c:a', 'flac', '-sample_fmt', 's32', '-f', 'flac', output,
  ];
}

/** "Combined - intro + verse + 2 more": what a person sees in a file list and in the audio panel. */
export function combinedStem(parts: readonly string[]): string {
  const names = parts.slice(0, NAMES_IN_FILE_NAME).map((part) => safeName(stemOf(part)).slice(0, 40));
  const more = parts.length - names.length;
  return `Combined - ${names.join(' + ')}${more > 0 ? ` + ${more} more` : ''}`;
}

function runFfmpeg(ffmpegExe: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegExe, [...args], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new AudioWorkError(stderr.trim().split('\n').pop() ?? `FFmpeg exit ${code}`, stderr));
    });
  });
}

/** Written beside the target and renamed in, so a run that dies never leaves half a song to reuse. */
async function produce(ffmpegExe: string, target: string, argsFor: (temp: string) => readonly string[]): Promise<void> {
  const temp = `${target}.part`;
  try {
    await runFfmpeg(ffmpegExe, argsFor(temp));
    await renameIntoPlace(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * The sound of a file the preview cannot play, as a FLAC in `folder`. Named after the file and its
 * content (`contentHash`), so importing the same video twice reuses the first extraction.
 */
export async function extractAudio(options: { readonly ffmpegExe: string; readonly input: string; readonly folder: string; readonly contentHash: string }): Promise<string> {
  const { ffmpegExe, input, folder, contentHash } = options;
  await mkdir(folder, { recursive: true });
  const target = join(folder, `${safeName(stemOf(input)).slice(0, 80)} (sound) ${contentHash.slice(0, 8)}.flac`);
  if (existsSync(target)) return target;
  try {
    await produce(ffmpegExe, target, (temp) => extractAudioArgs(input, temp));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new AudioWorkError(error instanceof AudioWorkError && /matches no streams/i.test(error.stderr)
      ? `${basename(input)} has no sound to use.`
      : `Could not take the sound out of ${basename(input)}: ${detail}`);
  }
  return target;
}

/** Joins `inputs`, in order, into one FLAC in `folder` and says what went in. */
export async function combineAudio(options: { readonly ffmpegExe: string; readonly inputs: readonly string[]; readonly folder: string }): Promise<CombinedAudio> {
  const { ffmpegExe, inputs, folder } = options;
  if (inputs.length < 2) throw new AudioWorkError('Choose at least two files to combine.');
  await mkdir(folder, { recursive: true });
  const parts = inputs.map((input) => basename(input));
  // By path, size and time, in order: the same parts in another order are another song, and a part
  // edited since is another part. No hashing of whole albums just to pick a file name.
  const identity = createHash('sha256');
  for (const input of inputs) {
    const file = await stat(input);
    identity.update(`${input}\0${file.size}\0${file.mtimeMs}\0`);
  }
  const target = join(folder, `${combinedStem(parts)} ${identity.digest('hex').slice(0, 8)}.flac`);
  try {
    await produce(ffmpegExe, target, (temp) => combineAudioArgs(inputs, temp, parts));
  } catch (error) {
    throw new AudioWorkError(`Could not combine those files: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { path: target, parts };
}
