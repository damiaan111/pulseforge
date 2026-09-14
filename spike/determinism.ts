// npm run spike:determinism — P0 step 3's proof that renderFrame is deterministic on the GPU.
//
//   1. analysis: synthetic test track (or --audio <file> via the vendored FFmpeg)
//   2. Electron run #1: pass A (frames in order) + pass B (fresh context, scrambled order)
//   3. Electron run #2: a separate process, same again
//   4. every frame's RGBA SHA-256 must match across all four renders
//
// Also guards against the trivial pass: frames must actually differ from each other.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { decodeMono48k } from '../src/analysis/decode.ts';
import { ANALYSIS_VERSION, DEFAULT_SPECTRUM_SETTINGS, computeSourceAnalysis } from '../src/analysis/spectrum.ts';
import { FFMPEG_EXE } from '../setup/lib/paths.ts';
import { encodeAnalysis } from './analysis-file.ts';
import type { DeterminismConfig, PassResult, SpikeRenderResult } from './electron/protocol.ts';
import { SPIKE_OUT as OUT, bundleElectron as bundle, fail, median, runElectron as runElectronGeneric } from './harness.ts';
import { synthesizeTestTrack } from './test-signal.ts';

function combinedHash(pass: PassResult): string {
  return createHash('sha256').update(pass.frameHashes.join('\n')).digest('hex');
}

function firstMismatch(a: PassResult, b: PassResult): number {
  return a.frameHashes.findIndex((hash, i) => hash !== b.frameHashes[i]);
}

