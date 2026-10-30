// FFmpeg command construction for the export (export-spec §5–6, D5, D39, D40, D49): NVENC, or the
// vendored FFmpeg's own H.264 encoder on a machine without a usable one.
// Pure: no process, no filesystem — unit-tested, and recorded verbatim in the render report.

import type { Rational } from '../engine/core/time.ts';

export type VideoCodec = 'h264' | 'hevc';
export type ChromaFormat = '420' | '444';
/**
 * Where RGB → YUV happens (export-spec §4.4, D39).
 *  - gpu-nv12: the engine converts to BT.709 limited-range NV12 in a shader (src/engine/render/yuv.ts);
 *              ~2.7× fewer bytes through readback and the pipe. 8-bit 4:2:0 only. Default where possible.
 *  - swscale:  RGBA (or packed 10-bit) handed to FFmpeg, converted on the CPU with an explicit
 *              BT.709 limited-range matrix. Used for 10-bit and 4:4:4.
 * Handing raw RGB to NVENC was measured in P0 and rejected: no faster, and mis-tagged as full range.
 */
export type ColorConversion = 'gpu-nv12' | 'swscale';
export type NvencPreset = 'p1' | 'p2' | 'p3' | 'p4' | 'p5' | 'p6' | 'p7';
/** 'software' is OpenH264 on the CPU: 8-bit 4:2:0 H.264, for a PC with no NVENC it can open. */
export type VideoEncoder = 'nvenc' | 'software';

export interface EncodeSettings {
  readonly codec: VideoCodec;
  readonly bitDepth: 8 | 10;
  readonly chroma: ChromaFormat;
  readonly preset: NvencPreset;
  /** Constant-quality target (lower = better). */
  readonly cq: number;
  readonly conversion: ColorConversion;
  readonly audioBitrateKbps: number;
  /** Absent is NVENC. */
  readonly encoder?: VideoEncoder;
}

export interface EncodeJob {
  readonly width: number;
  readonly height: number;
  readonly fps: Rational;
  readonly settings: EncodeSettings;
  /** Export-ready WAV (already trimmed/padded to the video length), or none for a silent file. */
  readonly audioPath: string | undefined;
  readonly outputPath: string;
  /** Strip timestamps and version strings so repeat renders are comparable byte-for-byte (export-spec §0). */
  readonly bitexact: boolean;
}

/** D40 defaults: CQ 17 for 8-bit H.264, CQ 19 for the 10-bit HEVC master. */
export function defaultEncodeSettings(codec: VideoCodec): EncodeSettings {
  return codec === 'hevc'
    ? { codec: 'hevc', bitDepth: 10, chroma: '420', preset: 'p5', cq: 19, conversion: 'swscale', audioBitrateKbps: 320 }
    : { codec: 'h264', bitDepth: 8, chroma: '420', preset: 'p5', cq: 17, conversion: 'gpu-nv12', audioBitrateKbps: 320 };
}

/** GPU NV12 needs 8-bit 4:2:0 and a width divisible by 4; otherwise fall back to swscale. */
export function resolveConversion(settings: EncodeSettings, width: number, height: number): EncodeSettings {
  if (settings.conversion !== 'gpu-nv12') return settings;
  const possible = settings.bitDepth === 8 && settings.chroma === '420' && width % 4 === 0 && height % 2 === 0;
  return possible ? settings : { ...settings, conversion: 'swscale' };
}

/** Problems that make a settings combination impossible; empty when valid. */
export function settingsProblems(settings: EncodeSettings, width: number, height: number): string[] {
  const problems: string[] = [];
  if (settings.codec === 'h264' && settings.bitDepth === 10) {
    problems.push('H.264 is 8-bit only (D5; consumer NVENC has no 10-bit H.264). Use HEVC for 10-bit.');
  }
  if (settings.conversion === 'gpu-nv12' && (settings.chroma === '444' || settings.bitDepth === 10)) {
    problems.push('GPU NV12 conversion is 8-bit 4:2:0 only; use swscale for 10-bit or 4:4:4.');
  }
  if (settings.conversion === 'gpu-nv12' && width % 4 !== 0) {
    problems.push(`GPU NV12 conversion needs a width divisible by 4, got ${width}.`);
  }
  if (settings.encoder === 'software' && (settings.codec !== 'h264' || settings.bitDepth !== 8 || settings.chroma !== '420')) {
    problems.push('The software encoder is 8-bit 4:2:0 H.264 only.');
  }
  if (!(settings.cq >= 0 && settings.cq <= 51)) problems.push(`CQ must be 0–51, got ${settings.cq}.`);
  if (width % 2 !== 0 || height % 2 !== 0) problems.push(`Dimensions must be even for YUV output, got ${width}×${height}.`);
  if (settings.encoder !== 'software' && (width < 146 || height < 50)) problems.push(`NVENC needs at least 146×50, got ${width}×${height}.`);
  return problems;
}

