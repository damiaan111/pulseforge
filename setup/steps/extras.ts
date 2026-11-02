import { existsSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { EXTRA_ARTEFACTS, type ExtraId, type FileArtefact } from '../manifest.ts';
import { ensureDownloaded, sha256File } from '../lib/download.ts';
import { pythonEnv } from '../lib/env.ts';
import { SetupError } from '../lib/errors.ts';
import { findArtefact, upsertArtefact, type VendorLock } from '../lib/lockfile.ts';
import { formatBytes } from '../lib/log.ts';
import { PYTHON_EXE, VENDOR } from '../lib/paths.ts';
import { ALIGN_DEVICE, WHISPER_DEVICE } from '../lib/platform.ts';
import { runChecked } from '../lib/proc.ts';
import type { Step, StepContext } from './types.ts';

// The extras tier (D8: fast by default, quality one click away): `htdemucs_ft`, Whisper
// `large-v3`, and forced alignment for French, German, Spanish and Italian. Each extra is its own
// step, installable alone (`--tier extras --extras htdemucs_ft`) — the studio's Settings installs
// them one at a time. As in the other tiers, every file is pinned by URL and full SHA-256, and
// after downloading, the model is **loaded offline on the GPU exactly the way the app loads it**:
// a file that verifies but does not load is caught here, not in someone's first render.

const pathOf = (artefact: FileArtefact) => join(VENDOR, artefact.installDir, artefact.fileName);

/** The same CUDA 12 cuBLAS search-path step the sidecar takes before CTranslate2 loads. */
const CUBLAS = String.raw`
import os, importlib.util
# The nvidia package exists only beside the CUDA build: on a Mac find_spec of a child of a missing package raises.
spec = importlib.util.find_spec("nvidia.cublas") if importlib.util.find_spec("nvidia") is not None else None
if spec is not None and spec.submodule_search_locations:
    b = os.path.join(list(spec.submodule_search_locations)[0], "bin")
    if os.path.isdir(b):
        os.add_dll_directory(b)
        os.environ["PATH"] = b + os.pathsep + os.environ.get("PATH", "")
`;

interface ExtraSpec {
  readonly extra: ExtraId;
  readonly title: string;
  readonly summary: string;
  /** Needs this tier's Python packages installed first. */
  readonly needs: 'stems' | 'lyrics';
  /** After the files: anything to place beside them (htdemucs_ft.yaml). */
  readonly after?: (ctx: StepContext) => Promise<void>;
  /** Python that loads the model offline on the GPU and prints one JSON line. */
  readonly loadScript: string;
  readonly loadArgs: readonly string[];
  readonly describeLoad: (result: Record<string, unknown>) => string;
}

const DEMUCS_DIR = join(VENDOR, 'models', 'demucs');
const ALIGN_DIR = join(VENDOR, 'models', 'align');

/** A Demucs model's yaml ships in the demucs package, like htdemucs.yaml (demucs-model.ts): copied beside the weights. */
async function placeDemucsYaml(model: string, ctx: StepContext): Promise<void> {
  const locate = await runChecked(
    PYTHON_EXE,
    ['-c', `import demucs, pathlib; print(pathlib.Path(demucs.__file__).parent / "remote" / "${model}.yaml")`],
    { step: model, log: ctx.log, env: pythonEnv() },
    () => ({ what: 'Could not locate the demucs package.', fix: ['Re-run `npm run setup -- --tier stems`.'] }),
  );
  await copyFile(locate.stdout.trim(), join(DEMUCS_DIR, `${model}.yaml`));
}

const SPECS: readonly ExtraSpec[] = [
  {
    extra: 'htdemucs_ft',
    title: 'Demucs htdemucs_ft (four fine-tuned models)',
    summary: 'finer stem separation in about 1.7× the time',
    needs: 'stems',
    after: (ctx) => placeDemucsYaml('htdemucs_ft', ctx),
    loadScript: String.raw`
import json, sys
from pathlib import Path
from demucs.pretrained import get_model
bag = get_model("htdemucs_ft", repo=Path(sys.argv[1]))
print(json.dumps({"models": len(bag.models), "sources": list(bag.sources)}))
`,
    loadArgs: [DEMUCS_DIR],
    describeLoad: (r) => `htdemucs_ft loads offline: ${String(r['models'])} models, ${(r['sources'] as string[]).join(' / ')}`,
  },
  {
    extra: 'htdemucs_6s',
    title: 'Demucs htdemucs_6s (six stems)',
    summary: 'guitar and piano as stems of their own',
    needs: 'stems',
    after: (ctx) => placeDemucsYaml('htdemucs_6s', ctx),
    loadScript: String.raw`
import json, sys
from pathlib import Path
from demucs.pretrained import get_model
bag = get_model("htdemucs_6s", repo=Path(sys.argv[1]))
print(json.dumps({"models": len(bag.models), "sources": list(bag.sources)}))
`,
    loadArgs: [DEMUCS_DIR],
    describeLoad: (r) => `htdemucs_6s loads offline: ${(r['sources'] as string[]).join(' / ')}`,
  },
  {
    extra: 'whisper-large-v3',
    title: 'Whisper large-v3',
    summary: 'hears more words, splits lines less cleanly; about 5 GB of VRAM',
    needs: 'lyrics',
    loadScript: `${CUBLAS}
import json, sys
from faster_whisper import WhisperModel
m = WhisperModel(sys.argv[1], device="${WHISPER_DEVICE.device}", compute_type="${WHISPER_DEVICE.computeType}")
print(json.dumps({"mels": m.feature_extractor.mel_filters.shape[0]}))
`,
    loadArgs: [join(VENDOR, 'models', 'whisper', 'faster-whisper-large-v3')],
    describeLoad: (r) => `Whisper large-v3 loads offline on the ${WHISPER_DEVICE.device === 'cuda' ? 'GPU' : 'CPU'} (${String(r['mels'])} mel bins)`,
  },
  ...(['fr', 'de', 'es', 'it'] as const).map((language): ExtraSpec => ({
    extra: `align-${language}`,
    title: `Word alignment: ${({ fr: 'French', de: 'German', es: 'Spanish', it: 'Italian' })[language]}`,
    summary: `word-by-word lyric timing for ${language}`,
    needs: 'lyrics',
    loadScript: `${CUBLAS}
import json, sys
import whisperx
model, meta = whisperx.load_align_model(language_code=sys.argv[2], device="${ALIGN_DEVICE}", model_dir=sys.argv[1])
print(json.dumps({"model": type(model).__name__, "dictionary": len(meta["dictionary"])}))
`,
    loadArgs: [ALIGN_DIR, language],
    describeLoad: (r) => `${language} alignment loads offline on the ${ALIGN_DEVICE === 'cuda' ? 'GPU' : 'CPU'} (${String(r['model'])}, ${String(r['dictionary'])} symbols)`,
  })),
];

async function loadOffline(spec: ExtraSpec, ctx: StepContext): Promise<string> {
  const result = await runChecked(PYTHON_EXE, ['-c', spec.loadScript, ...spec.loadArgs], { step: spec.title, log: ctx.log, env: pythonEnv() }, () => ({
    what: `${spec.title} could not be loaded offline.`,
    likelyCause: `A model file is damaged, or the ${spec.needs} Python packages are not installed.`,
    fix: [`Re-run \`npm run setup -- --tier extras --extras ${spec.extra}\`; it re-verifies every file.`],
  }));
  const last = result.stdout.trim().split(/\r?\n/).pop() ?? '{}';
  return spec.describeLoad(JSON.parse(last) as Record<string, unknown>);
}

/** Whether an extra is fully installed: every file present and recorded in vendor.lock.json. */
export function extraInstalled(extra: ExtraId, lock: VendorLock): boolean {
  return EXTRA_ARTEFACTS[extra].every((a) => existsSync(pathOf(a)) && findArtefact(lock, a.id) !== undefined);
}

function extraStep(spec: ExtraSpec): Step & { readonly extra: ExtraId } {
  const files = EXTRA_ARTEFACTS[spec.extra];
  return {
    id: `extra-${spec.extra}`,
    title: spec.title,
    tier: 'extras',
    extra: spec.extra,

    async describe(lock) {
      const missing = files.filter((a) => !existsSync(pathOf(a)) || findArtefact(lock, a.id) === undefined);
      return {
        name: `${spec.title} — ${spec.summary}`,
        version: files[0]?.version ?? '',
        download: missing.length === 0 ? 'already downloaded' : formatBytes(missing.reduce((sum, a) => sum + a.sizeBytes, 0)),
        source: new URL(files[0]?.url ?? 'https://invalid/').host,
        destination: `vendor/${files[0]?.installDir ?? ''}/`,
        status: missing.length === 0 ? 'installed' : `not installed (${missing.length} of ${files.length} files to fetch)`,
      };
    },

    async run(ctx) {
      ctx.log.heading(spec.title);
      if (!existsSync(PYTHON_EXE)) {
        throw new SetupError({ step: spec.title, what: 'The Python environment is not installed, so the model cannot be checked.', fix: [`Run \`npm run setup\` first (the ${spec.needs} tier).`] });
      }
      for (const artefact of files) {
        await mkdir(join(VENDOR, artefact.installDir), { recursive: true });
        const result = await ensureDownloaded(
          {
            step: spec.title,
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
      ctx.log.ok(`${files.length} file${files.length === 1 ? '' : 's'} verified`);
      await spec.after?.(ctx);
      ctx.log.ok(await loadOffline(spec, ctx));
    },

    async verify(ctx) {
      ctx.log.heading(`Verify: ${spec.title}`);
      for (const artefact of files) {
        const path = pathOf(artefact);
        if (!existsSync(path)) {
          throw new SetupError({ step: spec.title, what: `${artefact.fileName} is not installed.`, fix: [`Run \`npm run setup -- --tier extras --extras ${spec.extra}\`.`] });
        }
        const actual = await sha256File(path);
        if (actual !== artefact.sha256) {
          throw new SetupError({
            step: spec.title,
            what: `${artefact.fileName} no longer matches its pinned SHA-256.`,
            likelyCause: `The file was modified or corrupted. Expected ${artefact.sha256 ?? '?'}, got ${actual}.`,
            fix: [`Delete ${path} and re-run \`npm run setup -- --tier extras --extras ${spec.extra}\`.`],
          });
        }
      }
      ctx.log.ok(await loadOffline(spec, ctx));
    },
  };
}

export const extraSteps: readonly (Step & { readonly extra: ExtraId })[] = SPECS.map(extraStep);
