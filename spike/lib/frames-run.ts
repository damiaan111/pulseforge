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
import type { RenderProject } from '../../src/engine/core/project.ts';
import type { ContextInfo } from '../../src/engine/render/gl.ts';
import { encodeAnalysis } from '../../src/analysis/container.ts';
import type { DecodedImage } from '../../src/engine/core/image.ts';
import type { ShaderModuleSource } from '../../src/engine/modules/shader-module.ts';
import { existsSync } from 'node:fs';
import { defaultFontFile } from '../../src/assets/fonts.ts';
import { DEFAULT_FONT_FILE } from '../../setup/lib/paths.ts';
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
  /** Off by default: dither noise is exactly what a pixel-position check does not want. */
  readonly dither?: boolean;
  /** Decoded images by content hash, for layers that reference assets. */
  readonly images?: ReadonlyMap<string, DecodedImage>;
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

export async function renderFrames(options: FramesOptions): Promise<FramesSummary> {
  const rawDir = join(SPIKE_OUT, `frames-${options.name}`);
  await rm(rawDir, { recursive: true, force: true });

  const pcm = options.pcm ?? synthesizeTestTrack(2);
  const pcmSha256 = createHash('sha256').update(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)).digest('hex');
  const { analysis, beatGrid } = analyzeMix(pcm);
  const analysisFile = join(SPIKE_OUT, `analysis-${options.name}.bin`);
  await writeFile(analysisFile, encodeAnalysis(analysis.sources.get('mix')!, { source: 'mix', beatGrid, meta: { pcmSha256 } }));

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
    ...(existsSync(DEFAULT_FONT_FILE) ? { text: { default: defaultFontFile(), fonts: [...(options.fonts ?? [])] } } : {}),
    ...(options.videos !== undefined && options.videos.length > 0 ? { videos: [...options.videos] } : {}),
    ...(options.modules !== undefined && options.modules.length > 0 ? { modules: [...options.modules] } : {}),
    frames: [...options.frames],
    dither: options.dither ?? false,
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

  return { context: result.context, frames, warnings: result.warnings, paramIssues: result.paramIssues };
}
