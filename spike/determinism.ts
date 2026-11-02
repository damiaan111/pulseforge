// npm run spike:determinism — P0 step 3's proof that renderFrame is deterministic on the GPU.
//
//   1. analysis: synthetic test track (or --audio <file> via the vendored FFmpeg)
//   2. Electron run #1: pass A (frames in order), pass B (fresh context, scrambled order), pass C (undithered)
//   3. Electron run #2: a separate process, same again
//   4. every frame's RGBA SHA-256 must match across all renders
//
// Also guards against the trivial pass: undithered frames must actually differ from each other.
// Options: --4k, --seconds N (default 10), --audio <file>

import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { decodeMono48k } from '../src/analysis/decode.ts';
import { ANALYSIS_VERSION, DEFAULT_SPECTRUM_SETTINGS } from '../src/analysis/spectrum.ts';
import { FFMPEG_EXE } from '../setup/lib/paths.ts';
import { bundleElectron, fail } from './harness.ts';
import { DeterminismRunError, runDeterminismSpike } from './lib/determinism-run.ts';
import { synthesizeTestTrack } from './test-signal.ts';

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
  await bundleElectron();

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

  console.log(`▶ Two Electron runs (${width}×${height}, ${frameCount} frames, three passes each)`);
  const s = await runDeterminismSpike({ width, height, frameCount, pcm, writeStills: true }).catch((error: Error) =>
    fail(error.message, [
      'Check that the GPU driver is working (nvidia-smi). If this is a shader error, the message shows the offending line.',
      ...(error instanceof DeterminismRunError ? [`Renderer log tail:\n${error.log.trim().split('\n').slice(-10).join('\n')}`] : []),
    ]),
  );

  const report = [
    '',
    '================ Pulseforge P0 — determinism spike ================',
    `GPU (ANGLE):      ${s.context?.renderer ?? '?'}`,
    `Electron/Chrome:  ${s.electronVersion} / ${s.chromeVersion}`,
    `Resolution:       ${width}×${height} @ 60 fps, ${frameCount} frames`,
    `Audio:            ${sourceLabel}`,
    `PCM SHA-256:      ${s.pcmSha256}`,
    `Analysis:         v${ANALYSIS_VERSION}, ${DEFAULT_SPECTRUM_SETTINGS.bins} log bins @ 240 Hz, FFT ${DEFAULT_SPECTRUM_SETTINGS.fftSize}, ${s.analysisMs.toFixed(0)} ms`,
    `Output encoding:  sRGB OETF (D49), dithered, RGBA8, top-down`,
    '',
    ...s.passHashes.map(([name, hash]) => `  ${name.padEnd(34)} ${hash}`),
    '',
    `Deterministic:    ${s.deterministic ? 'YES — every render byte-identical on every frame (4 dithered, 2 undithered)' : `NO — ${s.mismatches.map((m) => `${m.name} differs first at frame ${m.frame}`).join('; ')}`}`,
    `Content changes:  ${s.uniqueUnditheredFrames} unique of ${frameCount} frames with dither off ${s.animated ? '(bars are reacting to audio — not a trivial pass)' : '(TOO FEW — the bars may not be reacting to audio)'}`,
    `Median per frame: render ${s.medianRenderMs.toFixed(2)} ms, sync readback ${s.medianSyncReadbackMs.toFixed(2)} ms`,
    ...(s.warnings.length > 0 ? ['Warnings:', ...s.warnings.map((w) => `  ${w}`)] : []),
    ...(s.paramIssues.length > 0 ? ['Param issues:', ...s.paramIssues.map((w) => `  ${w}`)] : []),
    ...(s.stills.length > 0 ? ['Stills:', ...s.stills.map((p) => `  ${p}`)] : []),
    '===================================================================',
    '',
  ];
  console.log(report.join('\n'));
  process.exitCode = s.deterministic && s.animated ? 0 : 1;
}

await main();
