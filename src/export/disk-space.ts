// The free-space check before a render (export-spec §14): "filling a disk at 3 a.m. during a batch
// is a preventable failure".
//
// The encoder runs at constant quality, so the size of a video depends on its pictures and there is
// no bitrate to multiply by the duration. The estimate uses a measured ceiling instead: across 30
// real renders of this app, 360p to 1080p, H.264 and HEVC, the busiest spent 0.59 bits per pixel on
// video (a 1080p particle scene 0.34). An estimate that errs high pauses a render that might just
// have fitted, which costs a click; one that errs low fills the disk.
//
// No Node imports: the export dialog shows the same estimate.

/** The ceiling above, in bits per pixel of video. */
export const WORST_CASE_BITS_PER_PIXEL = 0.6;
/** The MP4 index and everything else that is not picture or sound. */
const HEADROOM_BYTES = 64 * 1024 * 1024;

export interface OutputSizeInput {
  readonly width: number;
  readonly height: number;
  readonly frames: number;
  readonly fps: number;
  readonly audioBitrateKbps: number;
}

/** The most a render should write, in bytes. */
export function estimateOutputBytes(input: OutputSizeInput): number {
  const video = (input.width * input.height * input.frames * WORST_CASE_BITS_PER_PIXEL) / 8;
  const audio = ((input.frames / input.fps) * input.audioBitrateKbps * 1000) / 8;
  return Math.ceil(video + audio + HEADROOM_BYTES);
}

/** 3.4 GB, 820 MB. */
export function formatBytes(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.ceil(bytes / 1e6)} MB`;
}

/**
 * A render that stopped for lack of disk space. The queue treats it differently from every other
 * failure: the next job needs the same disk, so it holds the job and stops rather than failing its
 * way through the night (export-spec §14: "pause rather than corrupt").
 */
export class DiskSpaceError extends Error {
  readonly fixes: readonly string[];
  constructor(message: string, fixes: readonly string[] = []) {
    super(message);
    this.name = 'DiskSpaceError';
    this.fixes = fixes;
  }
}

const FIXES = ['Free space on that drive', 'Or render to another drive'];

/** The message for a render that will not fit; null when it will, or when the drive cannot be read. */
export function spaceProblem(outputPath: string, neededBytes: number, freeBytes: number | null): string | null {
  if (freeBytes === null || freeBytes >= neededBytes) return null;
  return `Not enough disk space for ${outputPath}: it could take up to ${formatBytes(neededBytes)}, and the drive has ${formatBytes(freeBytes)} free.`;
}

export function diskSpaceError(message: string): DiskSpaceError {
  return new DiskSpaceError(message, FIXES);
}

/** The encoder's words for a disk that filled during a render (see `diagnoseEncoderFailure`). */
export function isDiskFullFailure(message: string): boolean {
  return /output disk is full|No space left on device|ENOSPC/i.test(message);
}
