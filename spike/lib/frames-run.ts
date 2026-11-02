// Headless "render these frames of this project and give me the pixels".
//
// The general-purpose GPU render path outside of an export: used to check layout and
// compositing against known pixel positions, and the basis for the golden-frame suite
// (export-spec §16). Everything it needs is explicit — project, analysis input, frame
// indices — so a check reads as a statement about the engine, not about a spike.

import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { analyzeMix } from '../../src/analysis/analyze.ts';
import type { MotionBlur } from '../../src/engine/core/time.ts';
import type { RenderProject } from '../../src/engine/core/project.ts';
import type { BeatGrid, SourceAnalysis } from '../../src/engine/core/analysis.ts';
import type { ContextInfo } from '../../src/engine/render/gl.ts';
import { encodeAnalysis } from '../../src/analysis/container.ts';
import type { DecodedImage } from '../../src/engine/core/image.ts';
import type { ShaderModuleSource } from '../../src/engine/modules/shader-module.ts';
import { existsSync } from 'node:fs';
import { colorEmojiFontFile, defaultFontFile, fallbackFontFiles } from '../../src/assets/fonts.ts';
import { DEFAULT_FONT_FILE, MILKDROP_JS_DIR } from '../../setup/lib/paths.ts';
import type { FontFileRef, FramesConfig, ImageFile, SpikeFramesResult, VideoSequenceFile } from '../electron/protocol.ts';
import { SPIKE_OUT, runElectron } from '../harness.ts';
import { synthesizeTestTrack } from '../test-signal.ts';

export interface FramesOptions {
  readonly project: RenderProject;
  readonly frames: readonly number[];
  /** A name, so concurrent callers do not write over each other's raw frames. */
  readonly name: string;
  /** Defaults to a two-second synthetic track — enough for any analysis lookup a check makes. */
  readonly pcm?: Float32Array;
  /**
   * The mix analysis, when the caller already has it (the contact sheet renders many projects from
   * one track): skips analysing `pcm` again. Must be the analysis of that audio.
   */
  readonly analysis?: { readonly mix: SourceAnalysis; readonly beatGrid: BeatGrid | undefined };
  /** Off by default: dither noise is exactly what a pixel-position check does not want. */
  readonly dither?: boolean;
  /** Motion blur (S10); absent is off. */
  readonly motionBlur?: MotionBlur;
  readonly supersample?: 1 | 2;
  /** Time each layer on the GPU (S12); the summary comes back as `gpu`. */
  readonly profile?: boolean;
  /** Draft or preview quality (S18); final by default, as an export. */
  readonly quality?: 'draft' | 'preview' | 'final';
  /** Decoded images by content hash, for layers that reference assets. */
  readonly images?: ReadonlyMap<string, DecodedImage>;
  /** .cube texts by content hash (S11). */
  readonly luts?: readonly { readonly hash: string; readonly text: string }[];
  /** Font files by content hash, beyond the bundled default (which is always registered when present). */
  readonly fonts?: readonly FontFileRef[];
  /** Extracted video sequences, for layers that reference video assets (M39). */
  readonly videos?: readonly VideoSequenceFile[];
  /** Drop-in modules (M35). */
  readonly modules?: readonly ShaderModuleSource[];
}

/** One rendered frame, top-down RGBA8 (the engine's export orientation). */
export interface RenderedFrame {
  readonly frameIndex: number;
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
  readonly sha256: string;
  /** Straight (non-premultiplied) 0–255 sRGB at a pixel, with y measured from the top. */
  at(x: number, y: number): { readonly r: number; readonly g: number; readonly b: number; readonly a: number };
}

export interface FramesSummary {
  readonly context: ContextInfo | undefined;
  readonly frames: readonly RenderedFrame[];
  readonly warnings: readonly string[];
  readonly paramIssues: readonly string[];
  readonly gpu?: SpikeFramesResult['gpu'];
}

