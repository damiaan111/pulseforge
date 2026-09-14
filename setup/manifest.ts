// Every external artefact setup fetches, pinned by exact URL and SHA-256.
//
// Changing anything here is a deliberate act: a new pin changes what renders and
// separations are produced with (PROJECT.md §3, "everything version-pinned").
// Checksums come from each project's published checksum files, not from our own
// downloads — except where noted.

export type Tier = 'core' | 'stems';
export const ALL_TIERS: readonly Tier[] = ['core', 'stems'];
/** Tiers from PROJECT.md §3 that P0 does not provision yet — named so asking for them fails loudly. */
export const FUTURE_TIERS: Readonly<Record<string, string>> = {
  lyrics: 'WhisperX and Whisper models arrive with P6 (lyrics).',
  extras: 'MilkDrop presets and optional models arrive after v1.',
};

interface ArtefactBase {
  id: string;
  name: string;
  version: string;
  tier: Tier;
  url: string;
  fileName: string;
  sizeBytes: number;
  license: string;
  /** Install location relative to vendor/. */
  installDir: string;
}

export interface ArchiveArtefact extends ArtefactBase {
  kind: 'archive';
  sha256: string;
  /** The archive wraps everything in one top-level folder that should be dropped. */
  stripTopLevelDir: boolean;
  /** A file that must exist after extraction, relative to installDir. */
  expectFile: string;
}

export interface FileArtefact extends ArtefactBase {
  kind: 'file';
  /**
   * Full SHA-256 when known. When only a prefix is published (Demucs embeds the first
   * 8 hex digits in the file name and verifies exactly that), the full hash of the
   * first verified download is recorded in vendor.lock.json and enforced from then on.
   */
  sha256?: string;
  sha256Prefix?: string;
}

export type Artefact = ArchiveArtefact | FileArtefact;

export const FFMPEG: ArchiveArtefact = {
  kind: 'archive',
  id: 'ffmpeg',
  name: 'FFmpeg + FFprobe (LGPL, NVENC)',
  version: 'n8.1.2-52-g5a03dfa0f6 (BtbN autobuild-2026-09-14-13-17)',
  tier: 'core',
  // BtbN prunes dated autobuilds after a while; the archive is kept in vendor/downloads/
  // so this URL disappearing never blocks a rebuild (use --from for a fresh machine).
  url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-14-13-17/ffmpeg-n8.1.2-52-g5a03dfa0f6-win64-lgpl-8.1.zip',
  fileName: 'ffmpeg-n8.1.2-52-g5a03dfa0f6-win64-lgpl-8.1.zip',
  sha256: '398be5fb6e09ff3ae419ad62436d566c62705b1cc59bd4f98e8cd79646d42708',
  sizeBytes: 169_523_897,
  license: 'LGPL-2.1-or-later',
  installDir: 'ffmpeg',
  stripTopLevelDir: true,
  expectFile: 'bin/ffmpeg.exe',
};

export const PYTHON: ArchiveArtefact = {
  kind: 'archive',
  id: 'python',
  name: 'Portable CPython (python-build-standalone)',
  version: '3.11.16+20260901',
  tier: 'stems',
  url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20260901/cpython-3.11.16%2B20260901-x86_64-pc-windows-msvc-install_only.tar.gz',
  fileName: 'cpython-3.11.16+20260901-x86_64-pc-windows-msvc-install_only.tar.gz',
  sha256: '6be524fa6752af802146a4adc7d098565425b0b1c166e19a5a7a4c8cccb86bf6',
  sizeBytes: 47_940_627,
  license: 'PSF-2.0 (plus bundled third-party components)',
  installDir: 'python',
  stripTopLevelDir: true,
  expectFile: 'python.exe',
};

export const UV: ArchiveArtefact = {
  kind: 'archive',
  id: 'uv',
  name: 'uv (Python resolver/installer)',
  version: '0.12.13',
  tier: 'stems',
  url: 'https://github.com/astral-sh/uv/releases/download/0.12.13/uv-x86_64-pc-windows-msvc.zip',
  fileName: 'uv-0.12.13-x86_64-pc-windows-msvc.zip',
  sha256: 'a86c9dc7bad9b03f388583b7187c05fe9951c2e0d392217e8fd43d97787f6ec2',
  sizeBytes: 17_612_025,
  license: 'MIT OR Apache-2.0',
  installDir: 'uv',
  stripTopLevelDir: false,
  expectFile: 'uv.exe',
};

export const DEMUCS_HTDEMUCS: FileArtefact = {
  kind: 'file',
  id: 'demucs-htdemucs',
  name: 'Demucs htdemucs weights',
  version: '955717e8',
  tier: 'stems',
  url: 'https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/955717e8-8726e21a.th',
  fileName: '955717e8-8726e21a.th',
  // Upstream publishes only the prefix; the full hash was recorded by the first
  // verified download (2026-09-14, prefix matched) and is pinned here from then on.
  sha256: '8726e21a993978c7ba086d3872e7608d7d5bfca646ca4aca459ffda844faa8b4',
  sha256Prefix: '8726e21a',
  sizeBytes: 84_141_911,
  license: 'Demucs (Meta) — MIT code; check the weights\' terms before redistributing',
  installDir: 'models/demucs',
};

export const ARTEFACTS: readonly Artefact[] = [FFMPEG, PYTHON, UV, DEMUCS_HTDEMUCS];

export const PYTHON_PACKAGES = {
  tier: 'stems' as Tier,
  pypiIndex: 'https://pypi.org/simple',
  /** CUDA 13.0 wheels. Ampere (RTX 30xx) is supported. */
  torchIndex: 'https://download.pytorch.org/whl/cu130',
  torchLocalVersion: 'cu130',
  /** CUDA 13.0 wheels need an R580-branch driver or newer. */
  minDriverMajor: 580,
  pythonVersion: '3.11',
  pythonPlatform: 'x86_64-pc-windows-msvc',
  /** Rough download size for the plan output; the torch CUDA wheel dominates. */
  approxWheelhouseBytes: 3.2 * 1024 ** 3,
};

/** Free space setup insists on before starting, per tier (downloads + install + temp). */
export const REQUIRED_FREE_BYTES: Readonly<Record<Tier, number>> = {
  core: 1 * 1024 ** 3,
  stems: 16 * 1024 ** 3,
};
