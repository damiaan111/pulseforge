// The template library, in memory (auto-director-spec §10 step 5). Pure: the main process reads the
// folders (template-store.ts) and the studio parses what it is sent, here. User templates replace
// built-ins with the same id; a file that does not parse is a listed problem, never a gap.

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
