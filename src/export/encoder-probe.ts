// Encoder capability probe (PROJECT.md §4, export-spec §5.2, §14): not "is it compiled in"
// but "does it actually open on this GPU and driver". Unsupported options get hidden
// before anyone can choose them — AV1 on Ampere being the known case.

import { spawn } from 'node:child_process';

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

function tryEncoder(ffmpegExe: string, candidate: Candidate): Promise<EncoderCapability> {
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=30:d=0.2', '-frames:v', '3', ...candidate.args, '-f', 'null', '-'];
  return new Promise((resolve) => {
    const child = spawn(ffmpegExe, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', (error) => resolve({ id: candidate.id, label: candidate.label, available: false, reason: error.message }));
    child.on('close', (code) => {
      const reason = code === 0 ? undefined : (stderr.trim().split(/\r?\n/).find((l) => /error|not|unsupported|failed/i.test(l)) ?? `exit ${code}`);
      resolve({ id: candidate.id, label: candidate.label, available: code === 0, reason });
    });
  });
}

/** Probes sequentially: NVENC session limits make parallel probes fail spuriously. */
export async function probeEncoders(ffmpegExe: string): Promise<EncoderCapability[]> {
  const results: EncoderCapability[] = [];
  for (const candidate of CANDIDATES) results.push(await tryEncoder(ffmpegExe, candidate));
  return results;
}
