// Engine determinism on the GPU: two Electron processes × (sequential, scrambled on a fresh
// context, undithered). Used by `npm run spike:determinism` and `npm run validate`.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ANALYSIS_VERSION, DEFAULT_SPECTRUM_SETTINGS, computeSourceAnalysis } from '../../src/analysis/spectrum.ts';
import type { ContextInfo } from '../../src/engine/render/gl.ts';
import { FFMPEG_EXE } from '../../setup/lib/paths.ts';
import { encodeAnalysis } from '../analysis-file.ts';
import type { DeterminismConfig, PassResult, SpikeRenderResult } from '../electron/protocol.ts';
import { SPIKE_OUT, median, runElectron } from '../harness.ts';

export interface DeterminismOptions {
  readonly width: number;
  readonly height: number;
  readonly frameCount: number;
  readonly pcm: Float32Array;
  readonly writeStills: boolean;
}

export interface DeterminismSummary {
  readonly context: ContextInfo | undefined;
  readonly electronVersion: string;
  readonly chromeVersion: string;
  readonly pcmSha256: string;
  readonly analysisMs: number;
  readonly passHashes: ReadonlyArray<readonly [string, string]>;
  readonly mismatches: ReadonlyArray<{ readonly name: string; readonly frame: number }>;
  readonly deterministic: boolean;
  readonly uniqueUnditheredFrames: number;
  readonly animated: boolean;
  readonly medianRenderMs: number;
  readonly medianSyncReadbackMs: number;
  readonly warnings: readonly string[];
  readonly paramIssues: readonly string[];
  readonly stills: readonly string[];
}

export class DeterminismRunError extends Error {
  readonly log: string;
  constructor(message: string, log: string) {
    super(message);
    this.name = 'DeterminismRunError';
    this.log = log;
  }
}

function combinedHash(pass: PassResult): string {
  return createHash('sha256').update(pass.frameHashes.join('\n')).digest('hex');
}

function firstMismatch(a: PassResult, b: PassResult): number {
  return a.frameHashes.findIndex((hash, i) => hash !== b.frameHashes[i]);
}

export async function runDeterminismSpike(options: DeterminismOptions): Promise<DeterminismSummary> {
  const { width, height, frameCount, pcm } = options;
  await rm(join(SPIKE_OUT, 'raw-1'), { recursive: true, force: true });
  await rm(join(SPIKE_OUT, 'raw-2'), { recursive: true, force: true });

  const pcmSha256 = createHash('sha256').update(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)).digest('hex');
  const analysisStart = performance.now();
  const analysis = computeSourceAnalysis(pcm, DEFAULT_SPECTRUM_SETTINGS);
  const analysisMs = performance.now() - analysisStart;
  const analysisFile = join(SPIKE_OUT, 'analysis.bin');
  await writeFile(analysisFile, encodeAnalysis('mix', analysis, { pcmSha256, analysisVersion: ANALYSIS_VERSION }));

  const dumpFrames = options.writeStills ? [0, Math.floor(frameCount / 2), frameCount - 1].filter((f, i, all) => f >= 0 && all.indexOf(f) === i) : [];
  const runs: SpikeRenderResult[] = [];
  for (const run of [1, 2]) {
    const config: DeterminismConfig = {
      mode: 'determinism',
      analysisFile,
      resultFile: join(SPIKE_OUT, `result-${run}.json`),
      rawDir: join(SPIKE_OUT, `raw-${run}`),
      width,
      height,
      frameCount,
      dumpFrames: run === 1 ? dumpFrames : [],
    };
    const { result, log } = await runElectron<SpikeRenderResult>(config);
    if (!result.ok) throw new DeterminismRunError(`Electron run ${run} failed: ${result.error ?? 'unknown error'}`, log);
    runs.push(result);
  }

  const [run1, run2] = runs as [SpikeRenderResult, SpikeRenderResult];
  const passes: Array<[string, PassResult]> = [
    ['run 1 / sequential', run1.sequential!],
    ['run 1 / shuffled, fresh context', run1.shuffled!],
    ['run 2 / sequential', run2.sequential!],
    ['run 2 / shuffled, fresh context', run2.shuffled!],
  ];
  const reference = passes[0]![1];
  const mismatches = passes.slice(1).map(([name, pass]) => ({ name, frame: firstMismatch(reference, pass) })).filter((m) => m.frame !== -1);
  const unditheredMismatch = firstMismatch(run1.undithered!, run2.undithered!);
  if (unditheredMismatch !== -1) mismatches.push({ name: 'run 2 / undithered vs run 1 / undithered', frame: unditheredMismatch });
  // Counted with dither off: per-frame dither noise would make every frame "unique" even if nothing moved.
  const uniqueUnditheredFrames = new Set(run1.undithered!.frameHashes).size;

  const stills: string[] = [];
  for (const frame of dumpFrames) {
    const raw = join(SPIKE_OUT, 'raw-1', `frame-${String(frame).padStart(5, '0')}.rgba`);
    const png = join(SPIKE_OUT, `frame-${String(frame).padStart(5, '0')}.png`);
    if (existsSync(FFMPEG_EXE) && existsSync(raw)) {
      await new Promise<void>((resolve) => {
        const child = spawn(FFMPEG_EXE, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-i', raw, '-frames:v', '1', png], { windowsHide: true });
        child.on('close', () => resolve());
      });
      if (existsSync(png)) stills.push(png);
    }
  }

  const all = passes.map(([, p]) => p);
  return {
    context: run1.context,
    electronVersion: run1.electronVersion ?? 'unknown',
    chromeVersion: run1.chromeVersion ?? 'unknown',
    pcmSha256,
    analysisMs,
    passHashes: [
      ...passes.map(([name, pass]) => [name, combinedHash(pass)] as const),
      ['run 1 / undithered', combinedHash(run1.undithered!)] as const,
      ['run 2 / undithered', combinedHash(run2.undithered!)] as const,
    ],
    mismatches,
    deterministic: mismatches.length === 0,
    uniqueUnditheredFrames,
    animated: uniqueUnditheredFrames > frameCount * 0.5,
    medianRenderMs: median(all.flatMap((p) => p.renderMs)),
    medianSyncReadbackMs: median(all.flatMap((p) => p.readbackMs)),
    warnings: run1.warnings,
    paramIssues: run1.paramIssues,
    stills,
  };
}
