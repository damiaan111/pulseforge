// Template files on disk and their parsing (auto-director-spec §10 step 5): built-ins and user
// templates merged, a user template winning an id collision, a broken file listed — never skipped.

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadTemplates } from '../../src/director/template-library.ts';
import { readTemplateFiles } from '../../src/director/template-store.ts';
import { TEMPLATE_DIR } from './fixture.ts';

describe('the template library', () => {
  it('reads the built-ins, lets a user template replace one by id, and lists a broken file', async () => {
    const user = await mkdtemp(join(tmpdir(), 'pf-templates-'));
    await mkdir(user, { recursive: true });
    await writeFile(join(user, 'mine.json'), JSON.stringify({
      formatVersion: 1, id: 'tpl.neon.pulse', name: 'My Pulse',
      slots: [{ id: 'HERO', role: 'HERO', required: true, candidates: [{ module: 'core.visualizer.bars' }] }],
    }));
    await writeFile(join(user, 'broken.json'), '{ not json');
    const { templates, problems } = loadTemplates(await readTemplateFiles({ builtin: TEMPLATE_DIR, user }));
    expect(templates.length).toBe(7);
    const pulse = templates.find((t) => t.template.id === 'tpl.neon.pulse')!;
    expect(pulse.origin).toBe('user');
    expect(pulse.template.name).toBe('My Pulse');
    expect(problems.map((p) => p.path)).toEqual([join(user, 'broken.json')]);
  });

  it('a missing user folder is simply empty', async () => {
    const files = await readTemplateFiles({ builtin: TEMPLATE_DIR, user: join(tmpdir(), 'pf-no-such-folder-xyz') });
    expect(files.every((f) => f.origin === 'builtin')).toBe(true);
  });
});
