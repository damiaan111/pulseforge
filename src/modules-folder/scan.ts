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
//     _drafts/           ignored: a leading "_" or "." keeps a folder out of the scan

import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { shadertoyFileSource, validateShaderModule, type ShaderModuleSource } from '../engine/modules/shader-module.ts';

export interface ModuleFolderProblem {
  readonly folder: string;
  readonly problems: readonly string[];
}

export interface ModuleScan {
  readonly root: string;
  readonly modules: readonly ShaderModuleSource[];
  readonly problems: readonly ModuleFolderProblem[];
}

/** Largest shader accepted: a runaway file is almost certainly not a shader. */
const MAX_SHADER_BYTES = 256 * 1024;

/**
 * Reads every module in `root`. `builtinIds` are the ids a drop-in may not take. Missing folder →
 * no modules and no problems (the folder is optional).
 */
export async function scanModules(root: string, builtinIds: ReadonlySet<string>): Promise<ModuleScan> {
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

  // Bare Shadertoy files (S2): `Plasma.glsl` straight in the folder, no module.json needed.
  const files = entries
    .filter((e) => e.isFile() && /\.(glsl|frag)$/i.test(e.name) && !e.name.startsWith('_') && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
  for (const file of files) {
    const report = (list: string[]) => problems.push({ folder: file, problems: list });
    let bytes: Buffer;
    try {
      bytes = await readFile(join(root, file));
    } catch (error) {
      report([`could not be read: ${(error as Error).message}`]);
      continue;
    }
    if (bytes.length > MAX_SHADER_BYTES) {
      report([`${file} is ${bytes.length} bytes; a shader over ${MAX_SHADER_BYTES} is refused`]);
      continue;
    }
    const source = shadertoyFileSource(file, bytes.toString('utf8'));
    const found = validateShaderModule(source, taken);
    if (found.length > 0) {
      report(found);
      continue;
    }
    taken.add(source.manifest.id);
    modules.push(source);
  }

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
    const source: ShaderModuleSource = { manifest: fields as unknown as ShaderModuleSource['manifest'], shader, origin: folder };
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
