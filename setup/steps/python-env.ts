import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PYTHON_PACKAGES } from '../manifest.ts';
import { pythonEnv } from '../lib/env.ts';
import { SetupError } from '../lib/errors.ts';
import type { LockedPackage } from '../lib/lockfile.ts';
import { formatBytes } from '../lib/log.ts';
import {
  PY_REQUIREMENTS_IN,
  PY_REQUIREMENTS_LOCK,
  PYTHON_EXE,
  ROOT,
  TMP,
  UV_EXE,
  VENDOR,
  WHEELHOUSE,
} from '../lib/paths.ts';
import { run, runChecked } from '../lib/proc.ts';
import type { Step, StepContext } from './types.ts';

// The wheelhouse detail from PROJECT.md §3: wheels are downloaded into vendor/wheelhouse/
// and stay there, then installed with --no-index. The env can therefore be rebuilt with
// the network cable pulled, not just used without it.
//
// One deviation from the plan's wording, deliberately: PROJECT.md says `uv pip download`,
// but uv has no download command. uv resolves and installs; the vendored interpreter's
// own pip downloads, with --require-hashes against the uv-generated lock.

const TITLE = 'Python packages (torch CUDA + Demucs)';
const ENV_MARKER = join(VENDOR, 'python', '.pulseforge-env.json');
const LOCK_RELATIVE = 'setup/python/requirements.lock.txt';

interface EnvMarker {
  requirementsLockSha256: string;
}

interface EnvProbe {
  python: string;
  executable: string;
  userSite: boolean;
  torch?: string;
  torchCuda?: string | null;
  cudaAvailable?: boolean;
  device?: string;
  torchError?: string;
  demucs?: string;
  demucsError?: string;
  packages: LockedPackage[];
}

const PROBE_SCRIPT = String.raw`
import json, site, sys
from importlib import metadata
out = {"python": sys.version.split()[0], "executable": sys.executable, "userSite": bool(site.ENABLE_USER_SITE)}
try:
    import torch
    out["torch"] = torch.__version__
    out["torchCuda"] = torch.version.cuda
    out["cudaAvailable"] = bool(torch.cuda.is_available())
    if out["cudaAvailable"]:
        out["device"] = torch.cuda.get_device_name(0)
except Exception as e:
    out["torchError"] = repr(e)
try:
    import demucs
    import demucs.pretrained
    out["demucs"] = metadata.version("demucs")
except Exception as e:
    out["demucsError"] = repr(e)
def licence(d):
    m = d.metadata
    value = m.get("License-Expression") or ""
    if not value:
        value = next((c.split("::")[-1].strip() for c in (m.get_all("Classifier") or []) if c.startswith("License ::")), "")
    if not value:
        value = (m.get("License") or "").strip().splitlines()[0][:80] if (m.get("License") or "").strip() else "unknown"
    return value
out["packages"] = sorted(
    ({"name": d.metadata["Name"], "version": d.version, "license": licence(d)} for d in metadata.distributions()),
    key=lambda p: p["name"].lower(),
)
print(json.dumps(out))
`;

