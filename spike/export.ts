// npm run spike:export — P0 step 4: the real export path on the real GPU.
//
//   render (engine) → async PBO readback → FFmpeg stdin → NVENC → mux with AAC audio
//   → ffprobe verification → render report beside the file
//
// Runs the export twice in separate Electron processes and checks that every raw frame and
// the bit-exact MP4 are byte-identical, the frame count is exact, all colour tags are present,
// and audio length is within one frame of video.
//
// Options: --4k, --seconds N (default 10), --codec h264|hevc, --audio <file>, --runs N (default 2),
//          --conversion gpu-nv12|swscale (default per codec), --readback sync|async (default sync),
//          --depth N (async PBO ring, default 3), --no-hash (pure throughput, no determinism check)

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { decodeMono48k } from '../src/analysis/decode.ts';
import { ANALYSIS_VERSION, computeSourceAnalysis } from '../src/analysis/spectrum.ts';
import { encodeWavFloat32 } from '../src/export/audio.ts';
import { probeEncoders } from '../src/export/encoder-probe.ts';
import { defaultEncodeSettings, type ColorConversion, type EncodeSettings, type VideoCodec } from '../src/export/ffmpeg-args.ts';
import { FFMPEG_EXE, VENDOR } from '../setup/lib/paths.ts';
import { encodeAnalysis } from './analysis-file.ts';
import type { ExportConfig, SpikeExportResult } from './electron/protocol.ts';
import { SPIKE_OUT, bundleElectron, fail, runElectron } from './harness.ts';
import { synthesizeTestTrack } from './test-signal.ts';

const FFPROBE_EXE = join(VENDOR, 'ffmpeg', 'bin', 'ffprobe.exe');
const MB = 1024 * 1024;

