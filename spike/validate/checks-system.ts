// Validation checks 1 and 5–8: environment, encoder matrix, throughput, stems, A/V sync.

import { existsSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { cpus, release, totalmem } from 'node:os';
import { join } from 'node:path';
import { computeSourceAnalysis } from '../../src/analysis/spectrum.ts';
import { flashLit } from '../../src/engine/modules/flash.ts';
import { encodeWavFloat32 } from '../../src/export/audio.ts';
import { probeEncoders } from '../../src/export/encoder-probe.ts';
import { defaultEncodeSettings } from '../../src/export/ffmpeg-args.ts';
import { runSidecar, type SidecarEvent } from '../../src/ml/sidecar.ts';
import { pythonEnv } from '../../setup/lib/env.ts';
import { FFMPEG_EXE, MODELS, NVIDIA_SMI_EXE, PYTHON_EXE, ROOT, VENDOR_LOCK } from '../../setup/lib/paths.ts';
import { run } from '../../setup/lib/proc.ts';
import { createLogger } from '../../setup/lib/log.ts';
import { synthesizeTestTrack } from '../test-signal.ts';
import { exportCase } from './checks-render.ts';
import { table, type Check } from './context.ts';
import { decodeAudioMono, decodeMeanLuma, resampleToRawFloat, runFfmpeg } from './media.ts';
import { CLICK_SCHEDULE, clickProject, clickTimes, clickTrack, heavyProject } from './projects.ts';

// ---------------------------------------------------------------------------
// 1. Environment
// ---------------------------------------------------------------------------
export const checkEnvironment: Check = async (ctx) => {
  const lines: string[] = [];
  const data: Record<string, unknown> = {};
  let status: 'pass' | 'warn' | 'fail' = 'pass';
  const quietLog = createLogger(join(ctx.workDir, 'validate-subprocess.log'), { isTTY: false, write: () => true } as unknown as NodeJS.WriteStream);

  const smi = await run(NVIDIA_SMI_EXE, ['--query-gpu=name,driver_version,memory.total,pcie.link.gen.max,pcie.link.width.max,vbios_version', '--format=csv,noheader,nounits'], { step: 'environment', log: quietLog });
  const [gpu, driver, vram, pcieGen, pcieWidth, vbios] = (smi.stdout.split(/\r?\n/)[0] ?? '').split(',').map((s) => s.trim());
  data['gpu'] = { gpu, driver, vramMiB: Number(vram), pcieGen: Number(pcieGen), pcieWidth: Number(pcieWidth), vbios };
  if (smi.code !== 0) status = 'fail';
  if (Number(pcieGen) < 3 || Number(pcieWidth) < 16) status = 'warn';

  const ffmpegVersion = (await runFfmpeg(['-version'])).stdout.toString().split(/\r?\n/)[0] ?? '?';
  let health: Record<string, unknown>;
  try {
    health = (await runSidecar({ pythonExe: PYTHON_EXE, packageRoot: join(ROOT, 'python'), args: ['health'], env: pythonEnv() })).result;
  } catch (error) {
    health = { error: (error as Error).message };
    status = 'fail';
  }
  if (health['cudaAvailable'] !== true) status = 'fail';
  const lock = existsSync(VENDOR_LOCK) ? (JSON.parse(await readFile(VENDOR_LOCK, 'utf8')) as { artefacts: Array<{ id: string; version: string }> }) : undefined;
  const webgl = ctx.webgl;

  lines.push(
    ...table(
      ['Item', 'Value'],
      [
        ['GPU', `${gpu} (${vram} MiB, VBIOS ${vbios})`],
        ['Driver', driver ?? '?'],
        ['PCIe link (max)', `Gen${pcieGen} x${pcieWidth}`],
        ['CPU', `${cpus()[0]?.model.trim() ?? '?'} (${cpus().length} threads)`],
        ['RAM', `${(totalmem() / 1024 ** 3).toFixed(0)} GB`],
        ['Windows', release()],
        ['Node', process.version],
        ['Electron / Chrome', webgl ? `${webgl.electronVersion} / ${webgl.chromeVersion}` : 'not measured (run check 2)'],
        ['WebGL renderer', webgl?.context?.renderer ?? 'not measured'],
        ['WebGL version', webgl?.context ? `${webgl.context.version}; ${webgl.context.shadingLanguageVersion}` : '—'],
        ['Max texture / renderbuffer', webgl?.context ? `${webgl.context.maxTextureSize} / ${webgl.context.maxRenderbufferSize}` : '—'],
        ['EXT_color_buffer_float', webgl?.context ? String(webgl.context.extensions.includes('EXT_color_buffer_float')) : '—'],
        ['FFmpeg', ffmpegVersion],
        ['Python / torch / CUDA', `${health['python']} / ${health['torch']} / ${health['torchCuda']} (cuDNN ${health['cudnn']}), CUDA available: ${health['cudaAvailable']}`],
        ['Demucs', String(health['demucs'] ?? health['demucsError'] ?? health['error'])],
        ['Vendored artefacts', lock ? lock.artefacts.map((a) => `${a.id} ${a.version}`).join('; ') : 'vendor.lock.json missing'],
      ],
    ),
  );
  data['health'] = health;
  data['webgl'] = webgl;
  data['ffmpeg'] = ffmpegVersion;
  return { id: 1, title: 'Environment', status, lines, data };
};

// ---------------------------------------------------------------------------
// 5. Encoder matrix
// ---------------------------------------------------------------------------
export const checkEncoders: Check = async (ctx) => {
  const capabilities = await probeEncoders(FFMPEG_EXE);
  const frames = ctx.quick ? 120 : 300;
  const presets = ctx.quick ? ['p5'] : ['p1', 'p5', 'p7'];
  const sizes = ctx.quick ? ['1920x1080'] : ['1920x1080', '3840x2160'];
  const variants = [
    { id: 'h264-8-420', codec: 'h264_nvenc', profile: 'high', pix: 'yuv420p', cq: 17 },
    { id: 'h264-8-444', codec: 'h264_nvenc', profile: 'high444p', pix: 'yuv444p', cq: 17 },
    { id: 'hevc-8-420', codec: 'hevc_nvenc', profile: 'main', pix: 'yuv420p', cq: 19 },
    { id: 'hevc-10-420', codec: 'hevc_nvenc', profile: 'main10', pix: 'p010le', cq: 19 },
    { id: 'hevc-8-444', codec: 'hevc_nvenc', profile: 'rext', pix: 'yuv444p', cq: 19 },
    { id: 'hevc-10-444', codec: 'hevc_nvenc', profile: 'rext', pix: 'yuv444p16le', cq: 19 },
  ].filter((v) => capabilities.find((c) => c.id === v.id)?.available);

  const rows: Array<Array<string | number>> = [];
  const data: Array<Record<string, unknown>> = [];
  for (const size of sizes) {
    for (const v of variants) {
      // Baseline: the same source and pixel format without an encoder, subtracted from each timing.
      const source = ['-f', 'lavfi', '-i', `testsrc2=s=${size}:r=60,format=${v.pix}`, '-frames:v', String(frames)];
      const baseline = await runFfmpeg(['-loglevel', 'error', ...source, '-f', 'null', '-']);
      for (const preset of presets) {
        const out = join(ctx.workDir, `enc-${size}-${v.id}-${preset}.mp4`);
        ctx.log(`encoder matrix: ${size} ${v.id} ${preset}`);
        const result = await runFfmpeg(['-loglevel', 'error', '-y', ...source, '-c:v', v.codec, '-preset', preset, '-tune', 'hq', '-rc', 'vbr', '-cq', String(v.cq), '-b:v', '0', '-profile:v', v.profile, '-g', '120', '-bf', '3', '-rc-lookahead', '32', out]);
        const encodeMs = Math.max(1, result.ms - baseline.ms);
        const bytes = result.code === 0 ? (await stat(out)).size : 0;
        const fps = frames / (encodeMs / 1000);
        const mbPerMin = (bytes / (1024 * 1024)) * (3600 / frames);
        rows.push([size, v.id, preset, result.code === 0 ? fps.toFixed(0) : 'FAILED', result.code === 0 ? mbPerMin.toFixed(0) : '—']);
        data.push({ size, variant: v.id, preset, ok: result.code === 0, encodeFps: fps, mbPerMinute: mbPerMin, stderr: result.code === 0 ? undefined : result.stderr.slice(-500) });
      }
    }
  }
  const unavailable = capabilities.filter((c) => !c.available).map((c) => c.label);
  return {
    id: 5,
    title: 'Encoder matrix',
    status: data.every((d) => d['ok']) ? 'pass' : 'fail',
    lines: [
      `NVENC encode speed from an in-process \`testsrc2\` source (${frames} frames, source generation time subtracted); D40 quality (CQ 17 H.264 / 19 HEVC, VBR, lookahead 32, 3 B-frames). Size is for synthetic content — relative, not representative of real footage.`,
      '',
      ...table(['Size', 'Variant', 'Preset', 'Encode fps', 'MB / min'], rows),
      '',
      `Not available on this GPU/driver: ${unavailable.length > 0 ? unavailable.join(', ') : 'none'}.`,
    ],
    data: { capabilities, rows: data },
  };
};

// ---------------------------------------------------------------------------
// 6. Throughput
// ---------------------------------------------------------------------------
export const checkThroughput: Check = async (ctx) => {
  const seconds = ctx.quick ? 15 : 60;
  const cases = [
    { label: '1080p60 H.264 (GPU NV12)', w: 1920, h: 1080, settings: defaultEncodeSettings('h264') },
    ...(ctx.quick ? [] : [
      { label: '4K60 H.264 (GPU NV12)', w: 3840, h: 2160, settings: defaultEncodeSettings('h264') },
      { label: '1080p60 HEVC 10-bit (swscale)', w: 1920, h: 1080, settings: defaultEncodeSettings('hevc') },
      { label: '4K60 HEVC 10-bit (swscale)', w: 3840, h: 2160, settings: defaultEncodeSettings('hevc') },
    ]),
  ];
  const rows: Array<Array<string | number>> = [];
  const data: Array<Record<string, unknown>> = [];
  for (const c of cases) {
    const s = await exportCase(ctx, { name: `throughput-${c.w}-${c.settings.codec}`, project: heavyProject(c.w, c.h), seconds, settings: c.settings, readbackMode: 'sync', depth: 1, hash: false, dither: true, runs: 1 });
    const r = s.first.report;
    const t = r.timing;
    const per = (ms: number) => (ms / t.frames).toFixed(2);
    rows.push([c.label, t.fps.toFixed(1), `${(t.fps / 60).toFixed(2)}×`, `${((t.wallMs + t.prepareMs + t.finalizeMs) / 1000).toFixed(1)} s`, per(t.renderMs), per(t.collectMs), per(t.waitEncoderMs), `${(r.output.bytes / 1024 ** 2).toFixed(0)} MB`, s.verified ? 'pass' : 'FAIL']);
    data.push({ label: c.label, fps: t.fps, timing: t, bytes: r.output.bytes, verified: s.verified });
  }
  return {
    id: 6,
    title: 'Throughput',
    status: data.every((d) => d['verified']) ? 'pass' : 'fail',
    lines: [
      `${seconds} s exports of a six-layer bars project (normal/add/screen blends), sync readback, no frame hashing. This bounds the pipeline; real projects with bloom and 3D will be shader-bound and slower.`,
      '',
      ...table(['Export', 'fps', 'Realtime', 'Wall', 'render ms', 'readback ms', 'wait encoder ms', 'Size', 'Verify'], rows),
    ],
    data: { seconds, rows: data },
  };
};

// ---------------------------------------------------------------------------
// 7. Stems
// ---------------------------------------------------------------------------
export const checkStems: Check = async (ctx) => {
  const seconds = ctx.quick ? 60 : 240;
  const wav = join(ctx.workDir, 'stems-input.wav');
  const raw = join(ctx.workDir, 'stems-input-44k.f32');
  const pcm = synthesizeTestTrack(seconds);
  await writeFile(wav, encodeWavFloat32([pcm, pcm], 48_000));
  await resampleToRawFloat(wav, raw, 44_100, 2);

  const models = ['htdemucs', 'htdemucs_ft'];
  const rows: Array<Array<string | number>> = [];
  const data: Array<Record<string, unknown>> = [];
  let status: 'pass' | 'fail' | 'warn' = 'pass';
  for (const model of models) {
    if (!existsSync(join(MODELS, 'demucs', `${model}.yaml`))) {
      rows.push([model, 'not installed', '—', '—', '—', '—', 'setup fetches htdemucs only (D8); add htdemucs_ft to setup/manifest.ts to measure']);
      data.push({ model, installed: false });
      if (model === 'htdemucs') status = 'fail';
      continue;
    }
    ctx.log(`stems: ${model} on ${seconds} s`);
    let progressEvents = 0;
    try {
      const { result, wallMs } = await runSidecar({
        pythonExe: PYTHON_EXE,
        packageRoot: join(ROOT, 'python'),
        env: pythonEnv(),
        args: ['separate', '--input', raw, '--channels', '2', '--sample-rate', '44100', '--model', model, '--repo', join(MODELS, 'demucs')],
        onEvent: (event: SidecarEvent) => {
          if (event.event === 'progress') {
            progressEvents++;
            ctx.log(`  ${model} ${(event.fraction * 100).toFixed(0)}%`);
          }
        },
      });
      const num = (k: string) => Number(result[k]);
      rows.push([model, `${num('separateSeconds').toFixed(1)} s`, `${num('realtimeFactor').toFixed(1)}×`, `${num('loadSeconds').toFixed(1)} s`, `${(num('peakAllocatedMiB') / 1024).toFixed(2)} / ${(num('peakReservedMiB') / 1024).toFixed(2)} GB`, progressEvents, `wall incl. Python start ${(wallMs / 1000).toFixed(1)} s`]);
      data.push({ model, installed: true, wallMs, progressEvents, ...result });
    } catch (error) {
      status = 'fail';
      rows.push([model, 'FAILED', '—', '—', '—', progressEvents, (error as Error).message]);
      data.push({ model, installed: true, error: (error as Error).message });
    }
  }
  return {
    id: 7,
    title: 'Stems (Demucs)',
    status,
    lines: [
      `${seconds} s synthetic stereo track, 44.1 kHz, CUDA, shifts 1, overlap 0.25, driven from Node over the JSON-lines sidecar protocol with live progress events. VRAM = torch peak allocated / reserved.`,
      '',
      ...table(['Model', 'Separation', 'Realtime', 'Model load', 'Peak VRAM', 'Progress events', 'Notes'], rows),
      '',
      `A 4-minute track corresponds to the ${seconds === 240 ? 'figures above' : `figures above × ${(240 / seconds).toFixed(0)}`}.`,
    ],
    data: { seconds, models: data },
  };
};

// ---------------------------------------------------------------------------
// 8. A/V sync
// ---------------------------------------------------------------------------
export const checkSync: Check = async (ctx) => {
  const seconds = 10;
  const fps = 60;
  const [left, right] = clickTrack(seconds);
  const s = await exportCase(ctx, { name: 'sync', project: clickProject(1920, 1080), seconds, settings: defaultEncodeSettings('h264'), readbackMode: 'sync', depth: 1, hash: false, dither: true, runs: 1, pcm: left, stereo: [left, right] });
  const file = s.first.outputPath;

  const luma = await decodeMeanLuma(file);
  const videoOnsets: number[] = [];
  luma.forEach((v, i) => {
    if (v > 128 && (luma[i - 1] ?? 0) <= 128) videoOnsets.push(i);
  });
  const audio = await decodeAudioMono(file);
  const audioOnsets: number[] = [];
  let lastLoud = -Infinity;
  for (let i = 0; i < audio.length; i++) {
    if (Math.abs(audio[i] ?? 0) > 0.2) {
      if (i - lastLoud > 4800) audioOnsets.push(i);
      lastLoud = i;
    }
  }

  const clicks = clickTimes(seconds);
  const pairs = clicks.map((click, k) => {
    const expectedFrame = Math.ceil(click * fps - 1e-9);
    const videoFrame = videoOnsets[k];
    const audioSample = audioOnsets[k];
    const videoT = videoFrame === undefined ? undefined : videoFrame / fps;
    const audioT = audioSample === undefined ? undefined : audioSample / 48_000;
    return { click, expectedFrame, videoFrame, audioSample, offsetMs: videoT !== undefined && audioT !== undefined ? (videoT - audioT) * 1000 : undefined };
  });
  const offsets = pairs.map((p) => p.offsetMs).filter((o): o is number => o !== undefined);
  const frameMs = 1000 / fps;
  const matched = offsets.length === clicks.length && videoOnsets.length === clicks.length && audioOnsets.length === clicks.length;
  const framesExact = pairs.every((p) => p.videoFrame === p.expectedFrame);
  const worst = offsets.length > 0 ? Math.max(...offsets.map(Math.abs)) : Infinity;
  const within = offsets.every((o) => o > -1.5 && o < frameMs + 0.5);

  // Informational: how early/late the analysis sees the clicks (FFT window smear — relevant to D23's look-ahead).
  const analysis = computeSourceAnalysis(left);
  const bins = analysis.spectrum.channels;
  const energy = Array.from({ length: analysis.spectrum.data.length / bins }, (_, f) => {
    let sum = 0;
    for (let b = 0; b < bins; b++) sum += analysis.spectrum.data[f * bins + b] ?? 0;
    return sum / bins;
  });
  // Relative threshold: halfway between the quiet floor and the loudest analysis frame.
  const floor = Math.min(...energy);
  const threshold = floor + (Math.max(...energy) - floor) / 2;
  const analysisOffsets = clicks.map((click) => {
    const from = Math.max(0, Math.floor((click - 0.1) * 240));
    const to = Math.min(energy.length - 1, Math.ceil((click + 0.1) * 240));
    for (let f = from; f <= to; f++) if ((energy[f] ?? 0) >= threshold) return (f / 240 - click) * 1000;
    return undefined;
  }).filter((o): o is number => o !== undefined);
  const meanAnalysisOffset = analysisOffsets.length > 0 ? analysisOffsets.reduce((a, b) => a + b, 0) / analysisOffsets.length : undefined;

  const expectedLit = Array.from({ length: seconds * fps }, (_, n) => flashLit(n / fps, CLICK_SCHEDULE.first, CLICK_SCHEDULE.period, CLICK_SCHEDULE.duration)).filter(Boolean).length;
  const litFrames = luma.filter((v) => v > 128).length;

  return {
    id: 8,
    title: 'A/V sync',
    status: matched && framesExact && within ? 'pass' : 'fail',
    lines: [
      `Flash layer on a fixed schedule (first ${CLICK_SCHEDULE.first} s, every ${CLICK_SCHEDULE.period} s) and 5 ms clicks at the same times; exported H.264 + AAC, then both streams decoded from the MP4 (AAC priming handled by FFmpeg).`,
      '',
      ...table(
        ['Measure', 'Result'],
        [
          ['Clicks / video onsets / audio onsets', `${clicks.length} / ${videoOnsets.length} / ${audioOnsets.length}`],
          ['Flash on the first frame at or after each click', framesExact ? 'yes, every click' : `NO: ${pairs.filter((p) => p.videoFrame !== p.expectedFrame).map((p) => `click ${p.click.toFixed(3)} s → frame ${p.videoFrame} (expected ${p.expectedFrame})`).join('; ')}`],
          ['Video − audio onset', `mean ${(offsets.reduce((a, b) => a + b, 0) / Math.max(1, offsets.length)).toFixed(2)} ms, worst |${worst.toFixed(2)}| ms (must be within one frame, ${frameMs.toFixed(2)} ms)`],
          ['Lit frames', `${litFrames} (expected ${expectedLit})`],
          ['Analysis onset vs click (informational)', meanAnalysisOffset === undefined ? 'not detected' : `${meanAnalysisOffset.toFixed(1)} ms over ${analysisOffsets.length} clicks (240 Hz frames, 2048-sample FFT window; negative = the analysis sees the click before it happens)`],
        ],
      ),
    ],
    data: { pairs, videoOnsets, audioOnsets: audioOnsets.map((s) => s / 48_000), meanAnalysisOffsetMs: meanAnalysisOffset, litFrames, expectedLit },
  };
};