async function runElectron(config: DeterminismConfig): Promise<{ result: SpikeRenderResult; stderr: string }> {
  const { result, log } = await runElectronGeneric<SpikeRenderResult>(config);
  return { result, stderr: log };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      audio: { type: 'string' },
      seconds: { type: 'string', default: '10' },
      '4k': { type: 'boolean', default: false },
    },
  });
  const width = values['4k'] ? 3840 : 1920;
  const height = values['4k'] ? 2160 : 1080;
  const seconds = Number(values.seconds);
  if (!(seconds > 0 && seconds <= 600)) fail(`--seconds must be between 0 and 600, got ${values.seconds}`, ['Pass e.g. --seconds 10.']);
  const frameCount = Math.round(seconds * 60);

  console.log('▶ Bundling spike harness');
  await rm(join(OUT, 'raw-1'), { recursive: true, force: true });
  await rm(join(OUT, 'raw-2'), { recursive: true, force: true });
  await bundle();

  console.log('▶ Analysis');
  let pcm: Float32Array;
  let sourceLabel: string;
  if (values.audio !== undefined) {
    if (!existsSync(FFMPEG_EXE)) fail('The vendored FFmpeg is not installed, so --audio cannot be decoded.', ['Run `npm run setup -- --tier core`, or omit --audio to use the synthetic track.']);
    const decoded = await decodeMono48k(FFMPEG_EXE, values.audio).catch((error: Error) =>
      fail(`Could not decode ${values.audio}: ${error.message}`, ['Check the file plays, or omit --audio to use the synthetic track.']),
    );
    pcm = decoded.pcm.subarray(0, Math.min(decoded.pcm.length, Math.round(seconds * 48_000)));
    sourceLabel = values.audio;
  } else {
    pcm = synthesizeTestTrack(seconds);
    sourceLabel = 'synthetic test track (spike/test-signal.ts)';
  }
  const pcmSha256 = createHash('sha256').update(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)).digest('hex');
  const analysisStart = performance.now();
  const analysis = computeSourceAnalysis(pcm, DEFAULT_SPECTRUM_SETTINGS);
  const analysisMs = performance.now() - analysisStart;
  const analysisFile = join(OUT, 'analysis.bin');
  await writeFile(analysisFile, encodeAnalysis('mix', analysis, { pcmSha256, analysisVersion: ANALYSIS_VERSION }));

  const dumpFrames = [0, Math.floor(frameCount / 2), frameCount - 1].filter((f, i, all) => f >= 0 && all.indexOf(f) === i);
  const runs: SpikeRenderResult[] = [];
  for (const run of [1, 2]) {
    console.log(`▶ Electron run ${run} of 2 (${width}×${height}, ${frameCount} frames, two passes)`);
    const config: DeterminismConfig = {
      mode: 'determinism',
      analysisFile,
      resultFile: join(OUT, `result-${run}.json`),
      rawDir: join(OUT, `raw-${run}`),
      width,
      height,
      frameCount,
      dumpFrames: run === 1 ? dumpFrames : [],
    };
    const { result, stderr } = await runElectron(config).catch((error: Error) =>
      fail(error.message, ['Check that the GPU driver is working (nvidia-smi).', `Re-run; if it repeats, the renderer output above says why.`]),
    );
    if (!result.ok) {
      fail(`Electron run ${run} failed: ${result.error ?? 'unknown error'}`, [
        'If this is a shader error, the message shows the offending line.',
        `Renderer log tail:\n${stderr.trim().split('\n').slice(-10).join('\n')}`,
      ]);
    }
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
  const undithered1 = run1.undithered!;
  const undithered2 = run2.undithered!;
  const unditheredMismatch = firstMismatch(undithered1, undithered2);
  if (unditheredMismatch !== -1) mismatches.push({ name: 'run 2 / undithered vs run 1 / undithered', frame: unditheredMismatch });
  // Counted with dither off: per-frame dither noise would make every frame "unique" even if nothing moved.
  const uniqueFrames = new Set(undithered1.frameHashes).size;

  const pngs: string[] = [];
  for (const frame of dumpFrames) {
    const raw = join(OUT, 'raw-1', `frame-${String(frame).padStart(5, '0')}.rgba`);
    const png = join(OUT, `frame-${String(frame).padStart(5, '0')}.png`);
    if (existsSync(FFMPEG_EXE) && existsSync(raw)) {
      await new Promise<void>((resolve) => {
        const child = spawn(FFMPEG_EXE, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-i', raw, '-frames:v', '1', png], { windowsHide: true });
        child.on('close', () => resolve());
      });
      if (existsSync(png)) pngs.push(png);
    }
  }

  const all = passes.map(([, p]) => p);
  const renderMs = median(all.flatMap((p) => p.renderMs));
  const readbackMs = median(all.flatMap((p) => p.readbackMs));
  const deterministic = mismatches.length === 0;
  const animated = uniqueFrames > frameCount * 0.5;

  const report = [
    '',
    '================ Pulseforge P0 — determinism spike ================',
    `GPU (ANGLE):      ${run1.context?.renderer ?? '?'}`,
    `Electron/Chrome:  ${run1.electronVersion} / ${run1.chromeVersion}`,
    `Resolution:       ${width}×${height} @ 60 fps, ${frameCount} frames`,
    `Audio:            ${sourceLabel}`,
    `PCM SHA-256:      ${pcmSha256}`,
    `Analysis:         v${ANALYSIS_VERSION}, ${DEFAULT_SPECTRUM_SETTINGS.bins} log bins @ 240 Hz, FFT ${DEFAULT_SPECTRUM_SETTINGS.fftSize}, ${analysisMs.toFixed(0)} ms`,
    `Output encoding:  sRGB OETF (D49), dithered, RGBA8, top-down`,
    '',
    ...passes.map(([name, pass]) => `  ${name.padEnd(34)} ${combinedHash(pass)}`),
    `  ${'run 1 / undithered'.padEnd(34)} ${combinedHash(undithered1)}`,
    `  ${'run 2 / undithered'.padEnd(34)} ${combinedHash(undithered2)}`,
    '',
    `Deterministic:    ${deterministic ? 'YES — every render byte-identical on every frame (4 dithered, 2 undithered)' : `NO — ${mismatches.map((m) => `${m.name} differs first at frame ${m.frame}`).join('; ')}`}`,
    `Content changes:  ${uniqueFrames} unique of ${frameCount} frames with dither off ${animated ? '(bars are reacting to audio — not a trivial pass)' : '(TOO FEW — the bars may not be reacting to audio)'}`,
    `Median per frame: render ${renderMs.toFixed(2)} ms, sync readback ${readbackMs.toFixed(2)} ms (preliminary; step 5 measures properly)`,
    ...(run1.warnings.length > 0 ? ['Warnings:', ...run1.warnings.map((w) => `  ${w}`)] : []),
    ...(run1.paramIssues.length > 0 ? ['Param issues:', ...run1.paramIssues.map((w) => `  ${w}`)] : []),
    ...(pngs.length > 0 ? ['Stills:', ...pngs.map((p) => `  ${p}`)] : []),
    '===================================================================',
    '',
  ];
  console.log(report.join('\n'));
  process.exitCode = deterministic && animated ? 0 : 1;
}

await main();
