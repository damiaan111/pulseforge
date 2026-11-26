// The modules/ drop-in folder (M35): what loads, and — just as important — how everything that
// does not load says why, per folder and per field, while the rest still loads.

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BUILTIN_MODULES } from '../../src/engine/engine.ts';
import { shaderPrelude, validateShaderModule, type ShaderModuleSource } from '../../src/engine/modules/shader-module.ts';
import { scanModules } from '../../src/modules-folder/scan.ts';
import { MODULES_DIR } from '../../setup/lib/paths.ts';

const BUILTINS = new Set(BUILTIN_MODULES.map((m) => m.manifest.id));
const SHADER = 'void main() { outColor = vec4(1.0); }\n';
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pulseforge-modules-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function module(folder: string, manifest: unknown, shader: string | null = SHADER, shaderName = 'shader.frag'): Promise<void> {
  const dir = join(root, folder);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'module.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  if (shader !== null) await writeFile(join(dir, shaderName), shader);
}

const good = (id = 'me.visualizer.dot', extra: Record<string, unknown> = {}) => ({
  id, version: '1.0.0', kind: 'visualizer', name: 'Dot',
  params: [{ key: 'size', label: 'Size', group: 'Look', type: 'float', default: 0.2, min: 0, max: 1 }],
  ...extra,
});

describe('scanModules', () => {
  it('loads a valid module and ignores _drafts and dot-folders', async () => {
    await module('dot', good());
    await module('_draft', good('me.visualizer.draft'));
    await module('.hidden', good('me.visualizer.hidden'));
    const scan = await scanModules(root, BUILTINS);
    expect(scan.modules.map((m) => m.manifest.id)).toEqual(['me.visualizer.dot']);
    expect(scan.modules[0]?.origin).toBe('dot');
    expect(scan.problems).toEqual([]);
  });

  it('reports each broken folder by name and still loads the good ones', async () => {
    await module('a-good', good());
    await module('b-no-json', good(), SHADER);
    await rm(join(root, 'b-no-json', 'module.json'));
    await module('c-bad-json', '{ not json');
    await module('d-no-shader', good('me.visualizer.d'), null);
    await module('e-traversal', good('me.visualizer.e', { shader: '../evil.frag' }));
    const scan = await scanModules(root, BUILTINS);
    expect(scan.modules.map((m) => m.origin)).toEqual(['a-good']);
    const byFolder = Object.fromEntries(scan.problems.map((p) => [p.folder, p.problems.join(' ')]));
    expect(byFolder['b-no-json']).toContain('no module.json');
    expect(byFolder['c-bad-json']).toContain('not valid JSON');
    expect(byFolder['d-no-shader']).toContain('missing');
    expect(byFolder['e-traversal']).toContain("module's own folder");
  });

  it('refuses core ids, built-in ids and a second module claiming the same id', async () => {
    await module('a', good('me.visualizer.same'));
    await module('b', good('me.visualizer.same'));
    await module('c', good('core.visualizer.bars'));
    const scan = await scanModules(root, BUILTINS);
    expect(scan.modules.map((m) => m.origin)).toEqual(['a']);
    const text = scan.problems.map((p) => p.problems.join(' ')).join('\n');
    expect(text).toContain('already used');
    expect(text).toContain('reserved for built-in');
  });

  it('a missing modules folder is simply no modules', async () => {
    const scan = await scanModules(join(root, 'absent'), BUILTINS);
    expect(scan).toMatchObject({ modules: [], problems: [] });
  });

  it('the example that ships in modules/ is valid', async () => {
    const scan = await scanModules(MODULES_DIR, BUILTINS);
    expect(scan.problems).toEqual([]);
    expect(scan.modules.map((m) => m.manifest.id)).toContain('example.visualizer.pulse-rings');
  });
});

describe('validateShaderModule', () => {
  const source = (manifest: unknown, shader = SHADER): ShaderModuleSource =>
    ({ manifest: manifest as ShaderModuleSource['manifest'], shader, origin: 'x' });

  it('names the field for each schema mistake', () => {
    const problems = validateShaderModule(source({
      id: 'Bad Id', version: '', kind: 'scene3d', name: '',
      params: [
        { key: 'text', label: 'T', group: 'g', type: 'string', default: '' },
        { key: '2fast', label: 'F', group: 'g', type: 'float', default: 0, min: 0, max: 1 },
        { key: 'time', label: 'T', group: 'g', type: 'float', default: 0, min: 0, max: 1 },
        { key: 'range', label: 'R', group: 'g', type: 'float', default: 5, min: 0, max: 1 },
        { key: 'mode', label: 'M', group: 'g', type: 'enum', default: 'x', options: [{ value: 'y', label: 'Y' }] },
        { key: 'tint', label: 'C', group: 'g', type: 'color', default: 'red' },
        { key: 'on', label: 'O', group: 'g', type: 'bool', default: 'yes' },
      ],
    }), new Set());
    const text = problems.join('\n');
    for (const fragment of [
      'lowercase dotted', 'name is missing', 'version is missing', 'kind "scene3d"',
      '"text" has type "string"', '"2fast" must be a plain identifier', 'clash with the built-in uniform u_time',
      '"range" default must be a number between', '"mode" default is not one of its options',
      '"tint" default must be a hex colour', '"on" default must be true or false',
    ]) expect(text).toContain(fragment);
  });

  it('wants a main() and no #version of its own', () => {
    expect(validateShaderModule(source(good(), 'float x;'), new Set()).join(' ')).toContain('void main()');
    expect(validateShaderModule(source(good(), '#version 300 es\nvoid main(){}'), new Set()).join(' ')).toContain('#version');
  });
});