export function inputPixelFormat(settings: EncodeSettings): string {
  if (settings.conversion === 'gpu-nv12') return 'nv12';
  // 10-bit: RGB10_A2 read as UNSIGNED_INT_2_10_10_10_REV → little-endian x2bgr10.
  return settings.bitDepth === 10 ? 'x2bgr10le' : 'rgba';
}

function encoderPixelFormat(settings: EncodeSettings): string {
  if (settings.bitDepth === 10) return settings.chroma === '444' ? 'yuv444p16le' : 'p010le';
  return settings.chroma === '444' ? 'yuv444p' : 'yuv420p';
}

function profile(settings: EncodeSettings): string {
  if (settings.codec === 'h264') return settings.chroma === '444' ? 'high444p' : 'high';
  if (settings.chroma === '444') return 'rext';
  return settings.bitDepth === 10 ? 'main10' : 'main';
}

export function gopLength(fps: Rational): number {
  return Math.max(1, Math.round((2 * fps.num) / fps.den)); // 2 s (export-spec §5.2)
}

/**
 * OpenH264 has no constant-quality mode that holds up, so the target becomes a bitrate: 0.4 bits a
 * pixel at CQ 17, doubling every 6 steps as a quantiser does. 1080p60 comes to 50 Mbit/s. Measured
 * against a lossless render of a busy MilkDrop preset, that lands within 0.5 dB of NVENC at CQ 17.
 */
export function softwareBitrate(width: number, height: number, fps: Rational, cq: number): number {
  return Math.round(width * height * (fps.num / fps.den) * 0.4 * 2 ** ((17 - cq) / 6));
}

function videoEncoderArgs(job: EncodeJob): string[] {
  const { settings, fps } = job;
  if (settings.encoder === 'software') {
    return ['-c:v', 'libopenh264', '-rc_mode', 'bitrate', '-b:v', String(softwareBitrate(job.width, job.height, fps, settings.cq)), '-profile:v', 'high', '-g', String(gopLength(fps))];
  }
  return [
    '-c:v', settings.codec === 'hevc' ? 'hevc_nvenc' : 'h264_nvenc',
    '-preset', settings.preset,
    '-tune', 'hq',
    '-rc', 'vbr',
    '-cq', String(settings.cq),
    '-b:v', '0',
    '-profile:v', profile(settings),
    '-g', String(gopLength(fps)),
    '-bf', '3',
    '-rc-lookahead', '32',
  ];
}

export function buildFfmpegArgs(job: EncodeJob): string[] {
  const { settings, fps } = job;
  const problems = settingsProblems(settings, job.width, job.height);
  if (problems.length > 0) throw new RangeError(problems.join(' '));

  const args = [
    '-y', '-hide_banner', '-nostdin', '-nostats',
    '-loglevel', 'warning',
    // Encoder-side frame count for progress (export-spec §13), as key=value lines on stdout.
    '-progress', 'pipe:1',
    '-f', 'rawvideo',
    '-pix_fmt', inputPixelFormat(settings),
    '-video_size', `${job.width}x${job.height}`,
    '-framerate', `${fps.num}/${fps.den}`,
    '-thread_queue_size', '64',
    '-i', 'pipe:0',
  ];
  if (job.audioPath !== undefined) args.push('-i', job.audioPath);

  args.push('-map', '0:v:0');
  if (job.audioPath !== undefined) args.push('-map', '1:a:0');

  // FFmpeg 8 takes colour metadata from the frames, and filtered frames arrive "unspecified",
  // which silently overrides -color_trc/-color_primaries below. setparams stamps them on the
  // frames themselves; without it the file is missing two of the four tags (export-spec §6).
  const stampTags = 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709';
  if (settings.conversion === 'swscale') {
    // RGB input is full range by definition; write BT.709 limited range explicitly.
    args.push(
      '-vf',
      `scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int,format=${encoderPixelFormat(settings)},${stampTags}:range=tv`,
    );
  } else {
    // Already BT.709 limited-range NV12 from the engine (src/engine/render/yuv.ts): tag it as such.
    args.push('-vf', settings.encoder === 'software' ? `format=yuv420p,${stampTags}:range=tv` : `${stampTags}:range=tv`);
  }

  args.push(
    ...videoEncoderArgs(job),
    // All four tags, always (export-spec §6). Transfer is tagged BT.709 by decision D49.
    '-colorspace', 'bt709',
    '-color_primaries', 'bt709',
    '-color_trc', 'bt709',
    '-color_range', 'tv',
  );
  if (settings.codec === 'hevc') args.push('-tag:v', 'hvc1');

  if (job.audioPath !== undefined) args.push('-c:a', 'aac', '-b:a', `${settings.audioBitrateKbps}k`);
  if (job.bitexact) args.push('-map_metadata', '-1', '-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact');
  args.push('-movflags', '+faststart', job.outputPath);
  return args;
}

/** A shell-pasteable rendering of the command, for the render report. */
export function formatCommandLine(exe: string, args: readonly string[]): string {
  const quote = (s: string) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
  return [exe, ...args].map(quote).join(' ');
}