async function sha256Text(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function readMarker(): Promise<EnvMarker | undefined> {
  try {
    return JSON.parse(await readFile(ENV_MARKER, 'utf8')) as EnvMarker;
  } catch {
    return undefined;
  }
}

async function probe(ctx: StepContext): Promise<EnvProbe> {
  const result = await runChecked(PYTHON_EXE, ['-c', PROBE_SCRIPT], { step: TITLE, log: ctx.log, env: pythonEnv() }, () => ({
    what: 'Could not inspect the vendored Python environment.',
    fix: ['Re-run `npm run setup`; if it repeats, delete vendor/python and run setup again.'],
  }));
  return JSON.parse(result.stdout) as EnvProbe;
}

function lockedTorchVersion(lockText: string): string | undefined {
  return /^torch==(\S+)/m.exec(lockText)?.[1];
}

async function ensureRequirementsLock(ctx: StepContext): Promise<{ generated: boolean }> {
  const exists = existsSync(PY_REQUIREMENTS_LOCK);
  if (exists && !ctx.relock) return { generated: false };

  ctx.log.info(
    exists
      ? 'Re-resolving the Python lock (--relock) …'
      : 'No Python lock yet; resolving setup/python/requirements.in with uv (needs network) …',
  );
  await runChecked(
    UV_EXE,
    [
      'pip', 'compile', 'setup/python/requirements.in',
      '--output-file', LOCK_RELATIVE,
      '--generate-hashes',
      '--python', PYTHON_EXE,
      '--python-version', PYTHON_PACKAGES.pythonVersion,
      '--python-platform', PYTHON_PACKAGES.pythonPlatform,
      '--index-url', PYTHON_PACKAGES.pypiIndex,
      '--extra-index-url', PYTHON_PACKAGES.torchIndex,
      // Consider both indexes for every package, so the PyTorch mirror's older copies of
      // common packages don't shadow PyPI. torch itself is pinned to its CUDA local version.
      '--index-strategy', 'unsafe-best-match',
      // Wheels only: an offline rebuild must never need a compiler or a build backend.
      '--only-binary', ':all:',
      '--no-config',
      '--custom-compile-command', 'npm run setup -- --relock',
    ],
    { step: TITLE, log: ctx.log, cwd: ROOT, env: pythonEnv(), echo: true },
    () => ({
      what: 'uv could not resolve the Python requirements.',
      likelyCause:
        'A pinned version in setup/python/requirements.in has no Windows wheel for Python 3.11, or pypi.org / download.pytorch.org is unreachable.',
      fix: [
        'Read the uv output above: it names the package that could not be satisfied.',
        'If it is a network error, check the connection and re-run.',
        'If a version has no wheel, adjust setup/python/requirements.in deliberately and re-run with --relock.',
      ],
    }),
  );

  const torch = lockedTorchVersion(await readFile(PY_REQUIREMENTS_LOCK, 'utf8'));
  if (torch === undefined || !torch.endsWith(`+${PYTHON_PACKAGES.torchLocalVersion}`)) {
    throw new SetupError({
      step: TITLE,
      what: `The generated lock pins torch ${torch ?? '(missing)'}, not a +${PYTHON_PACKAGES.torchLocalVersion} CUDA build.`,
      likelyCause: 'The resolver chose the CPU wheel, so stem separation would silently run on the CPU.',
      fix: ['Check the torch pin in setup/python/requirements.in and PYTHON_PACKAGES.torchIndex in setup/manifest.ts, then re-run with --relock.'],
    });
  }
  ctx.log.ok(`Wrote ${LOCK_RELATIVE} (torch ${torch})`);
  return { generated: true };
}

async function pipResumeArgs(ctx: StepContext): Promise<string[]> {
  const result = await run(PYTHON_EXE, ['-m', 'pip', '--version'], { step: TITLE, log: ctx.log, env: pythonEnv() });
  const match = /^pip (\d+)\.(\d+)/.exec(result.stdout);
  const major = Number(match?.[1] ?? 0);
  const minor = Number(match?.[2] ?? 0);
  // pip 25.1+ can resume an interrupted wheel download (torch is ~2.5 GB).
  return major > 25 || (major === 25 && minor >= 1) ? ['--resume-retries', '5'] : [];
}

async function downloadWheelhouse(ctx: StepContext): Promise<void> {
  ctx.log.info('Filling vendor/wheelhouse/ (hash-checked against the lock; the torch CUDA wheel is ~2.5 GB) …');
  await mkdir(WHEELHOUSE, { recursive: true });
  await mkdir(TMP, { recursive: true });
  await runChecked(
    PYTHON_EXE,
    [
      '-m', 'pip', 'download',
      '--requirement', PY_REQUIREMENTS_LOCK,
      '--dest', WHEELHOUSE,
      '--require-hashes',
      '--no-deps', // the lock is the complete, resolved set
      '--only-binary', ':all:',
      '--no-cache-dir',
      '--index-url', PYTHON_PACKAGES.pypiIndex,
      '--extra-index-url', PYTHON_PACKAGES.torchIndex,
      ...(await pipResumeArgs(ctx)),
    ],
    { step: TITLE, log: ctx.log, env: pythonEnv(), echo: true },
    (result) => {
      const tail = result.tail;
      if (/DO NOT MATCH THE HASHES/i.test(tail)) {
        return {
          what: 'A downloaded wheel does not match the hash in the lock.',
          likelyCause: 'A corrupted download, or a file replaced on the index.',
          fix: [
            'Re-run `npm run setup`. pip deletes the bad file.',
            'If it repeats for the same package, do not bypass it. Investigate, then re-resolve with --relock.',
          ],
        };
      }
      if (/No space left|Errno 28/i.test(tail)) {
        return { what: 'The disk filled up while downloading wheels.', fix: ['Free space on the repo drive and re-run setup; finished wheels are kept.'] };
      }
      return {
        what: 'Downloading Python wheels failed.',
        likelyCause: 'A network interruption, or pypi.org / download.pytorch.org being unreachable.',
        fix: ['Check the connection and re-run `npm run setup`. Wheels already in vendor/wheelhouse/ are not downloaded again.'],
      };
    },
  );
}

async function installFromWheelhouse(ctx: StepContext): Promise<void> {
  ctx.log.info('Installing into vendor/python/ from the wheelhouse only (--offline --no-index) …');
  await runChecked(
    UV_EXE,
    [
      'pip', 'install',
      '--python', PYTHON_EXE,
      '--requirement', PY_REQUIREMENTS_LOCK,
      '--require-hashes',
      '--no-index',
      '--find-links', WHEELHOUSE,
      '--offline',
      '--no-config',
      '--break-system-packages',
    ],
    { step: TITLE, log: ctx.log, env: pythonEnv(), echo: true },
    () => ({
      what: 'Installing from the wheelhouse failed.',
      likelyCause: 'The wheelhouse is incomplete, or a file in it is damaged.',
      fix: ['Re-run `npm run setup`. It re-checks the wheelhouse against the lock and fetches anything missing.'],
    }),
  );
}

function assertHealthy(info: EnvProbe): void {
  if (!info.executable.toLowerCase().startsWith(VENDOR.toLowerCase()) || info.userSite) {
    throw new SetupError({
      step: TITLE,
      what: `The environment is not isolated (executable ${info.executable}, user site ${info.userSite ? 'on' : 'off'}).`,
      fix: ['This is a setup bug. Share vendor/setup.log.'],
    });
  }
  if (info.torchError !== undefined) {
    const dll = /WinError 126|DLL load failed|\.dll/i.test(info.torchError);
    throw new SetupError({
      step: TITLE,
      what: `torch is installed but fails to import: ${info.torchError}`,
      likelyCause: dll
        ? 'A Windows runtime DLL that torch depends on is missing. Usually this is the Microsoft Visual C++ Redistributable.'
        : 'A damaged or incomplete install.',
      fix: dll
        ? ['Install the latest "Microsoft Visual C++ Redistributable for Visual Studio 2015-2022 (x64)" from microsoft.com, then re-run setup.']
        : ['Delete vendor/python (the wheelhouse is kept) and re-run `npm run setup`.'],
    });
  }
  if (info.torchCuda === null || info.torchCuda === undefined) {
    throw new SetupError({
      step: TITLE,
      what: `torch ${info.torch ?? '?'} is a CPU-only build.`,
      likelyCause: 'The lock resolved the CPU wheel. Stem separation would run on the CPU, many times slower.',
      fix: ['Re-run with `npm run setup -- --relock` and check the torch pin in setup/python/requirements.in.'],
    });
  }
  if (info.cudaAvailable !== true) {
    throw new SetupError({
      step: TITLE,
      what: `torch ${info.torch ?? '?'} (CUDA ${info.torchCuda}) cannot see a CUDA device.`,
      likelyCause: `The NVIDIA driver is too old for CUDA ${info.torchCuda}, or the GPU is not available to this session (remote desktop, a driver mid-update).`,
      fix: [
        `Update the NVIDIA driver (${PYTHON_PACKAGES.minDriverMajor}+ for this build) and reboot.`,
        'Check that `nvidia-smi` lists the GPU, then re-run setup.',
      ],
    });
  }
  if (info.demucsError !== undefined) {
    throw new SetupError({
      step: TITLE,
      what: `demucs is installed but fails to import: ${info.demucsError}`,
      likelyCause: 'A dependency mismatch in the resolved lock.',
      fix: ['Re-run with `npm run setup -- --relock`; if it persists, share vendor/setup.log.'],
    });
  }
}

async function wheelhouseSummary(): Promise<string> {
  if (!existsSync(WHEELHOUSE)) return 'empty';
  const files = (await readdir(WHEELHOUSE)).filter((f) => f.endsWith('.whl'));
  return `${files.length} wheels`;
}

export const pythonEnvStep: Step = {
  id: 'python-env',
  title: TITLE,
  tier: PYTHON_PACKAGES.tier,

  async describe() {
    const lockExists = existsSync(PY_REQUIREMENTS_LOCK);
    const marker = await readMarker();
    const lockSha = lockExists ? await sha256Text(PY_REQUIREMENTS_LOCK) : undefined;
    const torch = lockExists ? lockedTorchVersion(await readFile(PY_REQUIREMENTS_LOCK, 'utf8')) : undefined;
    const requirements = (await readFile(PY_REQUIREMENTS_IN, 'utf8'))
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '' && !l.trim().startsWith('#'))
      .join(', ');
    return {
      name: 'Python packages',
      version: lockExists ? `lock: torch ${torch ?? '?'} (+ deps)` : `requirements.in: ${requirements}`,
      download: `~${formatBytes(PYTHON_PACKAGES.approxWheelhouseBytes)} of wheels`,
      source: `${PYTHON_PACKAGES.pypiIndex} + ${PYTHON_PACKAGES.torchIndex}`,
      destination: 'vendor/wheelhouse/ (kept) → installed into vendor/python/',
      status:
        marker !== undefined && marker.requirementsLockSha256 === lockSha
          ? `installed (${await wheelhouseSummary()})`
          : lockExists
            ? 'not installed; lock present'
            : `not installed. ${LOCK_RELATIVE} does not exist yet: uv resolves it first (metadata only) and you commit it`,
    };
  },

  async run(ctx) {
    ctx.log.heading(TITLE);
    const { generated } = await ensureRequirementsLock(ctx);
    const lockSha = await sha256Text(PY_REQUIREMENTS_LOCK);

    const marker = await readMarker();
    if (marker?.requirementsLockSha256 === lockSha && !generated) {
      const info = await probe(ctx);
      try {
        assertHealthy(info);
        ctx.log.ok(`Already installed: torch ${info.torch ?? '?'} on ${info.device ?? '?'}, demucs ${info.demucs ?? '?'}`);
        record(ctx, lockSha, info);
        return;
      } catch (error) {
        ctx.log.warn(`Installed environment failed its health check (${(error as Error).message}); reinstalling.`);
      }
    }

    await downloadWheelhouse(ctx);
    ctx.log.ok(`Wheelhouse complete (${await wheelhouseSummary()})`);
    await installFromWheelhouse(ctx);

    const info = await probe(ctx);
    assertHealthy(info);
    await writeFile(ENV_MARKER, JSON.stringify({ requirementsLockSha256: lockSha } satisfies EnvMarker, null, 2) + '\n');
    ctx.log.ok(`torch ${info.torch ?? '?'} sees ${info.device ?? '?'} (CUDA ${info.torchCuda ?? '?'}); demucs ${info.demucs ?? '?'}`);
    record(ctx, lockSha, info);

    if (generated) {
      ctx.log.warn(`${LOCK_RELATIVE} was generated in this run. Commit it: until it is committed, the Python resolution is not pinned.`);
    }
  },

  async verify(ctx) {
    ctx.log.heading(`Verify: ${TITLE}`);
    if (!existsSync(PY_REQUIREMENTS_LOCK)) {
      throw new SetupError({ step: TITLE, what: `${LOCK_RELATIVE} does not exist.`, fix: ['Run `npm run setup` to generate and install it.'] });
    }
    const marker = await readMarker();
    if (marker?.requirementsLockSha256 !== (await sha256Text(PY_REQUIREMENTS_LOCK))) {
      throw new SetupError({
        step: TITLE,
        what: 'The installed Python environment does not correspond to the current lock.',
        likelyCause: 'The lock changed (a git pull or --relock) since the environment was installed.',
        fix: ['Run `npm run setup` to install the locked set.'],
      });
    }
    // Proves the wheelhouse alone satisfies the lock, with no index: the offline-rebuild guarantee.
    await runChecked(
      UV_EXE,
      ['pip', 'install', '--python', PYTHON_EXE, '--requirement', PY_REQUIREMENTS_LOCK, '--require-hashes', '--no-index', '--find-links', WHEELHOUSE, '--offline', '--no-config', '--break-system-packages', '--dry-run'],
      { step: TITLE, log: ctx.log, env: pythonEnv() },
      () => ({
        what: 'The wheelhouse can no longer satisfy the lock offline.',
        likelyCause: 'Wheels were deleted from vendor/wheelhouse/.',
        fix: ['Run `npm run setup` (with internet) to restore the missing wheels.'],
      }),
    );
    const info = await probe(ctx);
    assertHealthy(info);
    ctx.log.ok(`Wheelhouse satisfies the lock offline; torch ${info.torch ?? '?'} sees ${info.device ?? '?'}`);
  },
};

function record(ctx: StepContext, lockSha: string, info: EnvProbe): void {
  ctx.lock.pythonEnv = {
    requirementsLockSha256: lockSha,
    python: info.python,
    torch: info.torch ?? 'unknown',
    torchCuda: info.torchCuda ?? 'none',
    packages: info.packages,
  };
}
