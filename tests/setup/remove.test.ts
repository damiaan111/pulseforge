// Taking a component off the disk, in a data folder of its own: its files and its lock lines go,
// and nothing else does.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type * as Components from '../../setup/components.ts';
import type * as Remove from '../../setup/lib/remove.ts';
import type * as Manifest from '../../setup/manifest.ts';

let data: string;
let vendor: string;
let remove: typeof Remove;
let manifest: typeof Manifest;
let components: typeof Components;

beforeAll(async () => {
  data = mkdtempSync(join(tmpdir(), 'pulseforge-remove-'));
  vendor = join(data, 'vendor');
  vi.stubEnv('PULSEFORGE_DATA', data);
  vi.resetModules();
  remove = await import('../../setup/lib/remove.ts');
  manifest = await import('../../setup/manifest.ts');
  components = await import('../../setup/components.ts');
});

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(data, { recursive: true, force: true });
});

function place(dir: string, file: string): string {
  mkdirSync(join(vendor, dir), { recursive: true });
  writeFileSync(join(vendor, dir, file), 'x');
  return join(vendor, dir, file);
}

describe('removing a component', () => {
  it('writes to the data folder it was given', async () => {
    const { DATA_ROOT, VENDOR } = await import('../../setup/lib/paths.ts');
    expect(DATA_ROOT).toBe(data);
    expect(VENDOR).toBe(vendor);
  });

  it('takes the model and its lock lines, and leaves the neighbours', async () => {
    const [file] = manifest.EXTRA_ARTEFACTS['align-fr'];
    const [other] = manifest.EXTRA_ARTEFACTS['align-de'];
    const french = place(file!.installDir, file!.fileName);
    const german = place(other!.installDir, other!.fileName);
    writeFileSync(join(vendor, 'vendor.lock.json'), JSON.stringify({ schemaVersion: 1, artefacts: [{ id: file!.id }, { id: other!.id }] }));
    expect(components.componentInstalled('align-fr')).toBe(true);

    await remove.removeComponent('align-fr');

    expect(existsSync(french)).toBe(false);
    expect(existsSync(german)).toBe(true);
    expect(components.componentInstalled('align-fr')).toBe(false);
    const lock = JSON.parse(readFileSync(join(vendor, 'vendor.lock.json'), 'utf8')) as { artefacts: { id: string }[] };
    expect(lock.artefacts.map((a) => a.id)).toEqual([other!.id]);
  });

  it('removes the yaml that makes a Demucs model selectable', async () => {
    const yaml = place('models/demucs', 'htdemucs_6s.yaml');
    await remove.removeComponent('htdemucs_6s');
    expect(existsSync(yaml)).toBe(false);
  });

  it('refuses what shares the Python environment', async () => {
    expect(components.componentRemovable('stems')).toBe(false);
    expect(components.componentRemovable('lyrics')).toBe(false);
    expect(components.componentRemovable('core')).toBe(false);
    expect(components.componentRemovable('milkdrop')).toBe(true);
    await expect(remove.removeComponent('stems')).rejects.toThrow(/cannot be removed/);
  });
});
