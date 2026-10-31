// The `modules/` drop-in folder (M35, module-spec §12): scanned at startup, one module per
// sub-folder, `module.json` + a GLSL fragment shader.
//
// Node-side and read-only. It never executes anything from the folder — a module is data
// (src/engine/modules/shader-module.ts) — and a folder that is broken is reported, per folder and
// per field, while every other module still loads. One bad download must not cost the rest.
//
//   modules/
//     my-rings/
//       module.json      { "id": "me.visualizer.rings", "name": …, "kind": …, "params": [ … ] }
//       shader.frag      declarations and void main()
//     Plasma.glsl        a bare Shadertoy file
//     Plasma.fs          a bare ISF file (src/engine/modules/isf.ts)
//     _drafts/           ignored: a leading "_" or "." keeps a folder out of the scan

import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { isfFileSource, shadertoyFileSource, validateShaderModule, type ShaderModuleSource } from '../engine/modules/shader-module.ts';

export interface ModuleFolderProblem {
  readonly folder: string;
  readonly problems: readonly string[];
  /** A file of an installed library, not something the person put in the folder. */
  readonly library?: true;
}

export interface ModuleScan {
  readonly root: string;
  readonly modules: readonly ShaderModuleSource[];
  readonly problems: readonly ModuleFolderProblem[];
}

/** Largest shader accepted: a runaway file is almost certainly not a shader. */
const MAX_SHADER_BYTES = 256 * 1024;

const LOOSE_FILE = /\.(glsl|frag|fs|vs)$/i;

/**
 * One bare file, loaded or reported. A `.vs` is ISF's custom vertex shader: there is only the one
 * vertex shader here, so the `.fs` it belongs to is refused, and one with no `.fs` is reported itself.
 */
async function scanFile(
  root: string,
  file: string,
  siblings: readonly string[],
  isfPrefix: string,
  library: boolean,
  taken: Set<string>,
  modules: ShaderModuleSource[],
  problems: ModuleFolderProblem[],
): Promise<void> {
  const report = (list: string[]) => problems.push({ folder: file, problems: list, ...(library ? { library: true as const } : {}) });
  const has = (name: string) => siblings.some((sibling) => sibling.toLowerCase() === name.toLowerCase());
  const stem = file.slice(0, file.lastIndexOf('.'));
  if (/\.vs$/i.test(file)) {
    if (!has(`${stem}.fs`)) report([`${file} is a vertex shader with no .fs beside it, and a custom vertex shader cannot run here`]);
    return;
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(join(root, file));
  } catch (error) {
    report([`could not be read: ${(error as Error).message}`]);
    return;
  }
  if (bytes.length > MAX_SHADER_BYTES) {
    report([`${file} is ${bytes.length} bytes; a shader over ${MAX_SHADER_BYTES} is refused`]);
    return;
  }
  const isf = /\.fs$/i.test(file);
  const source = isf ? isfFileSource(file, bytes.toString('utf8'), isfPrefix) : shadertoyFileSource(file, bytes.toString('utf8'));
  const found = validateShaderModule(source, taken);
  if (isf && has(`${stem}.vs`)) found.push(`custom vertex shader ${stem}.vs: there is only the one vertex shader here`);
  if (found.length > 0) {
    report(found);
    return;
  }
  taken.add(source.manifest.id);
  modules.push(source);
}

/**
 * Reads every module in `root`, then the `.fs` files of each installed library in `libraries`.
 * `builtinIds` are the ids a drop-in may not take. Missing folder → no modules and no problems
 * (the folder is optional).
 */
export async function scanModules(root: string, builtinIds: ReadonlySet<string>, libraries: readonly string[] = []): Promise<ModuleScan> {
  const scanned = await scanFolder(root, builtinIds);
  const modules = [...scanned.modules];
  const problems = [...scanned.problems];
  const taken = new Set([...builtinIds, ...modules.map((m) => m.manifest.id)]);
  for (const library of libraries) {
    if (!existsSync(library)) continue;
    const files = (await readdir(library, { withFileTypes: true })).filter((e) => e.isFile() && /\.(fs|vs)$/i.test(e.name)).map((e) => e.name).sort();
    for (const file of files) await scanFile(library, file, files, 'isf.vidvox', true, taken, modules, problems);
  }
  return { root, modules, problems };
}

async function scanFolder(root: string, builtinIds: ReadonlySet<string>): Promise<ModuleScan> {
  if (!existsSync(root)) return { root, modules: [], problems: [] };
  const entries = await readdir(root, { withFileTypes: true });
  const modules: ShaderModuleSource[] = [];
  const problems: ModuleFolderProblem[] = [];
  const taken = new Set(builtinIds);

  // Sorted, so which of two modules claiming one id wins does not depend on the file system.
  const folders = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();

  // Bare files, no module.json needed: Shadertoy (S2) `Plasma.glsl`, or ISF `Plasma.fs`.
  const files = entries
    .filter((e) => e.isFile() && LOOSE_FILE.test(e.name) && !e.name.startsWith('_') && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
  for (const file of files) await scanFile(root, file, files, 'user.isf', false, taken, modules, problems);

  for (const folder of folders) {
    const dir = join(root, folder);
    const report = (list: string[]) => problems.push({ folder, problems: list });

    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(await readFile(join(dir, 'module.json'), 'utf8')) as Record<string, unknown>;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      report([code === 'ENOENT' ? 'no module.json in this folder' : `module.json is not valid JSON: ${(error as Error).message}`]);
      continue;
    }
    if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
      report(['module.json must hold an object']);
      continue;
    }

    const shaderFile = typeof manifest['shader'] === 'string' ? manifest['shader'] : 'shader.frag';
    if (shaderFile.includes('/') || shaderFile.includes('\\') || shaderFile.startsWith('.')) {
      report([`"shader" must name a file in the module's own folder, not "${shaderFile}"`]);
      continue;
    }
    let shader: string;
    try {
      const bytes = await readFile(join(dir, shaderFile));
      if (bytes.length > MAX_SHADER_BYTES) {
        report([`${shaderFile} is ${bytes.length} bytes; a shader over ${MAX_SHADER_BYTES} is refused`]);
        continue;
      }
      shader = bytes.toString('utf8');
    } catch {
      report([`the shader file "${shaderFile}" is missing`]);
      continue;
    }

    const { shader: _declared, ...fields } = manifest;
    // An ISF header already says what the module is; module.json adds to it (an id, a name).
    const declared = fields['dialect'] === 'isf' ? { ...isfFileSource(shaderFile, shader).manifest, ...fields } : fields;
    const source: ShaderModuleSource = { manifest: declared as unknown as ShaderModuleSource['manifest'], shader, origin: folder };
    const found = validateShaderModule(source, taken);
    if (found.length > 0) {
      report(found);
      continue;
    }
    taken.add(source.manifest.id);
    modules.push(source);
  }
  return { root, modules, problems };
}
