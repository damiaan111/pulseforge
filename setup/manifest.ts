// Every external artefact setup fetches, pinned by exact URL and SHA-256.
//
// Changing anything here is a deliberate act: a new pin changes what renders and
// separations are produced with (PROJECT.md §3, "everything version-pinned").
// Checksums come from each project's published checksum files, not from our own
// downloads — except where noted.

export type Tier = 'core' | 'stems' | 'lyrics' | 'beats' | 'milkdrop' | 'extras';
/** What a plain `npm run setup` installs. */
export const ALL_TIERS: readonly Tier[] = ['core', 'stems', 'lyrics', 'beats', 'milkdrop'];
/**
 * Installed only when asked for (D8: fast by default, quality one click away): `--tier extras`,
 * optionally narrowed with `--extras <list>`. The studio's Settings installs them one at a time.
 */
export const OPTIONAL_TIERS: readonly Tier[] = ['extras'];
/** Tiers from PROJECT.md §3 not provisioned yet — named so asking for them fails loudly. */
export const FUTURE_TIERS: Readonly<Record<string, string>> = {};

/** The optional models of the extras tier, each installable on its own. */
export const EXTRAS = ['htdemucs_ft', 'htdemucs_6s', 'whisper-large-v3', 'align-fr', 'align-de', 'align-es', 'align-it'] as const;
export type ExtraId = (typeof EXTRAS)[number];

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
  version: 'n8.1.3-9-g29e619e767 (BtbN autobuild-2026-09-30-13-08)',
  tier: 'core',
  // Always a month-end build: BtbN deletes daily autobuilds within weeks and keeps the last of each
  // month for about two years. Move this pin forward before then. A public download depends on it.
  url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-30-13-08/ffmpeg-n8.1.3-9-g29e619e767-win64-lgpl-8.1.zip',
  fileName: 'ffmpeg-n8.1.3-9-g29e619e767-win64-lgpl-8.1.zip',
  sha256: '4a7642b2264c03e8a0ce8a3825b933ee5580656f45695a086fe7e294045ffc0a',
  sizeBytes: 170_611_883,
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

/**
 * The bundled default typeface for text layers (M16, PROJECT.md §3 "open-licence only").
 * rsms/inter publishes no checksum file; the hash was recorded from a verified download on
 * 2026-09-15 and is enforced from then on. Extracted it is ~62 MB, over the ~20 MB font budget
 * in PROJECT.md §3 — most of it is the .ttc and the woff variants; the app uses `extras/ttf/`.
 */
export const FONT_INTER: ArchiveArtefact = {
  kind: 'archive',
  id: 'font-inter',
  name: 'Inter typeface',
  version: '4.1',
  tier: 'core',
  url: 'https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip',
  fileName: 'Inter-4.1.zip',
  sha256: '9883fdd4a49d4fb66bd8177ba6625ef9a64aa45899767dde3d36aa425756b11e',
  sizeBytes: 33_707_794,
  license: 'OFL-1.1',
  installDir: 'fonts/inter',
  stripTopLevelDir: false,
  expectFile: 'extras/ttf/Inter-Regular.ttf',
};

/**
 * The fallback chain for text (S17), in the order it is tried, after the layer's font and Inter
 * (which already has Latin, Greek and Cyrillic). All OFL-1.1. Pinned to commits, since Noto
 * publishes per-script repositories rather than one release; the hashes were recorded from those
 * files on 2026-10-30. `NotoSansCJKjp` has Simplified and Traditional Chinese and Hangul too, with
 * Japanese glyph forms where the regions differ; a project that minds chooses its own font.
 * Noto Emoji is the monochrome one: text is drawn from coverage masks.
 */
