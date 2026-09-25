// Templates on disk (auto-director-spec §10 step 5, data-formats §3).
//
// Like presets: small JSON files in known folders, hand-editable and git-friendly. Built-ins ship in
// the repo's `templates/builtin/`; the user's own go in Documents/Pulseforge/Templates and win an id
// collision, so a user can override a built-in by copying and editing it. A file that does not
// parse is listed as a problem with its reason rather than skipped (CLAUDE.md #4). Plain Node: the
// main process reads the folders, the studio parses what it is sent.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { parseTemplate, type Template, type TemplateIssue } from './template.ts';

export type TemplateOrigin = 'builtin' | 'user';

export interface TemplateFile {
  readonly origin: TemplateOrigin;
  readonly path: string;
  readonly text: string;
  /** Set when the file could not be read at all. */
  readonly error?: string;
}

export interface TemplateProblem {
  readonly path: string;
  readonly message: string;
}

export interface LoadedTemplate {
  readonly origin: TemplateOrigin;
  readonly path: string;
  readonly template: Template;
  /** Parsed with problems: usable, but the author should know (shown in the Auto panel). */
  readonly issues: readonly TemplateIssue[];
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

/** Parses the files; user templates replace built-ins with the same id. Pure — used by the studio. */
export function loadTemplates(files: readonly TemplateFile[]): { templates: LoadedTemplate[]; problems: TemplateProblem[] } {
  const byId = new Map<string, LoadedTemplate>();
  const problems: TemplateProblem[] = [];
  for (const file of files) {
    if (file.error !== undefined) {
      problems.push({ path: file.path, message: `could not be read: ${file.error}` });
      continue;
    }
    try {
      const { template, issues } = parseTemplate(JSON.parse(file.text));
      if (template.id === '') {
        problems.push({ path: file.path, message: 'has no "id"' });
        continue;
      }
      byId.set(template.id, { origin: file.origin, path: file.path, template, issues });
    } catch (error) {
      problems.push({ path: file.path, message: (error as Error).message });
    }
  }
  return { templates: [...byId.values()].sort((a, b) => (a.template.name < b.template.name ? -1 : 1)), problems };
}
