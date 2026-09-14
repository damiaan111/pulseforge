import { existsSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DEMUCS_HTDEMUCS } from '../manifest.ts';
import { ensureDownloaded, sha256File } from '../lib/download.ts';
import { pythonEnv } from '../lib/env.ts';
import { SetupError } from '../lib/errors.ts';
import { findArtefact, upsertArtefact } from '../lib/lockfile.ts';
import { formatBytes } from '../lib/log.ts';
import { PYTHON_EXE, VENDOR } from '../lib/paths.ts';
import { runChecked } from '../lib/proc.ts';
import type { Step, StepContext } from './types.ts';

// Demucs loads offline from a local "repo" folder: get_model('htdemucs', repo=<dir>)
// reads htdemucs.yaml (which lists the model signature) and <sig>-<sha-prefix>.th from
// that folder, verifies the prefix, and never touches the network or HuggingFace.

const TITLE = 'Demucs htdemucs model';
const MODEL_DIR = join(VENDOR, DEMUCS_HTDEMUCS.installDir);
const WEIGHTS = join(MODEL_DIR, DEMUCS_HTDEMUCS.fileName);
const BAG_YAML = join(MODEL_DIR, 'htdemucs.yaml');

function pinnedChecksum(ctx: StepContext): { sha256: string } | { sha256Prefix: string } {
  if (DEMUCS_HTDEMUCS.sha256 !== undefined) return { sha256: DEMUCS_HTDEMUCS.sha256 };
  const recorded = findArtefact(ctx.lock, DEMUCS_HTDEMUCS.id);
  // Trust on first verified use: once a full hash is recorded, it is enforced.
  if (recorded !== undefined && recorded.url === DEMUCS_HTDEMUCS.url) return { sha256: recorded.sha256 };
  if (DEMUCS_HTDEMUCS.sha256Prefix === undefined) throw new Error('demucs-htdemucs has no checksum pinned');
  return { sha256Prefix: DEMUCS_HTDEMUCS.sha256Prefix };
}

async function loadOffline(ctx: StepContext): Promise<{ sources: string[]; samplerate: number }> {
  const script = [
    'import json',
    'from pathlib import Path',
    'from demucs.pretrained import get_model',
    `model = get_model("htdemucs", repo=Path(${JSON.stringify(MODEL_DIR)}))`,
    'print(json.dumps({"sources": list(model.sources), "samplerate": int(model.samplerate)}))',
  ].join('\n');
  const result = await runChecked(PYTHON_EXE, ['-c', script], { step: TITLE, log: ctx.log, env: pythonEnv() }, () => ({
    what: 'Demucs could not load htdemucs from vendor/models/demucs offline.',
    likelyCause: 'The weights or htdemucs.yaml are missing or damaged, or the Python environment is incomplete.',
    fix: [`Delete ${MODEL_DIR} and re-run \`npm run setup\`.`],
  }));
  const lastLine = result.stdout.trim().split(/\r?\n/).pop() ?? '';
  return JSON.parse(lastLine) as { sources: string[]; samplerate: number };
}

