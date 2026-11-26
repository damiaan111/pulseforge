import { devNull } from 'node:os';
import { join } from 'node:path';
import { CACHE, MODELS, TMP } from './paths.ts';

// Environment for vendored child processes. The goal is that nothing on this machine
// outside vendor/ can influence what gets installed or imported — this machine may
// have a system-wide Python 3.11, whose user site-packages would otherwise be imported
// by the vendored 3.11 interpreter too.

const STRIPPED_PREFIXES = ['PYTHON', 'PIP_', 'UV_', 'CONDA', 'VIRTUAL_ENV', 'HF_', 'TORCH_HOME'];

/**
 * Copies `base` without variables that could redirect Python, pip or uv, then applies
 * `overrides`. Matching is case-insensitive because Windows environment names are.
 * Proxy and certificate variables are kept: they describe the network, not the install.
 */
export function isolatedEnv(base: NodeJS.ProcessEnv, overrides: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const overridden = new Set(Object.keys(overrides).map((k) => k.toUpperCase()));
  for (const [key, value] of Object.entries(base)) {
    const upper = key.toUpperCase();
    if (STRIPPED_PREFIXES.some((prefix) => upper.startsWith(prefix))) continue;
    if (overridden.has(upper)) continue;
    env[key] = value;
  }
  return { ...env, ...overrides };
}

export function pythonEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return isolatedEnv(base, {
    PYTHONNOUSERSITE: '1',
    PYTHONUTF8: '1',
    PIP_CONFIG_FILE: devNull,
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    PIP_NO_INPUT: '1',
    UV_CACHE_DIR: join(CACHE, 'uv'),
    UV_PYTHON_DOWNLOADS: 'never',
    HF_HUB_OFFLINE: '1',
    TORCH_HOME: join(MODELS, 'torch'),
    TMP,
    TEMP: TMP,
  });
}