const NOTO_COMMIT = '412a7edb2c8c535d1066157e5b17e661fd5591fe';
const noto = (script: string, sha256: string, sizeBytes: number): FileArtefact => ({
  kind: 'file',
  id: `font-noto-${script.toLowerCase()}`,
  name: `Noto Sans ${script}`,
  version: NOTO_COMMIT.slice(0, 8),
  tier: 'core',
  url: `https://raw.githubusercontent.com/notofonts/notofonts.github.io/${NOTO_COMMIT}/fonts/NotoSans${script}/hinted/ttf/NotoSans${script}-Regular.ttf`,
  fileName: `NotoSans${script}-Regular.ttf`,
  sha256,
  sizeBytes,
  license: 'OFL-1.1',
  installDir: 'fonts/noto',
});
export const FALLBACK_FONTS: readonly FileArtefact[] = [
  noto('Arabic', 'bdff3e5659d67e67def05b33f749683b9376ae819d65d3dd62ac4640b3aaef48', 234_892),
  noto('Hebrew', 'cdefaf8efd47045f6820928eba84db5bed7557539328952b5f828315485e02ee', 26_860),
  noto('Devanagari', '4e3c66638958c3e2ab5d37f47a8deb89fffeb7be9985c665a519bbc7ba762313', 243_520),
  noto('Bengali', 'b55c62ee531e3214da6c0701daecea89a52ba42db7d8206b92e6b51f397a3193', 143_072),
  noto('Tamil', '3c0a186feb3c63c7f6d63e1511dcdc144e745ae09b98e217c83f3e317974f6f9', 73_992),
  noto('Thai', '61cf814eec46b294d6ea4401ac295d0cecd5207bd2331dcc5a15e7301d30ee44', 37_780),
  noto('Armenian', '720df88c332417a235b4d6209d14ec2e2bf4bfe2a954b7453d869ea593bfce1e', 30_752),
  noto('Georgian', 'd3e33254b09e7bb2c5cf0f17e554b80462056c5a107097f258d495168c3a9346', 52_888),
  {
    kind: 'file',
    id: 'font-noto-cjk-jp',
    name: 'Noto Sans CJK JP',
    version: 'f8d15753',
    tier: 'core',
    url: 'https://raw.githubusercontent.com/notofonts/noto-cjk/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/OTF/Japanese/NotoSansCJKjp-Regular.otf',
    fileName: 'NotoSansCJKjp-Regular.otf',
    sha256: '68a3fc98800b2a27b371f2fb79991daf3633bd89309d4ffaa6946fd587f375b5',
    sizeBytes: 16_467_736,
    license: 'OFL-1.1',
    installDir: 'fonts/noto',
  },
  {
    kind: 'file',
    id: 'font-noto-emoji',
    name: 'Noto Emoji',
    version: '6157dfaa',
    tier: 'core',
    url: 'https://raw.githubusercontent.com/google/fonts/6157dfaa640ca5738b4d1a7070fe389c3036d7fc/ofl/notoemoji/NotoEmoji%5Bwght%5D.ttf',
    fileName: 'NotoEmoji[wght].ttf',
    sha256: 'de6c18832938afc99caf132b39d6a30a19bac7f2e812e28db2535b4608d27551',
    sizeBytes: 1_982_596,
    license: 'OFL-1.1',
    installDir: 'fonts/noto',
  },
];

/**
 * The MilkDrop preset library, from npm. The package is MIT, but its presets are the work of many
 * artists, which that licence may not speak for: hence a separate choice, never part of this repo.
 */
export const MILKDROP_PRESETS: ArchiveArtefact = {
  kind: 'archive',
  id: 'milkdrop-presets',
  name: 'Butterchurn presets',
  version: '2.4.7',
  tier: 'milkdrop',
  url: 'https://registry.npmjs.org/butterchurn-presets/-/butterchurn-presets-2.4.7.tgz',
  fileName: 'butterchurn-presets-2.4.7.tgz',
  sha256: 'd9c067b354e4ed87b3a1dace1dc59c9d64e6a99300a82d5fa086f696e35204a7',
  sizeBytes: 1_774_321,
  license: 'MIT (the package); each preset by its own author',
  installDir: 'milkdrop/package',
  stripTopLevelDir: true,
  expectFile: 'package.json',
};

// ---------------------------------------------------------------------------
// Lyrics tier (P6, M26): transcription and forced alignment
// ---------------------------------------------------------------------------

/**
 * Whisper `medium` in CTranslate2 format, for faster-whisper (D8: fast by default; `large-v3` is a
 * later, optional pin). Pinned to one Hugging Face revision. model.bin's SHA-256 is the published
 * LFS object id; the three small files publish none, so theirs were recorded from a verified
 * download of that revision (2026-09-25) and are enforced from then on.
 */
