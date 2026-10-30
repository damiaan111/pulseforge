import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ARTEFACTS, PYTHON } from '../manifest.ts';
import { sha256File } from '../lib/download.ts';
import { pythonEnv } from '../lib/env.ts';
import { SetupError } from '../lib/errors.ts';
import type { Logger } from '../lib/log.ts';
import { formatBytes } from '../lib/log.ts';
import { DOWNLOADS, MODELS, PY_BEATS_REQUIREMENTS_LOCK, PY_LYRICS_REQUIREMENTS_LOCK, PY_REQUIREMENTS_LOCK, TAR_EXE, UV_EXE, VENDOR, WHEELHOUSE } from '../lib/paths.ts';
import { runChecked } from '../lib/proc.ts';
import { lyricsOverridesFile } from './python-env.ts';

// The offline-rebuild check (PROJECT.md P1 exit criterion, risk "the Python env rots").
//
// `--verify` proves the installed files are intact; this proves they can be made **again, with no
// network**: the kept Python archive is extracted into a scratch folder, both locks are installed
// into it from vendor/wheelhouse/ alone, and the result imports torch (with CUDA), Demucs, WhisperX
// and faster-whisper and loads htdemucs from the vendored models. The network is made unusable for
// the whole run — uv offline, Hugging Face offline, and every proxy variable pointed at a closed
// local port — so a hidden download fails the check instead of quietly succeeding.
//
// The live environment is never touched, and the scratch folder is removed whatever happens. The
// archives setup keeps (FFmpeg, Python, uv, the font) are checked against their pins too: they are
// what a rebuild starts from.

const SCRATCH = join(VENDOR, '.rebuild-check');
const DEAD_PROXY = 'http://127.0.0.1:9';

const PROBE = String.raw`
import json, os, sys, importlib.util
from importlib import metadata
spec = importlib.util.find_spec("nvidia.cublas")
if spec is not None and spec.submodule_search_locations:
    b = os.path.join(list(spec.submodule_search_locations)[0], "bin")
    if os.path.isdir(b):
        os.add_dll_directory(b)
        os.environ["PATH"] = b + os.pathsep + os.environ.get("PATH", "")
import torch
from pathlib import Path
from demucs.pretrained import get_model
bag = get_model("htdemucs", repo=Path(sys.argv[1]))
import ctranslate2, faster_whisper, whisperx, whisperx.alignment
print(json.dumps({
    "python": sys.version.split()[0],
    "torch": torch.__version__,
    "cuda": torch.cuda.is_available(),
    "device": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
    "demucs": metadata.version("demucs"),
    "htdemucs": list(bag.sources),
    "whisperx": metadata.version("whisperx"),
    "ctranslate2Cuda": int(ctranslate2.get_cuda_device_count()),
}))
`;

async function folderBytes(path: string): Promise<number> {
  let total = 0;
  const walk = async (p: string): Promise<void> => {
    const info = await stat(p);
    if (!info.isDirectory()) {
      total += info.size;
      return;
    }
    for (const name of await readdir(p)) await walk(join(p, name));
  };
  await walk(path);
  return total;
}

