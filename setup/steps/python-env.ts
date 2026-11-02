import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { PYTHON_PACKAGES, PYTHON_PACKAGES_BEATS, PYTHON_PACKAGES_LYRICS } from '../manifest.ts';
import { pythonEnv } from '../lib/env.ts';
import { SetupError } from '../lib/errors.ts';
import type { LockedPackage } from '../lib/lockfile.ts';
import { formatBytes } from '../lib/log.ts';
import {
  PY_BEATS_REQUIREMENTS_IN,
  PY_BEATS_REQUIREMENTS_LOCK,
  PY_LYRICS_REQUIREMENTS_IN,
  PY_LYRICS_REQUIREMENTS_LOCK,
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
import { MAC } from '../lib/platform.ts';
import type { Tier } from '../manifest.ts';
import type { Step, StepContext } from './types.ts';

// The wheelhouse detail from PROJECT.md §3: wheels are downloaded into vendor/wheelhouse/
// and stay there, then installed with --no-index. The env can therefore be rebuilt with
// the network cable pulled, not just used without it.
//
// One deviation from the plan's wording, deliberately: PROJECT.md says `uv pip download`,
// but uv has no download command. uv resolves and installs; the vendored interpreter's
// own pip downloads, with --require-hashes against the uv-generated lock.

//
// Two tiers install into the one vendored interpreter, each from its own lock: `stems` (torch CUDA +
// Demucs) and `lyrics` (WhisperX on top). The lyrics lock is resolved with the stems lock as
// constraints, so it is a strict superset that never changes a stems package — installing it cannot
// break stem separation, and the stems step's offline check keeps passing. One implementation,
// configured twice (`createPythonEnvStep`), so both get the same wheelhouse, hash and offline rules.

/** What differs between the tiers that install Python packages. */
interface PythonEnvConfig {
  readonly id: string;
  readonly title: string;
  readonly tier: Tier;
  readonly requirementsIn: string;
  readonly requirementsLock: string;
  readonly lockRelative: string;
  readonly marker: string;
  readonly approxWheelhouseBytes: number;
  /** Extra `uv pip compile` arguments (constraints, overrides), prepared at relock time. */
  readonly compileArgs: () => Promise<string[]>;
  /**
   * Extra `uv pip install` arguments. uv re-checks every package's declared dependencies when it
   * installs, so an override used to resolve the lock has to be repeated here too.
   */
  readonly installArgs: () => Promise<string[]>;
  /** Python appended to the probe: sets fields on `out` for `check` to read. */
  readonly probeExtra: string;
  /** Throws a SetupError when the tier's own packages are not usable; returns a summary. */
  readonly check: (info: EnvProbe) => string;
  /** False for a tier that needs no GPU: its lock has no torch, and its health no CUDA. */
  readonly usesTorch?: boolean;
  /** Before relocking, what must already be in place (the stems lock, for the lyrics tier). */
  readonly requires?: () => void;
  readonly record: (ctx: StepContext, lockSha: string, info: EnvProbe) => void;
}

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
  /** Apple Silicon's GPU, through Metal. */
  mpsAvailable?: boolean;
  device?: string;
  torchError?: string;
  demucs?: string;
  demucsError?: string;
  whisperx?: string;
  lyricsError?: string;
  librosa?: string;
  beatsError?: string;
  ctranslate2Cuda?: number;
  packages: LockedPackage[];
}

const PROBE_HEAD = String.raw`
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
    out["mpsAvailable"] = bool(getattr(torch.backends, "mps", None) and torch.backends.mps.is_available())
    if out["mpsAvailable"]:
        out["device"] = "Apple GPU (Metal)"
except Exception as e:
    out["torchError"] = repr(e)
try:
    import demucs
    import demucs.pretrained
    out["demucs"] = metadata.version("demucs")
except Exception as e:
    out["demucsError"] = repr(e)
`;

