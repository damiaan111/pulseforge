// Validation checks 2–4: determinism, readback benchmark, colour correctness.

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { linearToSrgb, parseHexColor, srgbToLinear, tonemap } from '../../src/engine/core/color.ts';
import { TEST_PATTERN_COLORS, TEST_PATTERN_COLUMNS, TEST_PATTERN_ROWS } from '../../src/engine/modules/test-pattern.ts';
import { encodeWavFloat32 } from '../../src/export/audio.ts';
import { defaultEncodeSettings, type EncodeSettings } from '../../src/export/ffmpeg-args.ts';
import type { RenderProject } from '../../src/engine/core/project.ts';
import { runDeterminismSpike } from '../lib/determinism-run.ts';
import { runExportSpike, type ExportRunSummary } from '../lib/export-run.ts';
import { spikeProject } from '../project.ts';
import { synthesizeTestTrack } from '../test-signal.ts';
import { table, type Check, type ValidateContext } from './context.ts';
import { decodeFrameLuma, decodeFrameRgb } from './media.ts';
import { patternProject } from './projects.ts';

interface ExportCase {
  readonly name: string;
  readonly project: RenderProject;
  readonly seconds: number;
  readonly settings: EncodeSettings;
  readonly readbackMode: 'sync' | 'async';
  readonly depth: number;
  readonly hash: boolean;
  readonly dither: boolean;
  readonly runs: number;
  readonly pcm?: Float32Array;
  readonly stereo?: readonly Float32Array[];
}

/** Runs one export case with synthetic (or given) audio. */
export async function exportCase(ctx: ValidateContext, c: ExportCase): Promise<ExportRunSummary> {
  const pcm = c.pcm ?? synthesizeTestTrack(c.seconds);
  const audioPath = join(ctx.workDir, `${c.name}.wav`);
  await writeFile(audioPath, encodeWavFloat32(c.stereo ? [...c.stereo] : [pcm, pcm], 48_000));
  ctx.log(`export ${c.name}: ${c.project.canvas.width}×${c.project.canvas.height} ${c.settings.codec} ${c.settings.bitDepth}-bit ${c.settings.conversion}, ${c.readbackMode}${c.readbackMode === 'async' ? ` d${c.depth}` : ''}, ${c.seconds} s × ${c.runs}`);
  return runExportSpike({
    workDir: ctx.workDir,
    name: c.name,
    project: c.project,
    analysisPcm: pcm,
    audioPath,
    audioLabel: 'synthetic',
    durationTicks: Math.round(c.seconds * 48_000),
    settings: c.settings,
    readbackMode: c.readbackMode,
    readbackDepth: c.depth,
    hashFrames: c.hash,
    dither: c.dither,
    runs: c.runs,
    onProgress: (line) => ctx.log(`  ${line}`),
  });
}

const swscale = (settings: EncodeSettings): EncodeSettings => ({ ...settings, conversion: 'swscale' });

// ---------------------------------------------------------------------------
// 2. Determinism
// ---------------------------------------------------------------------------
export const checkDeterminism: Check = async (ctx) => {
  const seconds = ctx.quick ? 3 : 10;
  ctx.log(`engine determinism, ${seconds} s at 1080p60`);
  const engine = await runDeterminismSpike({ width: 1920, height: 1080, frameCount: seconds * 60, pcm: synthesizeTestTrack(seconds), writeStills: false });
  ctx.webgl = { context: engine.context, electronVersion: engine.electronVersion, chromeVersion: engine.chromeVersion };

  const exportSeconds = ctx.quick ? 3 : 5;
  const h264 = await exportCase(ctx, { name: 'determinism-h264', project: spikeProject(1920, 1080), seconds: exportSeconds, settings: defaultEncodeSettings('h264'), readbackMode: 'sync', depth: 1, hash: true, dither: true, runs: 2 });
  const hevc = ctx.quick
    ? undefined
    : await exportCase(ctx, { name: 'determinism-hevc10', project: spikeProject(1920, 1080), seconds: exportSeconds, settings: defaultEncodeSettings('hevc'), readbackMode: 'sync', depth: 1, hash: true, dither: true, runs: 2 });

  const exports = [['H.264 8-bit gpu-nv12', h264], ...(hevc ? [['HEVC 10-bit swscale', hevc] as const] : [])] as const;
  const framesOk = exports.every(([, s]) => s.framesIdentical === true);
  const filesOk = exports.every(([, s]) => s.filesIdentical === true);
  const ok = engine.deterministic && engine.animated && framesOk;

  return {
    id: 2,
    title: 'Determinism',
    status: ok ? (filesOk ? 'pass' : 'warn') : 'fail',
    lines: [
      `Engine, ${seconds * 60} frames at 1080p60, 2 processes × (sequential, shuffled on a fresh context, undithered): **${engine.deterministic ? 'byte-identical' : `DIFFERS — ${engine.mismatches.map((m) => `${m.name} @ frame ${m.frame}`).join('; ')}`}**; ${engine.uniqueUnditheredFrames}/${seconds * 60} frames differ with dither off.`,
      '',
      ...table(
        ['Export (2 runs)', 'Raw frames', 'MP4 bytes', 'Frame hash'],
        exports.map(([label, s]) => [label, s.framesIdentical ? 'identical' : `differ @ ${s.firstFrameMismatch}`, s.filesIdentical ? 'identical' : 'differ', `${s.first.report.frames.combinedSha256?.slice(0, 16)}…`]),
      ),
    ],
    data: { engine, exports: exports.map(([label, s]) => ({ label, framesIdentical: s.framesIdentical, filesIdentical: s.filesIdentical, frameHash: s.first.report.frames.combinedSha256, fileSha256: s.first.fileSha256 })) },
  };
};

