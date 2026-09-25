import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { LYRICS_MODELS, WAV2VEC2_EN, WHISPER_MEDIUM, type FileArtefact } from '../manifest.ts';
import { ensureDownloaded, sha256File } from '../lib/download.ts';
import { pythonEnv } from '../lib/env.ts';
import { SetupError } from '../lib/errors.ts';
import { findArtefact, upsertArtefact } from '../lib/lockfile.ts';
import { formatBytes } from '../lib/log.ts';
import { PYTHON_EXE, VENDOR } from '../lib/paths.ts';
import { runChecked } from '../lib/proc.ts';
import type { Step, StepContext } from './types.ts';

// The lyrics tier's models (P6, M26): Whisper medium for transcription (faster-whisper,
// CTranslate2 format) and wav2vec2 for English forced alignment. Every file is pinned by URL and
// full SHA-256 in the manifest. After downloading, both models are **loaded offline on the GPU**,
// the way the sidecar loads them — a file that verifies but does not load is caught here, not in
// the middle of someone's first alignment.

const TITLE = 'Lyrics models (Whisper medium, wav2vec2)';
const WHISPER_DIR = join(VENDOR, (WHISPER_MEDIUM[0] as FileArtefact).installDir);
const ALIGN_DIR = join(VENDOR, WAV2VEC2_EN.installDir);

const pathOf = (artefact: FileArtefact) => join(VENDOR, artefact.installDir, artefact.fileName);

/** The same CUDA 12 cuBLAS search-path step the sidecar takes before CTranslate2 loads. */
const LOAD_SCRIPT = String.raw`
import json, os, importlib.util
spec = importlib.util.find_spec("nvidia.cublas")
if spec is not None and spec.submodule_search_locations:
    b = os.path.join(list(spec.submodule_search_locations)[0], "bin")
    if os.path.isdir(b):
        os.add_dll_directory(b)
        os.environ["PATH"] = b + os.pathsep + os.environ.get("PATH", "")
import sys
from faster_whisper import WhisperModel
import whisperx
m = WhisperModel(sys.argv[1], device="cuda", compute_type="float16")
del m
model, meta = whisperx.load_align_model(language_code="en", device="cuda", model_dir=sys.argv[2])
print(json.dumps({"whisper": "ok", "align": type(model).__name__, "dictionary": len(meta["dictionary"])}))
`;

async function loadOffline(ctx: StepContext): Promise<string> {
  const result = await runChecked(PYTHON_EXE, ['-c', LOAD_SCRIPT, WHISPER_DIR, ALIGN_DIR], { step: TITLE, log: ctx.log, env: pythonEnv() }, () => ({
    what: 'The lyrics models could not be loaded offline on the GPU.',
    likelyCause: 'A model file is damaged, or the lyrics Python packages are not installed.',
    fix: ['Re-run `npm run setup -- --tier lyrics`. It re-verifies every file and reinstalls what is missing.'],
  }));
  const last = result.stdout.trim().split(/\r?\n/).pop() ?? '{}';
  const parsed = JSON.parse(last) as { align?: string; dictionary?: number };
  return `Whisper medium and ${parsed.align ?? '?'} (${parsed.dictionary ?? 0} symbols) load offline on the GPU`;
}

export const lyricsModelsStep: Step = {
  id: 'lyrics-models',
  title: TITLE,
  tier: 'lyrics',

  async describe(lock) {
    const total = LYRICS_MODELS.reduce((sum, a) => sum + a.sizeBytes, 0);
    const missing = LYRICS_MODELS.filter((a) => !existsSync(pathOf(a)) || findArtefact(lock, a.id) === undefined);
    return {
      name: 'Whisper medium + wav2vec2 (English)',
      version: `${(WHISPER_MEDIUM[0] as FileArtefact).version} · ${WAV2VEC2_EN.version}`,
      download: missing.length === 0 ? 'already downloaded' : formatBytes(missing.reduce((sum, a) => sum + a.sizeBytes, 0)),
      source: 'huggingface.co (Systran/faster-whisper-medium) + download.pytorch.org',
      destination: `vendor/models/whisper/, vendor/models/align/ (${formatBytes(total)})`,
      status: missing.length === 0 ? 'installed' : `not installed (${missing.length} of ${LYRICS_MODELS.length} files to fetch)`,
    };
  },

  async run(ctx) {
    ctx.log.heading(TITLE);
    if (!existsSync(PYTHON_EXE)) {
      throw new SetupError({ step: TITLE, what: 'The Python environment is not installed, so the models cannot be checked.', fix: ['Run `npm run setup` with the stems and lyrics tiers.'] });
    }
    for (const artefact of LYRICS_MODELS) {
      await mkdir(join(VENDOR, artefact.installDir), { recursive: true });
      const result = await ensureDownloaded(
        {
          step: TITLE,
          label: artefact.name,
          url: artefact.url,
          dest: pathOf(artefact),
          expectedSize: artefact.sizeBytes,
          sha256: artefact.sha256 as string,
          ...(ctx.fromDir !== undefined ? { fromDir: ctx.fromDir } : {}),
        },
        ctx.log,
      );
      upsertArtefact(ctx.lock, {
        id: artefact.id,
        name: artefact.name,
        version: artefact.version,
        url: artefact.url,
        fileName: artefact.fileName,
        sha256: result.sha256,
        sizeBytes: result.bytes,
        license: artefact.license,
        installPath: `${artefact.installDir}/${artefact.fileName}`,
      });
    }
    ctx.log.ok('All lyrics model files verified');
    ctx.log.ok(await loadOffline(ctx));
  },

  async verify(ctx) {
    ctx.log.heading(`Verify: ${TITLE}`);
    for (const artefact of LYRICS_MODELS) {
      const path = pathOf(artefact);
      if (!existsSync(path)) {
        throw new SetupError({ step: TITLE, what: `${artefact.fileName} is not installed.`, fix: ['Run `npm run setup -- --tier lyrics`.'] });
      }
      const actual = await sha256File(path);
      if (actual !== artefact.sha256) {
        throw new SetupError({
          step: TITLE,
          what: `${artefact.fileName} no longer matches its pinned SHA-256.`,
          likelyCause: `The file was modified or corrupted. Expected ${artefact.sha256}, got ${actual}.`,
          fix: [`Delete ${path} and re-run \`npm run setup -- --tier lyrics\`.`],
        });
      }
    }
    ctx.log.ok(await loadOffline(ctx));
  },
};