const PROBE_TAIL = String.raw`
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

/**
 * A path as uv should get it. uv splits the values of `--constraint` and `--override` at spaces, so
 * an absolute path under `C:\Users\First Last\` reaches it as two files. Relative to the repo, with
 * uv running there, no spaces are involved wherever the repo is.
 */
export function fromRoot(path: string): string {
  return relative(ROOT, path).split('\\').join('/');
}

async function sha256Text(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function probe(config: PythonEnvConfig, ctx: StepContext): Promise<EnvProbe> {
  const script = PROBE_HEAD + config.probeExtra + PROBE_TAIL;
  const result = await runChecked(PYTHON_EXE, ['-c', script], { step: config.title, log: ctx.log, env: pythonEnv() }, () => ({
    what: 'Could not inspect the vendored Python environment.',
    fix: ['Re-run `npm run setup`; if it repeats, delete vendor/python and run setup again.'],
  }));
  // Libraries print banners on import; the probe's JSON is the last line.
  return JSON.parse(result.stdout.trim().split(/\r?\n/).pop() ?? '{}') as EnvProbe;
}

function lockedTorchVersion(lockText: string): string | undefined {
  return /^torch==(\S+)/m.exec(lockText)?.[1];
}

async function ensureRequirementsLock(config: PythonEnvConfig, ctx: StepContext): Promise<{ generated: boolean }> {
  const exists = existsSync(config.requirementsLock);
  if (exists && !ctx.relock) return { generated: false };
  config.requires?.();

  ctx.log.info(
    exists
      ? `Re-resolving ${config.lockRelative} (--relock) …`
      : `No ${config.lockRelative} yet; resolving it with uv (needs network) …`,
  );
  const inputRelative = config.requirementsIn.slice(ROOT.length + 1).split('\\').join('/');
  await runChecked(
    UV_EXE,
    [
      'pip', 'compile', inputRelative,
      '--output-file', config.lockRelative,
      '--generate-hashes',
      '--python', PYTHON_EXE,
      '--python-version', PYTHON_PACKAGES.pythonVersion,
      '--python-platform', PYTHON_PACKAGES.pythonPlatform,
      ...indexArgs(),
      // Consider both indexes for every package, so the PyTorch mirror's older copies of
      // common packages don't shadow PyPI. torch itself is pinned to its CUDA local version.
      ...(PYTHON_PACKAGES.torchIndex === null ? [] : ['--index-strategy', 'unsafe-best-match']),
      // Wheels only: an offline rebuild must never need a compiler or a build backend.
      '--only-binary', ':all:',
      '--no-config',
      '--custom-compile-command', 'npm run setup -- --relock',
      ...(await config.compileArgs()),
    ],
    { step: config.title, log: ctx.log, cwd: ROOT, env: pythonEnv(), echo: true },
    () => ({
      what: 'uv could not resolve the Python requirements.',
      likelyCause:
        `A pinned version in ${inputRelative} has no ${MAC ? 'macOS arm64' : 'Windows'} wheel for Python 3.11, or pypi.org / download.pytorch.org is unreachable.`,
      fix: [
        'Read the uv output above: it names the package that could not be satisfied.',
        'If it is a network error, check the connection and re-run.',
        `If a version has no wheel, adjust ${inputRelative} deliberately and re-run with --relock.`,
      ],
    }),
  );

  const torch = lockedTorchVersion(await readFile(config.requirementsLock, 'utf8'));
  if (config.usesTorch === false) {
    ctx.log.ok(`Wrote ${config.lockRelative}`);
    return { generated: true };
  }
  const local = PYTHON_PACKAGES.torchLocalVersion;
  if (torch === undefined || (local !== null && !torch.endsWith(`+${local}`))) {
    throw new SetupError({
      step: config.title,
      what: `The generated lock pins torch ${torch ?? '(missing)'}, not a +${local ?? '?'} CUDA build.`,
      likelyCause: 'The resolver chose the CPU wheel, so stem separation would silently run on the CPU.',
      fix: ['Check the torch pin in setup/python/requirements.in and PYTHON_PACKAGES.torchIndex in setup/manifest.ts, then re-run with --relock.'],
    });
  }
  ctx.log.ok(`Wrote ${config.lockRelative} (torch ${torch})`);
  return { generated: true };
}

/** The indexes to resolve and download from: PyPI, plus PyTorch's own for the CUDA build. */
function indexArgs(): string[] {
  const extra = PYTHON_PACKAGES.torchIndex;
  return ['--index-url', PYTHON_PACKAGES.pypiIndex, ...(extra === null ? [] : ['--extra-index-url', extra])];
}

async function pipResumeArgs(config: PythonEnvConfig, ctx: StepContext): Promise<string[]> {
  const result = await run(PYTHON_EXE, ['-m', 'pip', '--version'], { step: config.title, log: ctx.log, env: pythonEnv() });
  const match = /^pip (\d+)\.(\d+)/.exec(result.stdout);
  const major = Number(match?.[1] ?? 0);
  const minor = Number(match?.[2] ?? 0);
  // pip 25.1+ can resume an interrupted wheel download (torch is ~2.5 GB).
  return major > 25 || (major === 25 && minor >= 1) ? ['--resume-retries', '5'] : [];
}

async function downloadWheelhouse(config: PythonEnvConfig, ctx: StepContext): Promise<void> {
  ctx.log.info(`Filling vendor/wheelhouse/ from ${config.lockRelative} (hash-checked; wheels already there are kept) …`);
  await mkdir(WHEELHOUSE, { recursive: true });
  await mkdir(TMP, { recursive: true });
  await runChecked(
    PYTHON_EXE,
    [
      '-m', 'pip', 'download',
      '--requirement', config.requirementsLock,
      '--dest', WHEELHOUSE,
      '--require-hashes',
      '--no-deps', // the lock is the complete, resolved set
      '--only-binary', ':all:',
      '--no-cache-dir',
      ...indexArgs(),
      ...(await pipResumeArgs(config, ctx)),
    ],
    { step: config.title, log: ctx.log, env: pythonEnv(), echo: true },
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

async function installFromWheelhouse(config: PythonEnvConfig, ctx: StepContext): Promise<void> {
  ctx.log.info('Installing into vendor/python/ from the wheelhouse only (--offline --no-index) …');
  await runChecked(
    UV_EXE,
    [
      'pip', 'install',
      '--python', PYTHON_EXE,
      '--requirement', fromRoot(config.requirementsLock),
      '--require-hashes',
      '--no-index',
      '--find-links', fromRoot(WHEELHOUSE),
      '--offline',
      '--no-config',
      '--break-system-packages',
      ...(await config.installArgs()),
    ],
    { step: config.title, log: ctx.log, cwd: ROOT, env: pythonEnv(), echo: true },
    () => ({
      what: 'Installing from the wheelhouse failed.',
      likelyCause: 'The wheelhouse is incomplete, or a file in it is damaged.',
      fix: ['Re-run `npm run setup`. It re-checks the wheelhouse against the lock and fetches anything missing.'],
    }),
  );
}

function assertHealthy(config: PythonEnvConfig, info: EnvProbe): string {
  const TITLE = config.title;
  if (!info.executable.toLowerCase().startsWith(VENDOR.toLowerCase()) || info.userSite) {
    throw new SetupError({
      step: TITLE,
      what: `The environment is not isolated (executable ${info.executable}, user site ${info.userSite ? 'on' : 'off'}).`,
      fix: ['This is a setup bug. Share vendor/setup.log.'],
    });
  }
  if (config.usesTorch === false) return config.check(info);
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
  if (MAC) {
    if (info.mpsAvailable !== true) {
      throw new SetupError({
        step: TITLE,
        what: `torch ${info.torch ?? '?'} cannot reach the GPU through Metal (MPS).`,
        likelyCause: 'This Mac is not Apple Silicon, or macOS is older than 12.3.',
        fix: ['Update macOS, then re-run setup.'],
      });
    }
    return config.check(info);
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
  return config.check(info);
}

async function wheelhouseSummary(): Promise<string> {
  if (!existsSync(WHEELHOUSE)) return 'empty';
  const files = (await readdir(WHEELHOUSE)).filter((f) => f.endsWith('.whl'));
  return `${files.length} wheels`;
}

async function readMarker(path: string): Promise<EnvMarker | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as EnvMarker;
  } catch {
    return undefined;
  }
}

export function createPythonEnvStep(config: PythonEnvConfig): Step {
  const TITLE = config.title;
  return {
    id: config.id,
    title: TITLE,
    tier: config.tier,

    async describe() {
      const lockExists = existsSync(config.requirementsLock);
      const marker = await readMarker(config.marker);
      const lockSha = lockExists ? await sha256Text(config.requirementsLock) : undefined;
      const torch = lockExists ? lockedTorchVersion(await readFile(config.requirementsLock, 'utf8')) : undefined;
      const requirements = (await readFile(config.requirementsIn, 'utf8'))
        .split(/\r?\n/)
        .filter((l) => l.trim() !== '' && !l.trim().startsWith('#'))
        .join(', ');
      return {
        name: TITLE,
        version: lockExists ? `lock: torch ${torch ?? '?'} (+ deps)` : `requirements: ${requirements}`,
        download: `~${formatBytes(config.approxWheelhouseBytes)} of wheels`,
        source: PYTHON_PACKAGES.torchIndex === null ? PYTHON_PACKAGES.pypiIndex : `${PYTHON_PACKAGES.pypiIndex} + ${PYTHON_PACKAGES.torchIndex}`,
        destination: 'vendor/wheelhouse/ (kept) → installed into vendor/python/',
        status:
          marker !== undefined && marker.requirementsLockSha256 === lockSha
            ? `installed (${await wheelhouseSummary()})`
            : lockExists
              ? 'not installed; lock present'
              : `not installed. ${config.lockRelative} does not exist yet: uv resolves it first (metadata only) and you commit it`,
      };
    },

    async run(ctx) {
      ctx.log.heading(TITLE);
      const { generated } = await ensureRequirementsLock(config, ctx);
      const lockSha = await sha256Text(config.requirementsLock);

      const marker = await readMarker(config.marker);
      if (marker?.requirementsLockSha256 === lockSha && !generated) {
        const info = await probe(config, ctx);
        try {
          const summary = assertHealthy(config, info);
          ctx.log.ok(`Already installed: ${summary}`);
          config.record(ctx, lockSha, info);
          return;
        } catch (error) {
          ctx.log.warn(`Installed environment failed its health check (${(error as Error).message}); reinstalling.`);
        }
      }

      await downloadWheelhouse(config, ctx);
      ctx.log.ok(`Wheelhouse complete (${await wheelhouseSummary()})`);
      await installFromWheelhouse(config, ctx);

      const info = await probe(config, ctx);
      const summary = assertHealthy(config, info);
      await writeFile(config.marker, JSON.stringify({ requirementsLockSha256: lockSha } satisfies EnvMarker, null, 2) + '\n');
      ctx.log.ok(summary);
      config.record(ctx, lockSha, info);

      if (generated) {
        ctx.log.warn(`${config.lockRelative} was generated in this run. Commit it: until it is committed, the Python resolution is not pinned.`);
      }
    },

    async verify(ctx) {
      ctx.log.heading(`Verify: ${TITLE}`);
      if (!existsSync(config.requirementsLock)) {
        throw new SetupError({ step: TITLE, what: `${config.lockRelative} does not exist.`, fix: ['Run `npm run setup` to generate and install it.'] });
      }
      const marker = await readMarker(config.marker);
      if (marker?.requirementsLockSha256 !== (await sha256Text(config.requirementsLock))) {
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
        ['pip', 'install', '--python', PYTHON_EXE, '--requirement', fromRoot(config.requirementsLock), '--require-hashes', '--no-index', '--find-links', fromRoot(WHEELHOUSE), '--offline', '--no-config', '--break-system-packages', '--dry-run', ...(await config.installArgs())],
        { step: TITLE, log: ctx.log, cwd: ROOT, env: pythonEnv() },
        () => ({
          what: 'The wheelhouse can no longer satisfy the lock offline.',
          likelyCause: 'Wheels were deleted from vendor/wheelhouse/.',
          fix: ['Run `npm run setup` (with internet) to restore the missing wheels.'],
        }),
      );
      const info = await probe(config, ctx);
      const summary = assertHealthy(config, info);
      ctx.log.ok(`Wheelhouse satisfies the lock offline; ${summary}`);
    },
  };
}

function recordEnv(ctx: StepContext, lockSha: string, info: EnvProbe): void {
  ctx.lock.pythonEnv = {
    requirementsLockSha256: ctx.lock.pythonEnv?.requirementsLockSha256 ?? lockSha,
    python: info.python,
    torch: info.torch ?? ctx.lock.pythonEnv?.torch ?? 'none',
    torchCuda: info.torchCuda ?? ctx.lock.pythonEnv?.torchCuda ?? 'none',
    // The one interpreter's whole package list: after the lyrics tier, its packages too.
    packages: info.packages,
  };
}

// ---------------------------------------------------------------------------
// stems: torch CUDA + Demucs
// ---------------------------------------------------------------------------

const STEMS_TITLE = MAC ? 'Python packages (torch for Metal + Demucs)' : 'Python packages (torch CUDA + Demucs)';

export const pythonEnvStep: Step = createPythonEnvStep({
  id: 'python-env',
  title: STEMS_TITLE,
  tier: PYTHON_PACKAGES.tier,
  requirementsIn: PY_REQUIREMENTS_IN,
  requirementsLock: PY_REQUIREMENTS_LOCK,
  lockRelative: fromRoot(PY_REQUIREMENTS_LOCK),
  marker: join(VENDOR, 'python', '.pulseforge-env.json'),
  approxWheelhouseBytes: PYTHON_PACKAGES.approxWheelhouseBytes,
  compileArgs: async () => [],
  installArgs: async () => [],
  probeExtra: '',
  check(info) {
    if (info.demucsError !== undefined) {
      throw new SetupError({
        step: STEMS_TITLE,
        what: `demucs is installed but fails to import: ${info.demucsError}`,
        likelyCause: 'A dependency mismatch in the resolved lock.',
        fix: ['Re-run with `npm run setup -- --relock`; if it persists, share vendor/setup.log.'],
      });
    }
    return `torch ${info.torch ?? '?'} sees ${info.device ?? '?'}${MAC ? '' : ` (CUDA ${info.torchCuda ?? '?'})`}; demucs ${info.demucs ?? '?'}`;
  },
  record(ctx, lockSha, info) {
    recordEnv(ctx, lockSha, info);
    if (ctx.lock.pythonEnv !== null) ctx.lock.pythonEnv.requirementsLockSha256 = lockSha;
  },
});

// ---------------------------------------------------------------------------
// lyrics: WhisperX on top (M26)
// ---------------------------------------------------------------------------

/**
 * CTranslate2 (faster-whisper) is built for CUDA 12; torch here is CUDA 13. The CUDA 12 cuBLAS comes
 * from the `nvidia-cublas-cu12` wheel, and this folder has to be on the DLL search path before
 * CTranslate2 loads — the sidecar does the same (python/pulseforge_ml/lyrics.py).
 */
const CUBLAS12_SNIPPET = String.raw`
import os as _os, importlib.util as _iu
_spec = _iu.find_spec("nvidia.cublas")
if _spec is not None and _spec.submodule_search_locations:
    _bin = _os.path.join(list(_spec.submodule_search_locations)[0], "bin")
    if _os.path.isdir(_bin):
        _os.add_dll_directory(_bin)
        _os.environ["PATH"] = _bin + _os.pathsep + _os.environ.get("PATH", "")
