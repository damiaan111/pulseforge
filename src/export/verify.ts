// Post-render verification (export-spec §15): probe the file and check it against what was
// asked for. A frame-count discrepancy is a bug, never a rounding artefact.

import { spawn } from 'node:child_process';
import type { Rational } from '../engine/core/time.ts';
import type { EncodeSettings } from './ffmpeg-args.ts';

export interface ProbedStream {
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  pix_fmt?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  nb_read_packets?: string;
  duration?: string;
  color_range?: string;
  color_space?: string;
  color_transfer?: string;
  color_primaries?: string;
  sample_rate?: string;
  channels?: number;
}

export interface ProbeResult {
  streams: ProbedStream[];
  format: { duration?: string; size?: string };
}

export function probeFile(ffprobeExe: string, path: string): Promise<ProbeResult> {
  const args = [
    '-v', 'error', '-count_packets',
    '-show_entries',
    'stream=codec_type,codec_name,profile,pix_fmt,width,height,r_frame_rate,nb_read_packets,duration,color_range,color_space,color_transfer,color_primaries,sample_rate,channels:format=duration,size',
    '-of', 'json', path,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(ffprobeExe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`ffprobe failed on ${path}: ${stderr.trim()}`));
      else resolve(JSON.parse(stdout) as ProbeResult);
    });
  });
}

export interface OutputExpectation {
  readonly frameCount: number;
  readonly width: number;
  readonly height: number;
  readonly fps: Rational;
  readonly settings: EncodeSettings;
  readonly hasAudio: boolean;
}

export interface VerificationResult {
  readonly ok: boolean;
  readonly issues: readonly string[];
  readonly videoFrames: number | undefined;
  readonly videoSeconds: number | undefined;
  readonly audioSeconds: number | undefined;
}

function expectedPixFmt(settings: EncodeSettings): string {
  if (settings.bitDepth === 10) return settings.chroma === '444' ? 'yuv444p16le' : 'yuv420p10le';
  return settings.chroma === '444' ? 'yuv444p' : 'yuv420p';
}

export function checkOutput(probe: ProbeResult, expected: OutputExpectation): VerificationResult {
  const issues: string[] = [];
  const video = probe.streams.find((s) => s.codec_type === 'video');
  const audio = probe.streams.find((s) => s.codec_type === 'audio');
  if (video === undefined) {
    return { ok: false, issues: ['no video stream in output'], videoFrames: undefined, videoSeconds: undefined, audioSeconds: undefined };
  }

  const frames = video.nb_read_packets !== undefined ? Number(video.nb_read_packets) : undefined;
  if (frames !== expected.frameCount) issues.push(`frame count ${frames ?? '?'} ≠ expected ${expected.frameCount}`);
  if (video.width !== expected.width || video.height !== expected.height) issues.push(`size ${video.width}×${video.height} ≠ ${expected.width}×${expected.height}`);
  if (video.r_frame_rate !== `${expected.fps.num}/${expected.fps.den}`) issues.push(`frame rate ${video.r_frame_rate} ≠ ${expected.fps.num}/${expected.fps.den}`);
  const codec = expected.settings.codec === 'hevc' ? 'hevc' : 'h264';
  if (video.codec_name !== codec) issues.push(`codec ${video.codec_name} ≠ ${codec}`);
  // With GPU-side conversion NVENC picks its own 4:2:0 layout; only swscale output is pinned.
  if (expected.settings.conversion === 'swscale' && video.pix_fmt !== expectedPixFmt(expected.settings)) {
    issues.push(`pixel format ${video.pix_fmt} ≠ ${expectedPixFmt(expected.settings)}`);
  }
  for (const [tag, value] of [['color_range', 'tv'], ['color_space', 'bt709'], ['color_transfer', 'bt709'], ['color_primaries', 'bt709']] as const) {
    if (video[tag] !== value) issues.push(`${tag} is ${video[tag] ?? 'untagged'}, expected ${value}`);
  }

  const videoSeconds = video.duration !== undefined ? Number(video.duration) : undefined;
  const audioSeconds = audio?.duration !== undefined ? Number(audio.duration) : undefined;
  if (expected.hasAudio) {
    if (audio === undefined) {
      issues.push('no audio stream in output');
    } else if (videoSeconds !== undefined && audioSeconds !== undefined) {
      // AAC priming and frame granularity allow up to one video frame of difference.
      const oneFrame = expected.fps.den / expected.fps.num;
      if (Math.abs(audioSeconds - videoSeconds) > oneFrame + 1e-6) {
        issues.push(`audio ${audioSeconds.toFixed(4)} s vs video ${videoSeconds.toFixed(4)} s differs by more than one frame`);
      }
    }
  }
  return { ok: issues.length === 0, issues, videoFrames: frames, videoSeconds, audioSeconds };
}
