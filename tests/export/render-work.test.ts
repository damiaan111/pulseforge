// Each render has a scratch folder. Left behind, they add up to gigabytes nobody asked for.

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { sweepWork } from '../../src/shell/render-service.ts';

let root: string | undefined;

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

describe('sweepWork', () => {
  it('removes scratch no job needs, and keeps what a job still does', async () => {
    root = await mkdtemp(join(tmpdir(), 'pulseforge-work-'));
    for (const id of ['done-job', 'failed-job']) {
      await mkdir(join(root, id));
      await writeFile(join(root, id, 'job.analysis.bin'), 'x');
    }
    await sweepWork(root, new Set(['failed-job']));
    expect(existsSync(join(root, 'done-job'))).toBe(false);
    expect(existsSync(join(root, 'failed-job', 'job.analysis.bin'))).toBe(true);
  });

  it('is fine when there is no scratch folder yet', async () => {
    await expect(sweepWork(join(tmpdir(), 'pulseforge-no-such-folder'), new Set())).resolves.toBeUndefined();
  });
});