// ---------------------------------------------------------------------------
// 3. Readback benchmark
// ---------------------------------------------------------------------------
export const checkReadback: Check = async (ctx) => {
  const seconds = ctx.quick ? 3 : 5;
  const resolutions = ctx.quick ? [[1920, 1080]] : [[1920, 1080], [3840, 2160]];
  const depths = ctx.quick ? [1, 3] : [1, 2, 3, 4];
  const rows: Array<Array<string | number>> = [];
  const data: Array<Record<string, unknown>> = [];
  for (const [w, h] of resolutions as Array<[number, number]>) {
    const configs: Array<{ label: string; settings: EncodeSettings; mode: 'sync' | 'async'; depth: number }> = [
      { label: 'RGBA sync', settings: swscale(defaultEncodeSettings('h264')), mode: 'sync', depth: 1 },
      ...depths.map((d) => ({ label: `RGBA async d${d}`, settings: swscale(defaultEncodeSettings('h264')), mode: 'async' as const, depth: d })),
      { label: 'NV12 (GPU) sync', settings: defaultEncodeSettings('h264'), mode: 'sync', depth: 1 },
    ];
    for (const c of configs) {
      const s = await exportCase(ctx, { name: `readback-${w}-${c.label.replace(/\W+/g, '-')}`, project: spikeProject(w, h), seconds, settings: c.settings, readbackMode: c.mode, depth: c.depth, hash: false, dither: true, runs: 1 });
      const t = s.first.report.timing;
      const per = (ms: number) => (ms / t.frames).toFixed(2);
      rows.push([`${w}×${h}`, c.label, t.fps.toFixed(1), per(t.waitGpuMs), per(t.collectMs), per(t.waitEncoderMs)]);
      data.push({ resolution: `${w}x${h}`, config: c.label, fps: t.fps, waitGpuMs: t.waitGpuMs / t.frames, readbackMs: t.collectMs / t.frames, waitEncoderMs: t.waitEncoderMs / t.frames });
    }
  }
  const best = (res: string) => data.filter((d) => d['resolution'] === res).sort((a, b) => Number(b['fps']) - Number(a['fps']))[0]?.['config'];
  return {
    id: 3,
    title: 'Readback benchmark',
    status: 'pass',
    lines: [
      `H.264 export of the bars project, ${seconds} s, no frame hashing. Per-frame ms; "readback" for sync includes the GPU wait.`,
      '',
      ...table(['Resolution', 'Path', 'fps', 'wait GPU', 'readback', 'wait encoder'], rows),
      '',
      `Fastest: ${resolutions.map(([w, h]) => `${w}×${h} → ${best(`${w}x${h}`)}`).join('; ')}.`,
    ],
    data: { rows: data },
  };
};

// ---------------------------------------------------------------------------
// 4. Colour correctness
// ---------------------------------------------------------------------------

/** What the output pass should produce for an authored sRGB colour: linear → tone shoulder → sRGB. */
export function expectedEncoded(hex: string): [number, number, number] {
  const c = parseHexColor(hex) ?? { r: 0, g: 0, b: 0, a: 1 };
  const [r, g, b] = tonemap(srgbToLinear(c.r), srgbToLinear(c.g), srgbToLinear(c.b));
  return [linearToSrgb(r), linearToSrgb(g), linearToSrgb(b)];
}