const WHISPER_REVISION = '08e178d48790749d25932bbc082711ddcfdfbc4f';
const whisperFile = (fileName: string, sha256: string, sizeBytes: number): FileArtefact => ({
  kind: 'file',
  id: `whisper-medium-${fileName.replace(/\W+/g, '-')}`,
  name: `Whisper medium (CTranslate2) — ${fileName}`,
  version: WHISPER_REVISION.slice(0, 12),
  tier: 'lyrics',
  url: `https://huggingface.co/Systran/faster-whisper-medium/resolve/${WHISPER_REVISION}/${fileName}`,
  fileName,
  sha256,
  sizeBytes,
  license: 'MIT (OpenAI Whisper weights, converted by Systran)',
  installDir: 'models/whisper/faster-whisper-medium',
});
export const WHISPER_MEDIUM: readonly FileArtefact[] = [
  whisperFile('model.bin', '9b45e1009dcc4ab601eff815b61d80e60ce3fd8c74c1a14f4a282258286b51ae', 1_527_906_378),
  whisperFile('config.json', '3622a2ddc41ec0e0fd4e68c13c6830f03b90c38d89aaad184de02c8c642cf807', 2_257),
  whisperFile('tokenizer.json', 'fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab', 2_203_239),
  whisperFile('vocabulary.txt', '34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913', 459_861),
];

/**
 * The English forced-alignment model WhisperX uses (torchaudio's WAV2VEC2_ASR_BASE_960H). torchaudio
 * loads it from a model folder by this exact file name, so the folder is all the sidecar passes.
 * Other languages' wav2vec2 models are per language (PROJECT.md §3) and not provisioned yet: an
 * unsupported language falls back to tap-to-sync with a message (lyrics-spec §4). Hash recorded
 * from a verified download (2026-09-25; the server's size matched).
 */
export const WAV2VEC2_EN: FileArtefact = {
  kind: 'file',
  id: 'wav2vec2-en',
  name: 'wav2vec2 base 960h (English alignment)',
  version: 'torchaudio WAV2VEC2_ASR_BASE_960H',
  tier: 'lyrics',
  url: 'https://download.pytorch.org/torchaudio/models/wav2vec2_fairseq_base_ls960_asr_ls960.pth',
  fileName: 'wav2vec2_fairseq_base_ls960_asr_ls960.pth',
  sha256: '488fd4f16de84438ffc945334278c1b9fb9b7159a806c1080b16111a958c945d',
  sizeBytes: 377_664_473,
  license: 'MIT (fairseq wav2vec 2.0, LibriSpeech 960 h)',
  installDir: 'models/align',
};

export const LYRICS_MODELS: readonly FileArtefact[] = [...WHISPER_MEDIUM, WAV2VEC2_EN];

// ---------------------------------------------------------------------------
// Extras tier (D8): the quality options, installed on demand
// ---------------------------------------------------------------------------

/**
 * `htdemucs_ft`: four fine-tuned htdemucs models, one per stem (a "bag" — htdemucs_ft.yaml ships in
 * the demucs package and is copied beside them, like htdemucs.yaml). Slower, noticeably cleaner.
 * Demucs publishes each file's hash prefix (in its name); the full SHA-256s were recorded from
 * downloads whose prefixes matched (2026-09-25) and are enforced from then on.
 */
const demucsFt = (signature: string, sha256: string): FileArtefact => ({
  kind: 'file',
  id: `demucs-htdemucs-ft-${signature}`,
  name: `Demucs htdemucs_ft weights (${signature})`,
  version: signature,
  tier: 'extras',
  url: `https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/${signature}-${sha256.slice(0, 8)}.th`,
  fileName: `${signature}-${sha256.slice(0, 8)}.th`,
  sha256,
  sha256Prefix: sha256.slice(0, 8),
  sizeBytes: 84_141_271,
  license: 'Demucs (Meta) — MIT code; check the weights\' terms before redistributing',
  installDir: 'models/demucs',
});
export const DEMUCS_HTDEMUCS_FT: readonly FileArtefact[] = [
  demucsFt('f7e0c4bc', 'ba3fe64ae8ef66ac9a4857222ce48efbdc5eb3ad375cb79dd13debee5aaa4066'),
  demucsFt('d12395a8', 'e57c48e6b0e38af4f7118d7bd08c49f0a0c0edf7d09143bdd902ea0d237303e6'),
  demucsFt('92cfc3b6', 'ef3bcb9c8b40d14ae5d51b6db2587339cc12c6b77c0be151ce6d69002e087bf2'),
  demucsFt('04573f0d', 'f3cf25b222c4eed7cd49dd8b2c9597d50c18bd154090f7b919cfa5f93cf22c49'),
];

