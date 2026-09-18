import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const VENDOR = join(ROOT, 'vendor');
/** Pinned archives are kept after extraction, so a pruned upstream URL can't block a rebuild. */
export const DOWNLOADS = join(VENDOR, 'downloads');
export const STAGING = join(VENDOR, '.staging');
export const CACHE = join(VENDOR, '.cache');
/** Child-process temp files go here, not %TEMP% — torch unpacks gigabytes. */
export const TMP = join(VENDOR, '.tmp');
export const WHEELHOUSE = join(VENDOR, 'wheelhouse');
export const MODELS = join(VENDOR, 'models');
/** The drop-in modules folder (M35), scanned at startup. */
export const MODULES_DIR = join(ROOT, 'modules');
/** Bundled open-licence fonts (text layers). */
export const FONTS = join(VENDOR, 'fonts');
/** The default typeface when a text layer names no font. */
export const DEFAULT_FONT_FILE = join(FONTS, 'inter', 'extras', 'ttf', 'Inter-Regular.ttf');

export const VENDOR_LOCK = join(VENDOR, 'vendor.lock.json');
export const SETUP_LOG = join(VENDOR, 'setup.log');
export const SETUP_PID = join(VENDOR, '.setup.pid');
export const LICENSES_MD = join(VENDOR, 'LICENSES.md');

export const PY_REQUIREMENTS_IN = join(ROOT, 'setup', 'python', 'requirements.in');
export const PY_REQUIREMENTS_LOCK = join(ROOT, 'setup', 'python', 'requirements.lock.txt');

// Vendored executables. Always invoked by absolute path, never resolved from PATH
// (PROJECT.md §3) — a system-wide python or ffmpeg must never be picked up.
export const FFMPEG_EXE = join(VENDOR, 'ffmpeg', 'bin', 'ffmpeg.exe');
export const FFPROBE_EXE = join(VENDOR, 'ffmpeg', 'bin', 'ffprobe.exe');
export const PYTHON_EXE = join(VENDOR, 'python', 'python.exe');
export const UV_EXE = join(VENDOR, 'uv', 'uv.exe');

export const SYSTEM32 = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32');
export const TAR_EXE = join(SYSTEM32, 'tar.exe');
export const NVIDIA_SMI_EXE = join(SYSTEM32, 'nvidia-smi.exe');

/** Guard for anything that deletes or replaces files: it must be inside vendor/. */
export function insideVendor(path: string): string {
  const resolved = resolve(path);
  if (!resolved.startsWith(VENDOR + sep)) {
    throw new Error(`Refusing to modify ${resolved}: it is outside ${VENDOR}`);
  }
  return resolved;
}

export function relativeToVendor(path: string): string {
  return resolve(path).slice(VENDOR.length + 1).split(sep).join('/');
}