export const demucsModelStep: Step = {
  id: DEMUCS_HTDEMUCS.id,
  title: TITLE,
  tier: DEMUCS_HTDEMUCS.tier,

  async describe(lock) {
    const recorded = findArtefact(lock, DEMUCS_HTDEMUCS.id);
    const present = existsSync(WEIGHTS);
    return {
      name: DEMUCS_HTDEMUCS.name,
      version: DEMUCS_HTDEMUCS.version,
      download: present ? 'already downloaded' : formatBytes(DEMUCS_HTDEMUCS.sizeBytes),
      source: DEMUCS_HTDEMUCS.url,
      destination: `vendor/${DEMUCS_HTDEMUCS.installDir}/`,
      status: present && recorded !== undefined
        ? 'installed'
        : `not installed. Only an 8-digit hash prefix is published (${DEMUCS_HTDEMUCS.sha256Prefix ?? '?'}); the full SHA-256 is recorded on first download and enforced after that`,
    };
  },

  async run(ctx) {
    ctx.log.heading(TITLE);
    if (!existsSync(PYTHON_EXE)) {
      throw new SetupError({
        step: TITLE,
        what: 'The Python environment is not installed, so the model cannot be set up.',
        fix: ['Run `npm run setup` without restricting steps; Python installs first.'],
      });
    }
    await mkdir(MODEL_DIR, { recursive: true });
    const hadFullHash = 'sha256' in pinnedChecksum(ctx);
    const result = await ensureDownloaded(
      {
        step: TITLE,
        label: DEMUCS_HTDEMUCS.name,
        url: DEMUCS_HTDEMUCS.url,
        dest: WEIGHTS,
        expectedSize: DEMUCS_HTDEMUCS.sizeBytes,
        ...pinnedChecksum(ctx),
        ...(ctx.fromDir !== undefined ? { fromDir: ctx.fromDir } : {}),
      },
      ctx.log,
    );
    ctx.log.ok(`Weights verified (${formatBytes(result.bytes)})`);
    if (!hadFullHash) {
      ctx.log.info(`Recorded full SHA-256 ${result.sha256}; it is enforced from now on (vendor.lock.json).`);
    }

    // The bag definition ships inside the demucs package; copy the installed version's
    // file so the local repo matches the code that reads it.
    const locate = await runChecked(
      PYTHON_EXE,
      ['-c', 'import demucs, pathlib; print(pathlib.Path(demucs.__file__).parent / "remote" / "htdemucs.yaml")'],
      { step: TITLE, log: ctx.log, env: pythonEnv() },
      () => ({ what: 'Could not locate the demucs package.', fix: ['Re-run `npm run setup`.'] }),
    );
    const packagedYaml = locate.stdout.trim();
    if (!existsSync(packagedYaml)) {
      throw new SetupError({
        step: TITLE,
        what: `The installed demucs package has no ${packagedYaml}.`,
        likelyCause: 'The pinned demucs version changed how it describes models.',
        fix: ['Check the demucs pin in setup/python/requirements.in against how that version loads htdemucs.'],
      });
    }
    await copyFile(packagedYaml, BAG_YAML);

    const model = await loadOffline(ctx);
    ctx.log.ok(`htdemucs loads offline: ${model.sources.join(' / ')} at ${model.samplerate} Hz`);

    upsertArtefact(ctx.lock, {
      id: DEMUCS_HTDEMUCS.id,
      name: DEMUCS_HTDEMUCS.name,
      version: DEMUCS_HTDEMUCS.version,
      url: DEMUCS_HTDEMUCS.url,
      fileName: DEMUCS_HTDEMUCS.fileName,
      sha256: result.sha256,
      sizeBytes: result.bytes,
      license: DEMUCS_HTDEMUCS.license,
      installPath: DEMUCS_HTDEMUCS.installDir,
    });
  },

  async verify(ctx) {
    ctx.log.heading(`Verify: ${TITLE}`);
    const recorded = findArtefact(ctx.lock, DEMUCS_HTDEMUCS.id);
    if (!existsSync(WEIGHTS) || recorded === undefined) {
      throw new SetupError({ step: TITLE, what: 'The htdemucs weights are not installed.', fix: ['Run `npm run setup`.'] });
    }
    const actual = await sha256File(WEIGHTS);
    if (actual !== recorded.sha256) {
      throw new SetupError({
        step: TITLE,
        what: 'The htdemucs weights no longer match the recorded SHA-256.',
        likelyCause: `The file was modified or corrupted. Expected ${recorded.sha256}, got ${actual}.`,
        fix: [`Delete ${WEIGHTS} and re-run \`npm run setup\`.`],
      });
    }
    const model = await loadOffline(ctx);
    ctx.log.ok(`Weights verified; loads offline (${model.sources.join(' / ')})`);
  },
};