/**
 * `htdemucs_6s` (S6): one htdemucs model with six sources — guitar and piano split out of "other".
 * Its yaml ships in the demucs package and is copied beside it. The full SHA-256 was recorded from a
 * download whose published prefix (34c22ccb) matched (2026-09-26).
 */
export const DEMUCS_HTDEMUCS_6S: FileArtefact = {
  kind: 'file',
  id: 'demucs-htdemucs-6s',
  name: 'Demucs htdemucs_6s weights (5c90dfd2)',
  version: '5c90dfd2',
  tier: 'extras',
  url: 'https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/5c90dfd2-34c22ccb.th',
  fileName: '5c90dfd2-34c22ccb.th',
  sha256: '34c22ccb381c6f9fdbf324f04e1e2fe21aaaf293f5ded163a162697ff9a02ddd',
  sha256Prefix: '34c22ccb',
  sizeBytes: 54_996_327,
  license: 'Demucs (Meta) — MIT code; check the weights\' terms before redistributing',
  installDir: 'models/demucs',
};

/**
 * Whisper `large-v3` in CTranslate2 format (D8's quality option for transcription; 128 mel bins,
 * hence preprocessor_config.json). One pinned revision; model.bin's SHA-256 is the published LFS
 * object id, the small files' were recorded from a download whose git blob ids matched the
 * revision's tree (2026-09-25).
 */
const LARGE_V3_REVISION = 'edaa852ec7e145841d8ffdb056a99866b5f0a478';
const largeV3 = (fileName: string, sha256: string, sizeBytes: number): FileArtefact => ({
  kind: 'file',
  id: `whisper-large-v3-${fileName.replace(/\W+/g, '-')}`,
  name: `Whisper large-v3 (CTranslate2) — ${fileName}`,
  version: LARGE_V3_REVISION.slice(0, 12),
  tier: 'extras',
  url: `https://huggingface.co/Systran/faster-whisper-large-v3/resolve/${LARGE_V3_REVISION}/${fileName}`,
  fileName,
  sha256,
  sizeBytes,
  license: 'MIT (OpenAI Whisper weights, converted by Systran)',
  installDir: 'models/whisper/faster-whisper-large-v3',
});
export const WHISPER_LARGE_V3: readonly FileArtefact[] = [
  largeV3('model.bin', '69f74147e3334731bc3a76048724833325d2ec74642fb52620eda87352e3d4f1', 3_087_284_237),
  largeV3('config.json', 'a9306624f5ec14270a014b647e5c316b6e03a662c369758d1b90697a7b0655b9', 2_394),
  largeV3('preprocessor_config.json', '7ccc62c6f2765af1f3b46c00c9b5894426835a05021c8b9c01eecb6dfb542711', 340),
  largeV3('tokenizer.json', '6d8cbd7cd0d8d5815e478dac67b85a26bbe77c1f5e0c6d76d1ce2abc0e5f21ca', 2_480_617),
  largeV3('vocabulary.json', 'c69260f2ab26d659b7c398f9a2b2b48ed0df16c3b47d7326782fd9cba71690c1', 1_068_114),
];

/**
 * Forced alignment for French, German, Spanish and Italian: the torchaudio VoxPopuli bundles
 * WhisperX uses by default for them, loaded like the English one from vendor/models/align by file
 * name. No checksum is published; each was recorded from a download whose size matched the
 * server's (2026-09-25). Other languages' models come from Hugging Face in its cache layout — not
 * provisioned; those languages keep tap-to-sync (lyrics-spec §4).
 */