`;

/**
 * The overrides as a file, for uv's `--override` — resolving and installing both need it. For an
 * install (`fromLock`), each override is copied from the lock *with its hashes*: installs run with
 * `--require-hashes`, and an unhashed override is refused.
 */
export async function lyricsOverridesFile(fromLock?: string): Promise<string> {
  await mkdir(TMP, { recursive: true });
  const path = join(TMP, 'lyrics-overrides.txt');
  // Relative to the repo, where uv runs: see `fromRoot`.
  let text = `${PYTHON_PACKAGES_LYRICS.overrides.join('\n')}\n`;
  if (fromLock !== undefined) {
    const lock = (await readFile(fromLock, 'utf8')).replace(/\r\n/g, '\n');
    text = PYTHON_PACKAGES_LYRICS.overrides.map((pin) => {
      const start = lock.indexOf(`${pin} \\\n`);
      if (start < 0) {
        throw new SetupError({ step: 'Python packages for lyrics (WhisperX)', what: `${pin} is not in the lyrics lock.`, fix: ['Re-run with `npm run setup -- --relock`.'] });
      }
      // The pin and its `--hash=` continuation lines, up to the first line that does not continue.
      const lines = lock.slice(start).split('\n');
      const end = lines.findIndex((line) => !line.trimEnd().endsWith('\\'));
      return lines.slice(0, end + 1).join('\n');
    }).join('\n') + '\n';
  }
  await writeFile(path, text);
  return fromRoot(path);
}

export const pythonLyricsEnvStep: Step = createPythonEnvStep({
  id: 'python-lyrics-env',
  title: 'Python packages for lyrics (WhisperX)',
  tier: PYTHON_PACKAGES_LYRICS.tier,
  requirementsIn: PY_LYRICS_REQUIREMENTS_IN,
  requirementsLock: PY_LYRICS_REQUIREMENTS_LOCK,
  lockRelative: fromRoot(PY_LYRICS_REQUIREMENTS_LOCK),
  marker: join(VENDOR, 'python', '.pulseforge-lyrics-env.json'),
  approxWheelhouseBytes: PYTHON_PACKAGES_LYRICS.approxWheelhouseBytes,
  requires() {
    if (!existsSync(PY_REQUIREMENTS_LOCK)) {
      throw new SetupError({
        step: 'Python packages for lyrics (WhisperX)',
        what: 'The lyrics lock is resolved against the stems lock, which does not exist yet.',
        fix: ['Run setup with the stems tier first (the default does both).'],
      });
    }
  },
  async compileArgs() {
    // The stems lock, without hashes, as constraints: every shared package keeps its stems version.
    await mkdir(TMP, { recursive: true });
    const constraints = join(TMP, 'stems-constraints.txt');
    const pins = (await readFile(PY_REQUIREMENTS_LOCK, 'utf8')).split(/\r?\n/)
      .map((line) => /^([A-Za-z0-9_.-]+==\S+)/.exec(line)?.[1])
      .filter((pin): pin is string => pin !== undefined);
    await writeFile(constraints, `${pins.join('\n')}\n`);
    return ['--constraint', fromRoot(constraints), '--override', await lyricsOverridesFile()];
  },
  installArgs: async () => ['--override', await lyricsOverridesFile(PY_LYRICS_REQUIREMENTS_LOCK)],
  probeExtra: CUBLAS12_SNIPPET + String.raw`
