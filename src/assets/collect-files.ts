// Carries out a "collect files" plan (src/project/collect.ts): copy every file, verify each copy,
// then write the project. The project file is written **last**, so a collect that fails halfway
// leaves copied media but never a project pointing at files that are not there.

import { existsSync } from 'node:fs';
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { collectedProjectName, planCollect } from '../project/collect.ts';
import type { ProjectDocument } from '../project/document.ts';
import { stringifyDocument } from '../project/serialize.ts';

export interface CollectResult {
  readonly projectPath: string;
  readonly copied: number;
  readonly bytes: number;
  /** References that could not be collected — missing source files, unresolvable paths. */
  readonly problems: readonly string[];
}

export class CollectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CollectError';
  }
}

/** `document` holds absolute paths (as the studio does) or paths relative to `sourceProjectPath`. */
export async function collectProject(document: ProjectDocument, sourceProjectPath: string | null, destination: string): Promise<CollectResult> {
  const plan = planCollect(document, sourceProjectPath, (relative) => existsSync(join(destination, relative)));
  const problems: string[] = plan.skipped.map((s) => `${s.what === 'audio' ? 'audio' : `asset ${nameOf(document, s.what)}`}: ${s.reason}`);

  let projectName = collectedProjectName(document);
  for (let n = 2; existsSync(join(destination, projectName)); n += 1) {
    projectName = collectedProjectName({ ...document, name: `${document.name || 'project'}-${n}` });
  }

  let copied = 0;
  let bytes = 0;
  let written = plan.document;
  for (const copy of plan.copies) {
    const target = join(destination, ...copy.to.split('/'));
    const label = copy.what === 'audio' ? 'audio' : `asset ${nameOf(document, copy.what)}`;
    if (!existsSync(copy.from)) {
      problems.push(`${label}: missing, not collected (${copy.from})`);
      written = restore(written, document, copy.to);
      continue;
    }
    try {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(copy.from, target);
      const [a, b] = await Promise.all([stat(copy.from), stat(target)]);
      if (a.size !== b.size) throw new Error(`copy is ${b.size} bytes, source ${a.size}`);
      copied += 1;
      bytes += b.size;
    } catch (error) {
      throw new CollectError(`Could not copy ${copy.from} to ${target}: ${(error as Error).message}`);
    }
  }

  const projectPath = join(destination, projectName);
  await writeFile(projectPath, stringifyDocument(written), 'utf8');
  return { projectPath, copied, bytes, problems };
}

function nameOf(document: ProjectDocument, id: string): string {
  const asset = document.assets.find((a) => a.id === id);
  return asset === undefined ? id : `"${asset.name}"`;
}

/**
 * References whose file could not be copied keep their original paths, so relink still has
 * something to go on. By target, not by id: assets sharing one planned copy all lose it.
 */
function restore(planned: ProjectDocument, original: ProjectDocument, target: string): ProjectDocument {
  const audio = planned.audio.path === target ? { ...planned.audio, path: original.audio.path } : planned.audio;
  const assets = planned.assets.map((a, i) => (a.path === target ? { ...a, path: original.assets[i]?.path ?? a.path } : a));
  return { ...planned, audio, assets };
}
