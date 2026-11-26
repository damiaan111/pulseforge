// npm run spike:export — P0 step 4: the real export path on the real GPU.
//
//   render (engine) → readback → FFmpeg stdin → NVENC → mux with AAC audio
//   → ffprobe verification → render report beside the file
//
// Runs the export in separate Electron processes and checks that every raw frame and the
// bit-exact MP4 are byte-identical, the frame count is exact, all colour tags are present, and
// audio length is within one frame of video.
//
// Options: --4k, --seconds N (default 10), --codec h264|hevc, --audio <file>, --runs N (default 2),
//          --conversion gpu-nv12|swscale (default per codec), --readback sync|async (default sync),
//          --depth N (async PBO ring, default 3), --no-hash (pure throughput, no determinism check)

import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { decodeMono48k } from '../src/analysis/decode.ts';
import { encodeWavFloat32 } from '../src/export/audio.ts';
import { probeEncoders } from '../src/export/encoder-probe.ts';
import { defaultEncodeSettings, type ColorConversion, type EncodeSettings, type VideoCodec } from '../src/export/ffmpeg-args.ts';
import { FFMPEG_EXE } from '../setup/lib/paths.ts';
import { SPIKE_OUT, bundleElectron, fail } from './harness.ts';
import { ExportRunError, FFPROBE_EXE, perFrameMs, runExportSpike } from './lib/export-run.ts';
import { spikeProject } from './project.ts';
import { synthesizeTestTrack } from './test-signal.ts';