const alignModel = (language: 'fr' | 'de' | 'es' | 'it', sha256: string, sizeBytes: number): FileArtefact => ({
  kind: 'file',
  id: `wav2vec2-${language}`,
  name: `wav2vec2 VoxPopuli base 10k (${language} alignment)`,
  version: `torchaudio VOXPOPULI_ASR_BASE_10K_${language.toUpperCase()}`,
  tier: 'extras',
  url: `https://download.pytorch.org/torchaudio/models/wav2vec2_voxpopuli_base_10k_asr_${language}.pt`,
  fileName: `wav2vec2_voxpopuli_base_10k_asr_${language}.pt`,
  sha256,
  sizeBytes,
  license: 'CC BY-NC 4.0 (VoxPopuli; non-commercial — check before distributing renders commercially)',
  installDir: 'models/align',
});
export const ALIGN_MODELS: Readonly<Record<'fr' | 'de' | 'es' | 'it', FileArtefact>> = {
  fr: alignModel('fr', '30eeb5e5000e011838a39328c21eadf5ddaedbef0ea3f7cf5a790fd8695b92b5', 377_708_313),
  de: alignModel('de', '5fcd937817d4cc358aa9730ccaa92cdae37af4b62959b67ba77ef1f5da7938cf', 377_677_593),
  es: alignModel('es', '272a92b156b78e697e6c7cf7c64f274250a36d0047440e27a895a377d3af818f', 377_686_809),
  it: alignModel('it', '620bad579ee46ba1f67df2e7c858c111d14a09b349a62b1c672f0275a68484eb', 377_689_881),
};

export const EXTRA_ARTEFACTS: Readonly<Record<ExtraId, readonly FileArtefact[]>> = {
  htdemucs_ft: DEMUCS_HTDEMUCS_FT,
  htdemucs_6s: [DEMUCS_HTDEMUCS_6S],
  'whisper-large-v3': WHISPER_LARGE_V3,
  'align-fr': [ALIGN_MODELS.fr],
  'align-de': [ALIGN_MODELS.de],
  'align-es': [ALIGN_MODELS.es],
  'align-it': [ALIGN_MODELS.it],
};

export const ARTEFACTS: readonly Artefact[] = [FFMPEG, FONT_INTER, ...FALLBACK_FONTS, MILKDROP_PRESETS, PYTHON, UV, DEMUCS_HTDEMUCS, ...LYRICS_MODELS, ...Object.values(EXTRA_ARTEFACTS).flat()];

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

/**
 * WhisperX on top of the stems environment (M26). The lock is resolved with the stems lock as
 * **constraints**, so every package the two share keeps its stems version and installing this tier
 * never changes the working stem separation. Two deliberate departures from what WhisperX declares,
 * both found by running it on the RTX machine (STATUS §4.55):
 *  - `ctranslate2` is **overridden** past WhisperX's `<4.5` pin: those versions need cuDNN 8, which
 *    cannot sit beside the pinned torch CUDA 13 build (cuDNN 9). faster-whisper allows `<5`.
 *  - `nvidia-cublas-cu12` is added: CTranslate2 is built for CUDA 12, torch ships only CUDA 13's
 *    cuBLAS. The sidecar puts that one DLL folder on the search path when it loads CTranslate2.
 */
export const PYTHON_PACKAGES_LYRICS = {
  tier: 'lyrics' as Tier,
  /** Overrides applied on top of the requirements (uv `--override`). */
  overrides: ['ctranslate2==4.8.2'],
  approxWheelhouseBytes: 0.9 * 1024 ** 3,
};

/**
 * librosa for beat tracking and structure (S16). Runs on the CPU, so it stands alone: no torch and
 * no NVIDIA card. Resolved with the lyrics lock as constraints, so what it shares keeps its version.
 */
export const PYTHON_PACKAGES_BEATS = {
  tier: 'beats' as Tier,
  approxWheelhouseBytes: 0.2 * 1024 ** 3,
};

/** Free space setup insists on before starting, per tier (downloads + install + temp). */
export const REQUIRED_FREE_BYTES: Readonly<Record<Tier, number>> = {
  core: 1 * 1024 ** 3,
  stems: 16 * 1024 ** 3,
  lyrics: 5 * 1024 ** 3,
  beats: 1 * 1024 ** 3,
  milkdrop: 0.1 * 1024 ** 3,
  extras: 7 * 1024 ** 3,
};