export const checkColour: Check = async (ctx) => {
  const w = 1920;
  const h = 1080;
  const cases: Array<{ label: string; settings: EncodeSettings }> = [
    { label: 'H.264 8-bit, GPU NV12', settings: defaultEncodeSettings('h264') },
    { label: 'H.264 8-bit, swscale', settings: swscale(defaultEncodeSettings('h264')) },
    { label: 'HEVC 10-bit, swscale', settings: defaultEncodeSettings('hevc') },
  ];
  const silence = new Float32Array(48_000);
  const tolerance = 3; // 8-bit code values after a YUV round trip
  const rows: Array<Array<string | number>> = [];
  const data: Array<Record<string, unknown>> = [];
  let allOk = true;

  for (const c of cases) {
    const s = await exportCase(ctx, { name: `colour-${c.settings.codec}-${c.settings.bitDepth}-${c.settings.conversion}`, project: patternProject(w, h), seconds: 1, settings: c.settings, readbackMode: 'sync', depth: 1, hash: false, dither: false, runs: 1, pcm: silence });
    const deep = c.settings.bitDepth === 10;
    const rgb = await decodeFrameRgb(s.first.outputPath, 30, deep);
    const luma = await decodeFrameLuma(s.first.outputPath, 30, deep);
    let worst = 0;
    let worstPatch = '';
    const patches: Array<Record<string, unknown>> = [];
    TEST_PATTERN_COLORS.forEach((hex, i) => {
      const col = i % TEST_PATTERN_COLUMNS;
      const row = Math.floor(i / TEST_PATTERN_COLUMNS);
      const x = Math.floor((col + 0.5) * (w / TEST_PATTERN_COLUMNS));
      const y = Math.floor((row + 0.5) * (h / TEST_PATTERN_ROWS));
      const o = (y * w + x) * 3;
      const got = deep
        ? [rgb.readUInt16LE(o * 2) / 257, rgb.readUInt16LE(o * 2 + 2) / 257, rgb.readUInt16LE(o * 2 + 4) / 257]
        : [rgb[o] ?? 0, rgb[o + 1] ?? 0, rgb[o + 2] ?? 0];
      const want = expectedEncoded(hex).map((v) => v * 255);
      const diff = Math.max(...got.map((g, k) => Math.abs(g - (want[k] ?? 0))));
      const yCode = deep ? luma.readUInt16LE((y * w + x) * 2) : (luma[y * w + x] ?? 0);
      patches.push({ hex, expected: want.map((v) => Math.round(v)), decoded: got.map((v) => Math.round(v)), maxDiff: diff, lumaCode: yCode });
      if (diff > worst) {
        worst = diff;
        worstPatch = hex;
      }
    });
    const black = Number(patches[0]?.['lumaCode']);
    const white = Number(patches[16]?.['lumaCode']);
    // Y' of a grey = its encoded value; limited range maps 0 → 16 and 1 → 235 (×4 at 10 bits).
    const scale = deep ? 4 : 1;
    const expectedWhite = Math.round((16 + 219 * expectedEncoded('#ffffff')[0]) * scale);
    const rangeOk = Math.abs(black - 16 * scale) <= scale && Math.abs(white - expectedWhite) <= 2 * scale;
    const ok = worst <= tolerance && s.verified && rangeOk;
    allOk &&= ok;
    rows.push([c.label, ok ? 'pass' : 'FAIL', worst.toFixed(1), worstPatch, `${black} / ${white} (expect ${16 * scale} / ${expectedWhite})`, s.first.report.verification.issues.length === 0 ? 'all 4 present' : s.first.report.verification.issues.join('; ')]);
    data.push({ label: c.label, maxDiff: worst, worstPatch, blackLuma: black, whiteLuma: white, verification: s.first.report.verification, patches });
  }

  return {
    id: 4,
    title: 'Colour correctness',
    status: allOk ? 'pass' : 'fail',
    lines: [
      `${TEST_PATTERN_COLORS.length} patches (grey ramp, primaries, palette, two above the tone knee), dither off, frame 30 decoded with an explicit BT.709 limited-range matrix. Expected = authored sRGB → linear → tone shoulder (D48) → sRGB OETF (D49). Tolerance ±${tolerance} code values.`,
      '',
      ...table(['Path', 'Result', 'Max Δ (8-bit)', 'Worst patch', 'Luma black / white code', 'Tags'], rows),
      '',
      'Limited range: black luma must be 16 (64 at 10-bit). The white patch is not 235 because #ffffff sits above the D48 tone knee and encodes at ~0.98.',
    ],
    data: { tolerance, cases: data },
  };
};