const MB = 1024 * 1024;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      '4k': { type: 'boolean', default: false },
      seconds: { type: 'string', default: '10' },
      codec: { type: 'string', default: 'h264' },
      depth: { type: 'string', default: '3' },
      audio: { type: 'string' },
      runs: { type: 'string', default: '2' },
      readback: { type: 'string', default: 'sync' },
      conversion: { type: 'string' },
      'no-hash': { type: 'boolean', default: false },
    },
  });
  if (!existsSync(FFMPEG_EXE) || !existsSync(FFPROBE_EXE)) fail('The vendored FFmpeg is not installed.', ['Run `npm run setup -- --tier core`.']);
  const codec = values.codec as VideoCodec;
  if (codec !== 'h264' && codec !== 'hevc') fail(`--codec must be h264 or hevc, got ${values.codec}`, ['Use --codec h264 (8-bit) or --codec hevc (10-bit master).']);
  const readbackMode = values.readback;
  if (readbackMode !== 'async' && readbackMode !== 'sync') fail(`--readback must be async or sync, got ${readbackMode}`, ['Use --readback sync (default) or --readback async (PBO ring).']);
  if (values.conversion !== undefined && values.conversion !== 'swscale' && values.conversion !== 'gpu-nv12') {
    fail(`--conversion must be gpu-nv12 or swscale, got ${values.conversion}`, ['Omit it for the default (gpu-nv12 for 8-bit H.264, swscale for 10-bit HEVC).']);
  }
  const width = values['4k'] ? 3840 : 1920;
  const height = values['4k'] ? 2160 : 1080;
  const seconds = Number(values.seconds);
  const depth = Number(values.depth);
  const runs = Number(values.runs);
  const hashFrames = !values['no-hash'];
  if (!(seconds > 0 && seconds <= 3600)) fail(`--seconds must be in (0, 3600], got ${values.seconds}`, ['Pass e.g. --seconds 10.']);
  if (!(Number.isInteger(depth) && depth >= 1 && depth <= 16)) fail(`--depth must be 1..16, got ${values.depth}`, ['Pass e.g. --depth 3.']);
  if (!(Number.isInteger(runs) && runs >= 1 && runs <= 5)) fail(`--runs must be 1..5, got ${values.runs}`, ['Pass e.g. --runs 2.']);
  const defaults = defaultEncodeSettings(codec);
  const settings: EncodeSettings = { ...defaults, conversion: (values.conversion as ColorConversion | undefined) ?? defaults.conversion };

  const workDir = join(SPIKE_OUT, 'export');
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });

  console.log('▶ Encoder capability probe');
  const capabilities = await probeEncoders(FFMPEG_EXE);

  console.log('▶ Bundling spike harness');
  await bundleElectron();

  console.log('▶ Audio + analysis');
  let audioPath: string;
  let audioLabel: string;
  let mono: Float32Array;
  if (values.audio !== undefined) {
    const decoded = await decodeMono48k(FFMPEG_EXE, values.audio).catch((error: Error) => fail(`Could not decode ${values.audio}: ${error.message}`, ['Check the file plays in a media player.']));
    mono = decoded.pcm.subarray(0, Math.min(decoded.pcm.length, Math.round(seconds * 48_000)));
    audioPath = values.audio;
    audioLabel = values.audio;
  } else {
    mono = synthesizeTestTrack(seconds);
    audioPath = join(workDir, 'test-track.wav');
    await writeFile(audioPath, encodeWavFloat32([mono, mono], 48_000));
    audioLabel = 'synthetic test track (spike/test-signal.ts)';
  }

  console.log(`▶ Export: ${width}×${height} ${settings.codec.toUpperCase()} ${settings.bitDepth}-bit, ${runs} run(s), ${readbackMode} readback${hashFrames ? '' : ', no frame hashing'}`);
  const summary = await runExportSpike({
    workDir,
    name: 'export',
    project: spikeProject(width, height),
    analysisPcm: mono,
    audioPath,
    audioLabel,
    durationTicks: mono.length, // 48 kHz samples are ticks (D10)
    settings,
    readbackMode,
    readbackDepth: depth,
    hashFrames,
    dither: true,
    runs,
    onProgress: (line) => process.stdout.write(`  ${line}\r`),
  }).catch((error: Error) =>
    fail(error.message, ['The message names the failing stage (prepare, audio, encode).', ...(error instanceof ExportRunError ? [`Renderer log tail:\n${error.log.trim().split('\n').slice(-10).join('\n')}`] : [])]),
  );
  process.stdout.write('\n');

  const { first } = summary;
  const report = first.report;
  const t = report.timing;
  const lines = [
    '',
    '================= Pulseforge P0 — export spike =================',
    `GPU:              ${report.gpu.renderer}`,
    `Electron/Chrome:  ${first.electronVersion} / ${first.chromeVersion}`,
    `Output:           ${width}×${height} @ ${report.canvas.fps} fps, ${t.frames} frames, ${report.encode.settings.codec.toUpperCase()} ${report.encode.settings.bitDepth}-bit ${report.encode.settings.chroma}, ${report.encode.settings.preset}, CQ ${report.encode.settings.cq}, RGB→YUV via ${report.encode.settings.conversion}`,
    `Audio:            ${audioLabel}; ${report.audio?.totalSamples ?? 0} samples, adjustment ${report.audio?.adjustmentSamples ?? 0}`,
    `File:             ${report.output.path} (${(report.output.bytes / MB).toFixed(1)} MB)`,
    '',
    `Throughput:       ${t.fps.toFixed(1)} fps end-to-end (${(t.fps / 60).toFixed(2)}× realtime at 60 fps)`,
    `Where time goes:  render cmds ${perFrameMs(report, t.renderMs)} · wait GPU ${perFrameMs(report, t.waitGpuMs)} · readback copy ${perFrameMs(report, t.collectMs)} · frame hash ${perFrameMs(report, t.onFrameMs)} · wait encoder ${perFrameMs(report, t.waitEncoderMs)}`,
    `Pipeline depth:   ${report.encode.readbackMode} readback, depth ${report.encode.readbackDepth} (max pending ${t.maxPendingReadbacks}), write queue max ${t.maxQueuedWrites}${report.encode.readbackMode === 'sync' ? ' — sync: "readback copy" includes the GPU wait' : ''}`,
    `Setup/finalize:   prepare ${t.prepareMs.toFixed(0)} ms, encoder flush + verify ${t.finalizeMs.toFixed(0)} ms`,
    '',
    `Verification:     ${summary.verified ? 'PASS' : 'FAIL'} — frames ${report.verification.videoFrames}/${t.frames}, video ${report.verification.videoSeconds?.toFixed(4)} s, audio ${report.verification.audioSeconds?.toFixed(4)} s`,
    ...summary.runs.flatMap((r) => r.report.verification.issues.map((i) => `  run ${r.run}: ${i}`)),
    `Raw frames:       ${summary.framesIdentical === undefined ? (hashFrames ? 'single run' : 'not hashed (--no-hash)') : summary.framesIdentical ? `IDENTICAL across ${runs} runs (${report.frames.combinedSha256?.slice(0, 16)}…)` : `DIFFER — first at frame ${summary.firstFrameMismatch}`}`,
    `MP4 files:        ${summary.filesIdentical === undefined ? 'single run' : summary.filesIdentical ? `IDENTICAL across ${runs} runs (bit-exact muxing, ${first.fileSha256.slice(0, 16)}…)` : 'DIFFER (encoder/muxer, not engine — see export-spec §0)'}`,
    '',
    'Encoder capabilities (this GPU + driver):',
    ...capabilities.map((c) => `  ${c.available ? '✔' : '✖'} ${c.label}`),
    ...(report.warnings.length > 0 ? ['Warnings:', ...report.warnings.map((w) => `  ${w}`)] : []),
    `Render report:    ${first.outputPath}.report.json`,
    `FFmpeg command:   ${report.encode.commandLine}`,
    '================================================================',
    '',
  ];
  console.log(lines.join('\n'));
  process.exitCode = summary.verified && summary.framesIdentical !== false ? 0 : 1;
}

await main();