try:
    import ctranslate2, faster_whisper, whisperx, whisperx.alignment
    out["whisperx"] = metadata.version("whisperx")
    out["ctranslate2Cuda"] = int(ctranslate2.get_cuda_device_count())
except Exception as e:
    out["lyricsError"] = repr(e)
`,
  check(info) {
    const step = 'Python packages for lyrics (WhisperX)';
    if (info.lyricsError !== undefined) {
      throw new SetupError({
        step,
        what: `WhisperX is installed but fails to import: ${info.lyricsError}`,
        likelyCause: 'A dependency mismatch in the resolved lock.',
        fix: ['Re-run with `npm run setup -- --relock`; if it persists, share vendor/setup.log.'],
      });
    }
    // On the Mac CTranslate2 runs on the CPU: it has no Metal backend.
    if (!MAC && (info.ctranslate2Cuda ?? 0) < 1) {
      throw new SetupError({
        step,
        what: 'CTranslate2 (faster-whisper) cannot see a CUDA device.',
        likelyCause: 'The CUDA 12 cuBLAS wheel is missing, or the NVIDIA driver is too old for CUDA 12.',
        fix: ['Re-run `npm run setup -- --tier lyrics`, and update the NVIDIA driver if this repeats.'],
      });
    }
    return MAC ? `whisperx ${info.whisperx ?? '?'}, CTranslate2 on the CPU` : `whisperx ${info.whisperx ?? '?'}, CTranslate2 on ${info.ctranslate2Cuda ?? 0} CUDA device(s)`;
  },
  record(ctx, lockSha, info) {
    recordEnv(ctx, lockSha, info);
    ctx.lock.pythonLyricsEnv = { requirementsLockSha256: lockSha };
  },
});

export const pythonBeatsEnvStep: Step = createPythonEnvStep({
  id: 'python-beats-env',
  title: 'Python packages for beat tracking (librosa)',
  tier: PYTHON_PACKAGES_BEATS.tier,
  requirementsIn: PY_BEATS_REQUIREMENTS_IN,
  requirementsLock: PY_BEATS_REQUIREMENTS_LOCK,
  lockRelative: fromRoot(PY_BEATS_REQUIREMENTS_LOCK),
  marker: join(VENDOR, 'python', '.pulseforge-beats-env.json'),
  approxWheelhouseBytes: PYTHON_PACKAGES_BEATS.approxWheelhouseBytes,
  usesTorch: false,
  requires() {
    if (!existsSync(PY_LYRICS_REQUIREMENTS_LOCK)) {
      throw new SetupError({
        step: 'Python packages for beat tracking (librosa)',
        what: 'The beats lock is resolved against the lyrics lock, which does not exist yet.',
        fix: ['Run setup with the lyrics tier first (the default does both).'],
      });
    }
  },
  async compileArgs() {
    // As the lyrics step does: the lock below it, without hashes, as constraints.
    await mkdir(TMP, { recursive: true });
    const constraints = join(TMP, 'lyrics-constraints.txt');
    const pins = (await readFile(PY_LYRICS_REQUIREMENTS_LOCK, 'utf8')).split(/\r?\n/)
      .map((line) => /^([A-Za-z0-9_.-]+==\S+)/.exec(line)?.[1])
      .filter((pin): pin is string => pin !== undefined);
    await writeFile(constraints, `${pins.join('\n')}\n`);
    return ['--constraint', fromRoot(constraints)];
  },
  installArgs: async () => [],
  probeExtra: String.raw`
try:
    import librosa
    out["librosa"] = metadata.version("librosa")
except Exception as e:
    out["beatsError"] = repr(e)
`,
  check(info) {
    if (info.beatsError !== undefined) {
      throw new SetupError({
        step: 'Python packages for beat tracking (librosa)',
        what: `librosa is installed but fails to import: ${info.beatsError}`,
        likelyCause: 'A dependency mismatch in the resolved lock.',
        fix: ['Re-run with `npm run setup -- --relock`; if it persists, share vendor/setup.log.'],
      });
    }
    return `librosa ${info.librosa ?? '?'}`;
  },
  record(ctx, lockSha, info) {
    recordEnv(ctx, lockSha, info);
    ctx.lock.pythonBeatsEnv = { requirementsLockSha256: lockSha };
  },
});
