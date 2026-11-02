// Templates on disk (auto-director-spec §10 step 5, data-formats §3).
//
// Like presets: small JSON files in known folders, hand-editable and git-friendly. Built-ins ship in
// the repo's `templates/builtin/`; the user's own go in Documents/Pulseforge/Templates and win an id
// collision, so a user can override a built-in by copying and editing it. A file that does not
// parse is listed as a problem with its reason rather than skipped (CLAUDE.md #4). Plain Node: the
// main process reads the folders; the studio parses what it is sent (template-library.ts).

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { TemplateFile } from './template-library.ts';

/**
 * A new template in the user's folder, as `<stem>.json`. Refuses to replace a file: a draft must
 * never quietly overwrite something already there, so a clash is the caller's to name differently.
 */
export async function writeUserTemplate(folder: string, stem: string, text: string): Promise<string> {
  if (!/^[a-z0-9][a-z0-9.-]{0,79}$/.test(stem)) throw new Error(`"${stem}" is not a template file name.`);
  await mkdir(folder, { recursive: true });
  const path = join(folder, `${stem}.json`);
  await writeFile(path, text, { encoding: 'utf8', flag: 'wx' });
  return path;
}

/** Every `.json` in the two folders, as text. A missing folder is simply empty. */
export async function readTemplateFiles(folders: { readonly builtin: string; readonly user: string }): Promise<TemplateFile[]> {
  const out: TemplateFile[] = [];
  for (const [origin, folder] of [['builtin', folders.builtin], ['user', folders.user]] as const) {
    let names: string[];
    try {
      names = (await readdir(folder)).filter((name) => name.toLowerCase().endsWith('.json')).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(folder, name);
      try {
        out.push({ origin, path, text: await readFile(path, 'utf8') });
      } catch (error) {
        out.push({ origin, path, text: '', error: (error as Error).message });
      }
    }
  }
  return out;
}
