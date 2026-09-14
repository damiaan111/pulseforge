import { describe, expect, it } from 'vitest';
import { ARTEFACTS, PYTHON_PACKAGES } from '../../setup/manifest.ts';
import { isolatedEnv, pythonEnv } from '../../setup/lib/env.ts';

describe('isolatedEnv', () => {
  it('strips variables that could redirect Python, pip or uv, case-insensitively', () => {
    const env = isolatedEnv(
      {
        Path: 'C:\\Windows',
        PythonPath: 'C:\\evil',
        PYTHONHOME: 'C:\\Python311',
        pip_index_url: 'https://mirror.example',
        UV_INDEX_URL: 'https://mirror.example',
        VIRTUAL_ENV: 'C:\\venv',
        HTTPS_PROXY: 'http://proxy:8080',
      },
      { PYTHONNOUSERSITE: '1' },
    );
    expect(env).toEqual({ Path: 'C:\\Windows', HTTPS_PROXY: 'http://proxy:8080', PYTHONNOUSERSITE: '1' });
  });

  it('lets overrides replace differently-cased originals instead of duplicating them', () => {
    const env = isolatedEnv({ temp: 'C:\\Users\\x\\AppData\\Local\\Temp' }, { TEMP: 'D:\\pulseforge\\vendor\\.tmp' });
    expect(Object.keys(env).filter((k) => k.toUpperCase() === 'TEMP')).toEqual(['TEMP']);
  });

  it('disables user site-packages and keeps temp and caches inside vendor/', () => {
    const env = pythonEnv({ PYTHONUSERBASE: 'C:\\x', TEMP: 'C:\\t' });
    expect(env['PYTHONNOUSERSITE']).toBe('1');
    expect(env['PYTHONUSERBASE']).toBeUndefined();
    expect(env['TEMP']).toMatch(/vendor[\\/]\.tmp$/);
    expect(env['UV_CACHE_DIR']).toMatch(/vendor[\\/]\.cache[\\/]uv$/);
  });
});

describe('manifest', () => {
  it.each(ARTEFACTS.map((a) => [a.id, a] as const))('%s is pinned to an https URL and a checksum', (_id, artefact) => {
    expect(artefact.url.startsWith('https://')).toBe(true);
    expect(decodeURIComponent(new URL(artefact.url).pathname).endsWith(artefact.kind === 'file' ? artefact.fileName : '')).toBe(true);
    if (artefact.kind === 'archive') {
      expect(artefact.sha256).toMatch(/^[0-9a-f]{64}$/);
    } else {
      expect(artefact.sha256 ?? artefact.sha256Prefix).toMatch(/^[0-9a-f]{8,64}$/);
    }
    expect(artefact.sizeBytes).toBeGreaterThan(0);
    expect(artefact.installDir).not.toMatch(/\.\.|^[\\/]/);
  });

  it('has unique ids', () => {
    expect(new Set(ARTEFACTS.map((a) => a.id)).size).toBe(ARTEFACTS.length);
  });

  it('pins torch to a CUDA index', () => {
    expect(PYTHON_PACKAGES.torchIndex).toMatch(new RegExp(`/whl/${PYTHON_PACKAGES.torchLocalVersion}$`));
  });
});