async function sha256File(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

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
  const readbackMode = values.readback;
  if (readbackMode !== 'async' && readbackMode !== 'sync') fail(`--readback must be async or sync, got ${readbackMode}`, ['Use --readback async (PBO ring) or --readback sync (readPixels).']);
  const hashFrames = !values['no-hash'];
  if (!existsSync(FFMPEG_EXE) || !existsSync(FFPROBE_EXE)) {
    fail('The vendored FFmpeg is not installed.', ['Run `npm run setup -- --tier core`.']);
  }
  const codec = values.codec as VideoCodec;
  if (codec !== 'h264' && codec !== 'hevc') fail(`--codec must be h264 or hevc, got ${values.codec}`, ['Use --codec h264 (8-bit) or --codec hevc (10-bit master).']);
  const width = values['4k'] ? 3840 : 1920;
  const height = values['4k'] ? 2160 : 1080;
  const seconds = Number(values.seconds);
  const depth = Number(values.depth);
  const runs = Number(values.runs);
  if (!(seconds > 0 && seconds <= 3600)) fail(`--seconds must be in (0, 3600], got ${values.seconds}`, ['Pass e.g. --seconds 10.']);
  if (!(Number.isInteger(depth) && depth >= 1 && depth <= 16)) fail(`--depth must be 1..16, got ${values.depth}`, ['Pass e.g. --depth 3.']);
  if (!(Number.isInteger(runs) && runs >= 1 && runs <= 5)) fail(`--runs must be 1..5, got ${values.runs}`, ['Pass e.g. --runs 2.']);
  if (values.conversion !== undefined && values.conversion !== 'swscale' && values.conversion !== 'gpu-nv12') {
    fail(`--conversion must be gpu-nv12 or swscale, got ${values.conversion}`, ['Omit it for the default (gpu-nv12 for 8-bit H.264, swscale for 10-bit HEVC).']);
  }
  const defaults = defaultEncodeSettings(codec);
  const settings: EncodeSettings = { ...defaults, conversion: (values.conversion as ColorConversion | undefined) ?? defaults.conversion };
  const workDir = join(SPIKE_OUT, 'export');
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });

  console.log('▶ Encoder capability probe');
  const capabilities = await probeEncoders(FFMPEG_EXE);
  if (!capabilities.find((c) => c.id === (codec === 'hevc' ? 'hevc-10-420' : 'h264-8-420'))?.available) {
    fail(`This GPU/driver cannot encode ${settings.codec} ${settings.bitDepth}-bit.`, ['Check `nvidia-smi` and the driver version.', 'See the capability table printed by `npm run validate`.']);
  }

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
  const analysisFile = join(workDir, 'analysis.bin');
  await writeFile(analysisFile, encodeAnalysis('mix', computeSourceAnalysis(mono), { analysisVersion: ANALYSIS_VERSION }));
  const durationTicks = mono.length; // 48 kHz samples are ticks (D10)

  const results: Array<{ run: number; result: SpikeExportResult; fileSha: string }> = [];
  for (let run = 1; run <= runs; run++) {
    console.log(`▶ Export run ${run} of ${runs}: ${width}×${height} ${settings.codec.toUpperCase()} ${settings.bitDepth}-bit, ${readbackMode === 'sync' ? 'sync readback' : `async readback depth ${depth}`}${hashFrames ? '' : ', no frame hashing'}`);
    const config: ExportConfig = {
      mode: 'export',
      analysisFile,
      resultFile: join(workDir, `result-${run}.json`),
      audioPath,
      audioLabel,
      durationTicks,
      width,
      height,
      outputPath: join(workDir, `export-run${run}.mp4`),
      scratchDir: join(workDir, `scratch-${run}`),
      settings,
      readbackMode,
      hashFrames,
      readbackDepth: depth,
      maxQueuedWrites: 4,
      ffmpegExe: FFMPEG_EXE,
      ffprobeExe: FFPROBE_EXE,
    };
    const { result, log } = await runElectron<SpikeExportResult>(config, (line) => process.stdout.write(`  ${line}\r`)).catch((error: Error) =>
      fail(error.message, ['Check that the GPU driver is working (nvidia-smi).']),
    );
    process.stdout.write('\n');
    if (!result.ok || result.report === undefined) {
      fail(`Export run ${run} failed: ${result.error ?? 'no report'}`, ['The message above names the failing stage (prepare, audio, encode).', `Renderer log tail:\n${log.trim().split('\n').slice(-10).join('\n')}`]);
    }
    results.push({ run, result, fileSha: await sha256File(config.outputPath) });
  }

  const first = results[0]!;
  const report = first.result.report!;
  const t = report.timing;
  const frameMismatch = results.slice(1).map((r) => ({
    run: r.run,
    frame: hashFrames ? first.result.frameHashes!.findIndex((h, i) => h !== r.result.frameHashes![i]) : -1,
    fileSame: r.fileSha === first.fileSha,
  }));
  const framesIdentical = frameMismatch.every((m) => m.frame === -1);
  const filesIdentical = frameMismatch.every((m) => m.fileSame);
  const verified = results.every((r) => r.result.report!.verification.ok);
  const perFrame = (ms: number) => `${(ms / t.frames).toFixed(2)} ms`;

  const lines = [
    '',
    '================= Pulseforge P0 — export spike =================',
    `GPU:              ${report.gpu.renderer}`,
    `Electron/Chrome:  ${first.result.electronVersion} / ${first.result.chromeVersion}`,
    `Output:           ${width}×${height} @ ${report.canvas.fps} fps, ${t.frames} frames, ${settings.codec.toUpperCase()} ${settings.bitDepth}-bit ${settings.chroma}, ${settings.preset}, CQ ${settings.cq}, RGB→YUV via ${settings.conversion}`,
    `Audio:            ${audioLabel}; ${report.audio?.totalSamples ?? 0} samples, adjustment ${report.audio?.adjustmentSamples ?? 0}`,
    `File:             ${report.output.path} (${(report.output.bytes / MB).toFixed(1)} MB)`,
    '',
    `Throughput:       ${t.fps.toFixed(1)} fps end-to-end (${(t.fps / (report.canvas.fps === '60/1' ? 60 : 1)).toFixed(2)}× realtime at 60 fps)`,
    `Where time goes:  render cmds ${perFrame(t.renderMs)} · wait GPU ${perFrame(t.waitGpuMs)} · PBO copy ${perFrame(t.collectMs)} · frame hash ${perFrame(t.onFrameMs)} · wait encoder ${perFrame(t.waitEncoderMs)}`,
    `Pipeline depth:   ${report.encode.readbackMode} readback, depth ${report.encode.readbackDepth} (max pending ${t.maxPendingReadbacks}), write queue max ${t.maxQueuedWrites}${report.encode.readbackMode === 'sync' ? ' — sync: "PBO copy" is readPixels incl. GPU wait' : ''}`,
    `Setup/finalize:   prepare ${t.prepareMs.toFixed(0)} ms, encoder flush + verify ${t.finalizeMs.toFixed(0)} ms`,
    '',
    `Verification:     ${verified ? 'PASS' : 'FAIL'} — frames ${report.verification.videoFrames}/${t.frames}, video ${report.verification.videoSeconds?.toFixed(4)} s, audio ${report.verification.audioSeconds?.toFixed(4)} s`,
    ...results.flatMap((r) => r.result.report!.verification.issues.map((i) => `  run ${r.run}: ${i}`)),
    `Raw frames:       ${!hashFrames ? 'not hashed (--no-hash)' : runs < 2 ? 'single run' : framesIdentical ? `IDENTICAL across ${runs} runs (${report.frames.combinedSha256?.slice(0, 16)}…)` : `DIFFER — ${frameMismatch.filter((m) => m.frame !== -1).map((m) => `run ${m.run} first at frame ${m.frame}`).join('; ')}`}`,
    `MP4 files:        ${runs < 2 ? 'single run' : filesIdentical ? `IDENTICAL across ${runs} runs (bit-exact muxing, ${first.fileSha.slice(0, 16)}…)` : 'DIFFER (encoder/muxer, not engine — see export-spec §0)'}`,
    '',
    'Encoder capabilities (this GPU + driver):',
    ...capabilities.map((c) => `  ${c.available ? '✔' : '✖'} ${c.label.padEnd(20)} ${c.available ? '' : (c.reason ?? '')}`),
    ...(report.warnings.length > 0 ? ['Warnings:', ...report.warnings.map((w) => `  ${w}`)] : []),
    `Render report:    ${first.result.reportPath}`,
    `FFmpeg command:   ${report.encode.commandLine}`,
    '================================================================',
    '',
  ];
  console.log(lines.join('\n'));
  process.exitCode = verified && framesIdentical ? 0 : 1;
}

await main();
