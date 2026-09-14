import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSidecarLine, runSidecar } from '../../src/ml/sidecar.ts';
import { pythonEnv } from '../../setup/lib/env.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const PYTHON = resolve(ROOT, 'vendor', 'python', 'python.exe');

describe('parseSidecarLine', () => {
  it('parses protocol events', () => {
    expect(parseSidecarLine('{"event":"progress","fraction":0.5}')).toEqual({ event: 'progress', fraction: 0.5 });
    expect(parseSidecarLine('{"event":"error","type":"ValueError","message":"bad"}')).toMatchObject({ event: 'error', type: 'ValueError' });
  });

  it('turns stray output into log events instead of throwing', () => {
    expect(parseSidecarLine('Downloading something...')).toEqual({ event: 'log', message: 'Downloading something...' });
    expect(parseSidecarLine('{"event":"unknown"}')).toEqual({ event: 'log', message: '{"event":"unknown"}' });
    expect(parseSidecarLine('   ')).toBeUndefined();
  });
});

describe.skipIf(!existsSync(PYTHON))('sidecar process (vendored Python; skipped until `npm run setup`)', () => {
  const base = { pythonExe: PYTHON, packageRoot: resolve(ROOT, 'python'), env: pythonEnv() };

  it('reports health: torch with CUDA and demucs', async () => {
    const { result } = await runSidecar({ ...base, args: ['health'] });
    expect(result['cudaAvailable']).toBe(true);
    expect(String(result['torch'])).toMatch(/\+cu/);
    expect(result['demucs']).toBeTypeOf('string');
  }, 120_000);

  it('turns a Python failure into a specific error', async () => {
    await expect(
      runSidecar({ ...base, args: ['separate', '--input', resolve(ROOT, 'does-not-exist.f32'), '--repo', resolve(ROOT, 'vendor', 'models', 'demucs')] }),
    ).rejects.toThrow(/Error/);
  }, 120_000);
});
