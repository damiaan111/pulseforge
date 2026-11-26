// Encoder capability probe (PROJECT.md §4, export-spec §5.2, §14): not "is it compiled in"
// but "does it actually open on this GPU and driver". Unsupported options get hidden
// before anyone can choose them — AV1 on Ampere being the known case.

import { spawn } from 'node:child_process';

import { diagnoseEncoderFailure } from './encoder.ts';
import type { VideoCodec, VideoEncoder } from './ffmpeg-args.ts';

export interface EncoderCapability {
  readonly id: string;
  readonly label: string;
  readonly available: boolean;
  readonly reason: string | undefined;
}

interface Candidate {
  id: string;
  label: string;
  args: string[];
}

const CANDIDATES: Candidate[] = [
  { id: 'h264-8-420', label: 'H.264 8-bit 4:2:0', args: ['-c:v', 'h264_nvenc', '-profile:v', 'high', '-pix_fmt', 'yuv420p'] },
  { id: 'h264-8-444', label: 'H.264 8-bit 4:4:4', args: ['-c:v', 'h264_nvenc', '-profile:v', 'high444p', '-pix_fmt', 'yuv444p'] },
  { id: 'hevc-8-420', label: 'HEVC 8-bit 4:2:0', args: ['-c:v', 'hevc_nvenc', '-profile:v', 'main', '-pix_fmt', 'yuv420p'] },
  { id: 'hevc-10-420', label: 'HEVC 10-bit 4:2:0', args: ['-c:v', 'hevc_nvenc', '-profile:v', 'main10', '-pix_fmt', 'p010le'] },
  { id: 'hevc-8-444', label: 'HEVC 8-bit 4:4:4', args: ['-c:v', 'hevc_nvenc', '-profile:v', 'rext', '-pix_fmt', 'yuv444p'] },
  { id: 'hevc-10-444', label: 'HEVC 10-bit 4:4:4', args: ['-c:v', 'hevc_nvenc', '-profile:v', 'rext', '-pix_fmt', 'yuv444p16le'] },
  { id: 'av1-8-420', label: 'AV1 8-bit 4:2:0', args: ['-c:v', 'av1_nvenc', '-pix_fmt', 'yuv420p'] },
];

/** The Mac's hardware encoder, one candidate per preset codec, as the presets use them. */
const VIDEOTOOLBOX: Readonly<Record<VideoCodec, Candidate>> = {
  h264: { id: 'h264-videotoolbox', label: 'H.264 8-bit 4:2:0 (VideoToolbox)', args: ['-c:v', 'h264_videotoolbox', '-allow_sw', '0', '-profile:v', 'high', '-pix_fmt', 'nv12'] },
  hevc: { id: 'hevc-10-videotoolbox', label: 'HEVC 10-bit 4:2:0 (VideoToolbox)', args: ['-c:v', 'hevc_videotoolbox', '-allow_sw', '0', '-profile:v', 'main10', '-pix_fmt', 'p010le'] },
};

const SOFTWARE: Candidate = { id: 'h264-software', label: 'H.264 8-bit 4:2:0 (software)', args: ['-c:v', 'libopenh264', '-pix_fmt', 'yuv420p'] };

function tryEncoder(ffmpegExe: string, candidate: Candidate): Promise<EncoderCapability> {
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=30:d=0.2', '-frames:v', '3', ...candidate.args, '-f', 'null', '-'];
  return new Promise((resolve) => {
    const child = spawn(ffmpegExe, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', (error) => resolve({ id: candidate.id, label: candidate.label, available: false, reason: error.message }));
    child.on('close', (code) => {
      const reason = code === 0 ? undefined : (diagnoseEncoderFailure(stderr) ?? stderr.trim().split(/\r?\n/).find((l) => /error|not|unsupported|failed/i.test(l)) ?? `exit ${code}`);
      resolve({ id: candidate.id, label: candidate.label, available: code === 0, reason });
    });
  });
}

/** What the export presets use, one candidate each (export-spec §14: hide it before it can be chosen). */
const PRESET_CANDIDATES: Readonly<Record<VideoCodec, string>> = { h264: 'h264-8-420', hevc: 'hevc-10-420' };

export type CodecSupport = Readonly<Record<VideoCodec, {
  readonly available: boolean;
  /** Why not the hardware encoder, even when software stands in for it. */
  readonly reason: string | null;
  readonly encoder: VideoEncoder;
}>>;

/** Whether this machine can encode each codec the presets use; H.264 falls back to the CPU. */
export async function probeCodecs(ffmpegExe: string): Promise<CodecSupport> {
  if (process.platform === 'darwin') {
    const vt = async (codec: VideoCodec) => {
      const result = await tryEncoder(ffmpegExe, VIDEOTOOLBOX[codec]);
      return { available: result.available, reason: result.reason ?? null, encoder: 'videotoolbox' as const };
    };
    const h264 = await vt('h264');
    const software = h264.available ? false : (await tryEncoder(ffmpegExe, SOFTWARE)).available;
    return { h264: software ? { ...h264, available: true, encoder: 'software' } : h264, hevc: await vt('hevc') };
  }
  const one = async (id: string) => {
    const result = await tryEncoder(ffmpegExe, CANDIDATES.find((candidate) => candidate.id === id) as Candidate);
    return { available: result.available, reason: result.reason ?? null, encoder: 'nvenc' as const };
  };
  const h264 = await one(PRESET_CANDIDATES.h264);
  const software = h264.available ? false : (await tryEncoder(ffmpegExe, SOFTWARE)).available;
  return { h264: software ? { ...h264, available: true, encoder: 'software' } : h264, hevc: await one(PRESET_CANDIDATES.hevc) };
}

/** Probes sequentially: NVENC session limits make parallel probes fail spuriously. */
export async function probeEncoders(ffmpegExe: string): Promise<EncoderCapability[]> {
  const results: EncoderCapability[] = [];
  for (const candidate of process.platform === 'darwin' ? Object.values(VIDEOTOOLBOX) : CANDIDATES) results.push(await tryEncoder(ffmpegExe, candidate));
  return results;
}