export async function runRebuildCheck(log: Logger): Promise<void> {
  const step = 'Offline rebuild check';
  log.heading(step);

  // What a rebuild starts from: the kept archives, as pinned.
  for (const artefact of ARTEFACTS) {
    if (artefact.kind !== 'archive') continue;
    const path = join(DOWNLOADS, artefact.fileName);
    if (!existsSync(path)) {
      throw new SetupError({ step, what: `The kept archive ${artefact.fileName} is missing from vendor/downloads/.`, likelyCause: 'It was deleted; without it this part cannot be rebuilt offline.', fix: ['Re-run `npm run setup` (it downloads it again) or restore it from a backup.'] });
    }
    const actual = await sha256File(path);
    if (actual !== artefact.sha256) {
      throw new SetupError({ step, what: `The kept archive ${artefact.fileName} does not match its pin.`, fix: [`Delete ${path} and re-run \`npm run setup\`.`] });
    }
  }
  log.ok('Kept archives present and matching their pins (FFmpeg, Python, uv, Inter)');
  if (!existsSync(UV_EXE) || !existsSync(WHEELHOUSE)) {
    throw new SetupError({ step, what: 'uv or the wheelhouse is not installed, so there is nothing to rebuild from.', fix: ['Run `npm run setup` first.'] });
  }

  await rm(SCRATCH, { recursive: true, force: true });
  await mkdir(SCRATCH, { recursive: true });
  const started = performance.now();
  try {
    // No network: any attempt to reach one fails fast on a closed local port.
    const env = {
      ...pythonEnv(),
      UV_OFFLINE: '1',
      UV_CACHE_DIR: join(SCRATCH, 'uv-cache'),
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
      HTTP_PROXY: DEAD_PROXY,
      HTTPS_PROXY: DEAD_PROXY,
      ALL_PROXY: DEAD_PROXY,
      http_proxy: DEAD_PROXY,
      https_proxy: DEAD_PROXY,
      NO_PROXY: '',
    };
    await runChecked(TAR_EXE, ['-xf', join(DOWNLOADS, PYTHON.fileName), '-C', SCRATCH], { step, log }, () => ({
      what: 'Extracting the kept Python archive failed.',
      fix: ['Check free space on the repo drive.'],
    }));
    const python = join(SCRATCH, 'python', 'python.exe');
    if (!existsSync(python)) throw new SetupError({ step, what: 'The Python archive did not contain python/python.exe.', fix: ['Check the PYTHON pin in setup/manifest.ts.'] });
    log.ok('Fresh interpreter extracted from the kept archive');

    for (const [lock, extra, label] of [
      [PY_REQUIREMENTS_LOCK, [] as string[], 'stems packages (torch CUDA, Demucs)'],
      [PY_LYRICS_REQUIREMENTS_LOCK, ['--override', await lyricsOverridesFile(PY_LYRICS_REQUIREMENTS_LOCK)], 'lyrics packages (WhisperX)'],
      [PY_BEATS_REQUIREMENTS_LOCK, ['--override', await lyricsOverridesFile(PY_LYRICS_REQUIREMENTS_LOCK)], 'beat-tracking packages (librosa)'],
    ] as const) {
      if (!existsSync(lock)) {
        log.warn(`${label}: no lock (${lock}); skipped — that tier is not set up here.`);
        continue;
      }
      const t = performance.now();
      await runChecked(
        UV_EXE,
        ['pip', 'install', '--python', python, '--requirement', lock, '--require-hashes', '--no-index', '--find-links', WHEELHOUSE, '--offline', '--no-config', '--break-system-packages', ...extra],
        { step, log, env },
        () => ({
          what: `The ${label} could not be installed from the wheelhouse alone.`,
          likelyCause: 'A wheel the lock needs is missing from vendor/wheelhouse/, so a rebuild would need the network.',
          fix: ['Re-run `npm run setup` with a connection: it fills the wheelhouse again. Then re-run this check.'],
        }),
      );
      log.ok(`${label} installed offline from the wheelhouse (${((performance.now() - t) / 1000).toFixed(0)} s)`);
    }

    const probe = await runChecked(python, ['-c', PROBE, join(MODELS, 'demucs')], { step, log, env }, () => ({
      what: 'The rebuilt environment does not import or load what the app needs.',
      likelyCause: 'The locks and the wheelhouse disagree with what the code imports.',
      fix: ['Share vendor/setup.log; the import error is in it.'],
    }));
    const info = JSON.parse(probe.stdout.trim().split(/\r?\n/).pop() ?? '{}') as Record<string, unknown>;
    if (info['cuda'] !== true) {
      throw new SetupError({ step, what: 'The rebuilt torch does not see the GPU.', likelyCause: 'The wheelhouse holds a CPU build of torch.', fix: ['Re-run `npm run setup -- --relock`.'] });
    }
    log.ok(`Rebuilt env works: Python ${String(info['python'])}, torch ${String(info['torch'])} on ${String(info['device'])}, demucs ${String(info['demucs'])} (htdemucs loads), whisperx ${String(info['whisperx'])}, CTranslate2 on ${String(info['ctranslate2Cuda'])} CUDA device(s)`);
    log.ok(`Offline rebuild: ${formatBytes(await folderBytes(join(SCRATCH, 'python')))} in ${((performance.now() - started) / 1000).toFixed(0)} s with the network made unusable`);
  } finally {
    await rm(SCRATCH, { recursive: true, force: true });
  }
}