describe('shaderPrelude', () => {
  it('declares one uniform per parameter, typed for GLSL, and the input only for effects', () => {
    const prelude = shaderPrelude('visualizer', [
      { key: 'size', label: 'S', group: 'g', type: 'float', default: 0, min: 0, max: 1 },
      { key: 'count', label: 'C', group: 'g', type: 'int', default: 1, min: 1, max: 9 },
      { key: 'on', label: 'O', group: 'g', type: 'bool', default: true },
      { key: 'mode', label: 'M', group: 'g', type: 'enum', default: 'a', options: [{ value: 'a', label: 'A' }] },
      { key: 'tint', label: 'T', group: 'g', type: 'color', default: '#ffffff' },
    ]);
    expect(prelude).toContain('uniform float u_size;');
    expect(prelude).toContain('uniform float u_count;'); // ints arrive as float, documented
    expect(prelude).toContain('uniform bool u_on;');
    expect(prelude).toContain('uniform int u_mode;');
    expect(prelude).toContain('uniform vec3 u_tint;');
    expect(prelude).not.toContain('u_input');
    expect(shaderPrelude('effect', [])).toContain('uniform sampler2D u_input;');
  });
});

describe('Shadertoy dialect (S2)', () => {
  const ST = 'void mainImage(out vec4 fragColor, in vec2 fragCoord) { fragColor = vec4(fragCoord.x / iResolution.x); }\n';

  it('loads a bare .glsl file as a Shadertoy source named after the file', async () => {
    await writeFile(join(root, 'Plasma Tunnel.glsl'), ST);
    await writeFile(join(root, '_draft.glsl'), ST);
    const scan = await scanModules(root, BUILTINS);
    expect(scan.problems).toEqual([]);
    expect(scan.modules.map((m) => m.manifest)).toEqual([expect.objectContaining({
      id: 'user.shadertoy.plasma-tunnel', name: 'Plasma Tunnel', kind: 'source', dialect: 'shadertoy',
    })]);
  });

  it('a module.json may ask for the dialect, channels and alpha', async () => {
    await module('fx', { ...good('me.effect.warp'), kind: 'effect', params: [], dialect: 'shadertoy', channels: ['input', 'audio'], alpha: 'straight' }, ST);
    const scan = await scanModules(root, BUILTINS);
    expect(scan.problems).toEqual([]);
    expect(scan.modules[0]!.manifest).toMatchObject({ dialect: 'shadertoy', channels: ['input', 'audio'], alpha: 'straight' });
  });

  it('says what is wrong: no mainImage, a main() of its own, bad channels', async () => {
    await writeFile(join(root, 'nomain.glsl'), 'void main() { }\n');
    await module('input-on-source', { ...good('me.source.x'), kind: 'source', params: [], dialect: 'shadertoy', channels: ['input'] }, ST);
    const scan = await scanModules(root, BUILTINS);
    const text = JSON.stringify(scan.problems);
    expect(text).toContain('needs \\"void mainImage');
    expect(text).toContain('must not define main()');
    expect(text).toContain('only an effect has an input');
    expect(scan.modules).toEqual([]);
  });
});

describe('Shadertoy audio row', () => {
  it('puts a loud bin at the right place on the linear axis, and silence stays dark', async () => {
    const { shadertoySpectrumRow } = await import('../../src/engine/modules/shadertoy-audio.ts');
    const bins = new Float32Array(64);
    // Bin 34 of 64 log bins from 30 Hz to 16 kHz is centred near 1 kHz.
    bins[34] = 1;
    const row = shadertoySpectrumRow(bins);
    const peak = row.indexOf(Math.max(...row));
    const hz = ((peak + 0.5) / 512) * 11_025;
    expect(hz).toBeGreaterThan(850);
    expect(hz).toBeLessThan(1250);
    expect(row[400]).toBe(0);
    expect(shadertoySpectrumRow(new Float32Array(0)).every((v) => v === 0)).toBe(true);
  });
});