export class FramesRunError extends Error {
  readonly log: string;
  constructor(message: string, log: string) {
    super(message);
    this.name = 'FramesRunError';
    this.log = log;
  }
}

function frameAt(width: number, pixels: Uint8Array) {
  return (x: number, y: number) => {
    const o = (y * width + x) * 4;
    return { r: pixels[o] ?? 0, g: pixels[o + 1] ?? 0, b: pixels[o + 2] ?? 0, a: pixels[o + 3] ?? 0 };
  };
}

function colorEmojiConfig(): { colorEmoji?: FontFileRef } {
  const font = colorEmojiFontFile();
  return font === null ? {} : { colorEmoji: font };
}

export async function renderFrames(options: FramesOptions): Promise<FramesSummary> {
  const rawDir = join(SPIKE_OUT, `frames-${options.name}`);
  await rm(rawDir, { recursive: true, force: true });

  const pcm = options.pcm ?? synthesizeTestTrack(2);
  const pcmSha256 = createHash('sha256').update(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)).digest('hex');
  const given = options.analysis;
  const computed = given === undefined ? analyzeMix(pcm) : undefined;
  const mix = given?.mix ?? computed!.analysis.sources.get('mix')!;
  const beatGrid = given === undefined ? computed!.beatGrid : given.beatGrid;
  const analysisFile = join(SPIKE_OUT, `analysis-${options.name}.bin`);
  await writeFile(analysisFile, encodeAnalysis(mix, { source: 'mix', ...(beatGrid === undefined ? {} : { beatGrid }), meta: { pcmSha256 } }));

  const images: ImageFile[] = [];
  for (const [hash, image] of options.images ?? []) {
    const file = join(SPIKE_OUT, `image-${options.name}-${hash.slice(0, 16)}.rgba`);
    await writeFile(file, image.pixels);
    images.push({ hash, width: image.width, height: image.height, file });
  }

  const config: FramesConfig = {
    mode: 'frames',
    analysisFile,
    resultFile: join(SPIKE_OUT, `frames-${options.name}.json`),
    rawDir,
    project: options.project,
    ...(images.length > 0 ? { images } : {}),
    ...(existsSync(DEFAULT_FONT_FILE) ? { text: { default: defaultFontFile(), fallbacks: [...fallbackFontFiles()], fonts: [...(options.fonts ?? [])], ...colorEmojiConfig() } } : {}),
    ...(options.videos !== undefined && options.videos.length > 0 ? { videos: [...options.videos] } : {}),
    ...(options.modules !== undefined && options.modules.length > 0 ? { modules: [...options.modules] } : {}),
    frames: [...options.frames],
    ...(options.luts === undefined || options.luts.length === 0 ? {} : { luts: options.luts.map((l) => ({ hash: l.hash, text: l.text })) }),
    dither: options.dither ?? false,
    ...(options.motionBlur === undefined ? {} : { motionBlur: options.motionBlur }),
    ...(options.supersample === undefined ? {} : { supersample: options.supersample }),
    ...(existsSync(join(MILKDROP_JS_DIR, 'index.json')) ? { milkdropDir: MILKDROP_JS_DIR } : {}),
    ...(options.profile === true ? { profile: true } : {}),
    ...(options.quality === undefined ? {} : { quality: options.quality }),
  };
  const { result, log } = await runElectron<SpikeFramesResult>(config);
  if (!result.ok) throw new FramesRunError(`Frame render failed: ${result.error ?? 'unknown error'}`, log);

  const frames: RenderedFrame[] = [];
  for (const [i, file] of result.files.entries()) {
    const pixels = new Uint8Array(await readFile(file));
    frames.push({
      frameIndex: options.frames[i] ?? i,
      width: result.width,
      height: result.height,
      pixels,
      sha256: result.frameHashes[i] ?? '',
      at: frameAt(result.width, pixels),
    });
  }

  return { context: result.context, frames, warnings: result.warnings, paramIssues: result.paramIssues, ...(result.gpu === undefined ? {} : { gpu: result.gpu }) };
}
