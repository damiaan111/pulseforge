// Whether torch can reach the GPU here, for the tests that need it. On a PC with no NVIDIA card, or a
// driver older than the pinned torch asks for, they cannot show anything, so they skip rather than fail.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { pythonEnv } from '../../setup/lib/env.ts';
import { PYTHON_EXE } from '../../setup/lib/paths.ts';

export function torchHasCuda(): boolean {
  if (!existsSync(PYTHON_EXE)) return false;
  const check = 'import sys, torch; sys.exit(0 if torch.cuda.is_available() else 1)';
  return spawnSync(PYTHON_EXE, ['-c', check], { env: pythonEnv(), windowsHide: true, timeout: 60_000 }).status === 0;
}
