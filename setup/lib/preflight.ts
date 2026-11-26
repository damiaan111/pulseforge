import { existsSync } from 'node:fs';
import { mkdir, statfs } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { PYTHON_PACKAGES, REQUIRED_FREE_BYTES, type Tier } from '../manifest.ts';
import { formatBytes, type Logger } from './log.ts';
import { NVIDIA_SMI_EXE, ROOT, TAR_EXE, VENDOR } from './paths.ts';
import { run } from './proc.ts';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string[];
}

export interface GpuInfo {
  name: string;
  driverVersion: string;
  memoryMiB: number;
}

export interface PreflightResult {
  checks: Check[];
  gpu: GpuInfo | undefined;
}

export function requiredBytes(tiers: readonly Tier[]): number {
  return tiers.reduce((sum, tier) => sum + REQUIRED_FREE_BYTES[tier], 0);
}

/** Every precondition checked up front, so failures name the cause before any work starts. */
export async function runPreflight(tiers: readonly Tier[], log: Logger): Promise<PreflightResult> {
  const checks: Check[] = [];

  if (process.platform === 'win32' && process.arch === 'x64') {
    checks.push({ name: 'Platform', status: 'ok', detail: 'Windows x64' });
  } else {
    checks.push({
      name: 'Platform',
      status: 'fail',
      detail: `${process.platform}/${process.arch}. Pulseforge provisions Windows x64 builds only.`,
      fix: ['Run setup on the Windows RTX machine (PROJECT.md §4).'],
    });
  }

  checks.push({ name: 'Node.js', status: 'ok', detail: process.version });

  if (!/^[\x20-\x7e]*$/.test(ROOT)) {
    checks.push({ name: 'Repo path', status: 'warn', detail: `"${ROOT}" contains non-ASCII characters; some Python tools mishandle these.` });
  } else {
    checks.push({ name: 'Repo path', status: 'ok', detail: ROOT });
  }

  if (existsSync(TAR_EXE)) {
    checks.push({ name: 'Archive tool', status: 'ok', detail: TAR_EXE });
  } else {
    checks.push({
      name: 'Archive tool',
      status: 'fail',
      detail: `${TAR_EXE} not found. Windows 10 (1803+) and 11 include it.`,
      fix: ['Check that this is Windows 10 1803 or newer. Setup deliberately does not fall back to other tools found on PATH.'],
    });
  }

  await mkdir(VENDOR, { recursive: true });
  const needed = requiredBytes(tiers);
  try {
    const fs = await statfs(VENDOR);
    const free = fs.bavail * fs.bsize;
    const detail = `${formatBytes(free)} free on the repo's drive, ~${formatBytes(needed)} needed for ${tiers.join(' + ')}`;
    checks.push(
      free >= needed
        ? { name: 'Disk space', status: 'ok', detail }
        : {
            name: 'Disk space',
            status: 'fail',
            detail,
            fix: [
              `Free up ${formatBytes(needed - free)} on this drive, or move the repo to a drive with more space.`,
              'Or install fewer tiers for now, e.g. `npm run setup -- --tier core`.',
            ],
          },
    );
  } catch (error) {
    checks.push({ name: 'Disk space', status: 'warn', detail: `could not measure free space (${(error as Error).message})` });
  }

  let gpu: GpuInfo | undefined;
  if (tiers.some((tier) => tier === 'stems' || tier === 'lyrics' || tier === 'extras')) {
    gpu = await probeGpu(checks, log);
  }

  const shadowing = ['python.exe', 'ffmpeg.exe', 'uv.exe']
    .map((exe) => [exe, findOnPath(exe)] as const)
    .filter((entry): entry is readonly [string, string] => entry[1] !== undefined);
  if (shadowing.length > 0) {
    checks.push({
      name: 'System tools on PATH',
      status: 'ok',
      detail: `${shadowing.map(([exe, p]) => `${exe} at ${p}`).join('; ')}. Ignored: setup only uses the vendored copies.`,
    });
  }

  return { checks, gpu };
}

async function probeGpu(checks: Check[], log: Logger): Promise<GpuInfo | undefined> {
  if (!existsSync(NVIDIA_SMI_EXE)) {
    checks.push({
      name: 'NVIDIA GPU',
      status: 'fail',
      detail: `${NVIDIA_SMI_EXE} not found, so no NVIDIA driver is installed. Stem separation needs CUDA.`,
      fix: ['Install the current NVIDIA Game Ready or Studio driver, then re-run setup.', 'Or install only the core tier for now: `npm run setup -- --tier core`.'],
    });
    return undefined;
  }
  const result = await run(
    NVIDIA_SMI_EXE,
    ['--query-gpu=name,driver_version,memory.total', '--format=csv,noheader,nounits'],
    { step: 'preflight', log },
  );
  const first = result.stdout.split(/\r?\n/)[0] ?? '';
  const [name, driverVersion, memory] = first.split(',').map((s) => s.trim());
  if (result.code !== 0 || name === undefined || driverVersion === undefined || memory === undefined) {
    checks.push({
      name: 'NVIDIA GPU',
      status: 'fail',
      detail: `nvidia-smi failed (exit ${result.code}): ${result.tail.trim() || 'no output'}`,
      fix: ['Reboot, or reinstall the NVIDIA driver. nvidia-smi must work before CUDA can.'],
    });
    return undefined;
  }
  const gpu: GpuInfo = { name, driverVersion, memoryMiB: Number(memory) };
  const major = Number(driverVersion.split('.')[0]);
  if (!(major >= PYTHON_PACKAGES.minDriverMajor)) {
    checks.push({
      name: 'NVIDIA GPU',
      status: 'fail',
      detail: `${name}, driver ${driverVersion}. The pinned torch CUDA build (${PYTHON_PACKAGES.torchLocalVersion}) needs driver ${PYTHON_PACKAGES.minDriverMajor} or newer.`,
      fix: ['Update the NVIDIA driver, then re-run setup.'],
    });
  } else {
    checks.push({ name: 'NVIDIA GPU', status: 'ok', detail: `${name}, driver ${driverVersion}, ${Math.round(gpu.memoryMiB / 1024)} GB VRAM` });
  }
  return gpu;
}

function findOnPath(exe: string): string | undefined {
  const pathVar = Object.entries(process.env).find(([k]) => k.toUpperCase() === 'PATH')?.[1] ?? '';
  for (const dir of pathVar.split(delimiter)) {
    if (dir.trim() === '') continue;
    const candidate = join(dir, exe);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}
