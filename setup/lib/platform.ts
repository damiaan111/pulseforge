// Which build this is. The macOS branch runs on both: Apple Silicon Macs are its target, and Windows
// stays working so the whole test suite still runs on the machine the branch is developed on.

/** A Mac with Apple Silicon. Intel Macs are not a target: no Metal-backed torch, no arm64 FFmpeg. */
export const MAC = process.platform === 'darwin';

/** The executable suffix of a vendored program: `ffmpeg.exe` on Windows, `ffmpeg` on the Mac. */
export const EXE = MAC ? '' : '.exe';

/**
 * Where faster-whisper (CTranslate2) runs, as Python literals. CTranslate2 has no Metal backend, so on
 * the Mac it runs on the CPU, in int8: a few minutes for a song with the medium model.
 */
export const WHISPER_DEVICE = MAC ? { device: 'cpu', computeType: 'int8' } : { device: 'cuda', computeType: 'float16' };

/** Where the wav2vec2 word alignment runs. It is short work, and the CPU is the safe place for it on a Mac. */
export const ALIGN_DEVICE = MAC ? 'cpu' : 'cuda';
