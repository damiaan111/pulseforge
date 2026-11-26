// ISF files as modules, without a GPU: the header becomes a schema, what cannot run says why, and
// the folder scan loads `.fs` files instead of ignoring them.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseIsf } from '../../src/engine/modules/isf.ts';
import { isfFileSource, shaderPrelude, shaderWrapping, validateShaderModule } from '../../src/engine/modules/shader-module.ts';
import { scanModules } from '../../src/modules-folder/scan.ts';

const file = (header: unknown, body = 'void main() { gl_FragColor = vec4(1.0); }\n') => `/*${JSON.stringify(header)}*/\n${body}`;
const valid = (name: string, text: string) => validateShaderModule(isfFileSource(name, text), new Set());

describe('the ISF header', () => {
  it('is a source without inputImage and an effect with it', () => {
    expect(parseIsf(file({ INPUTS: [] })).kind).toBe('source');
    expect(parseIsf(file({ INPUTS: [{ NAME: 'inputImage', TYPE: 'image' }] })).kind).toBe('effect');
  });

  it('turns every input with a uniform into a parameter', () => {
    const { params, refusals } = parseIsf(file({
      INPUTS: [
        { NAME: 'amount', TYPE: 'float', MIN: 0, MAX: 2, DEFAULT: 0.5, LABEL: 'Amount' },
        { NAME: 'open', TYPE: 'float', DEFAULT: 3 },
        { NAME: 'flip', TYPE: 'bool', DEFAULT: 1 },
        { NAME: 'pulse', TYPE: 'event' },
        { NAME: 'mode', TYPE: 'long', VALUES: [1, 2, 4], LABELS: ['One', 'Two', 'Four'], DEFAULT: 4 },
        { NAME: 'count', TYPE: 'long', MIN: 1, MAX: 8, DEFAULT: 3 },
        { NAME: 'tint', TYPE: 'color', DEFAULT: [1, 0.5, 0, 0.25] },
      ],
    }));
    expect(refusals).toEqual([]);
    expect(params.map((p) => [p.key, p.type])).toEqual([
      ['amount', 'float'], ['open', 'float'], ['flip', 'bool'], ['pulse', 'bool'], ['mode', 'enum'], ['count', 'int'], ['tint', 'color'],
    ]);
    expect(params[0]).toMatchObject({ label: 'Amount', min: 0, max: 2, default: 0.5 });
    // No range given: wide enough for the default, not narrowed around it.
    expect(params[1]).toMatchObject({ min: 0, max: 3, default: 3 });
    expect(params[2]).toMatchObject({ default: true });
    expect(params[4]).toMatchObject({ default: '4', options: [{ value: '1', label: 'One' }, { value: '2', label: 'Two' }, { value: '4', label: 'Four' }] });
    expect(params[6]).toMatchObject({ default: '#ff800040', allowAlpha: true });
  });

  it('survives a trailing comma, and reports a header that cannot be read', () => {
    expect(parseIsf('/*{ "INPUTS": [ ], }*/\nvoid main() {}').refusals).toEqual([]);
    expect(parseIsf('void main() {}').refusals[0]).toContain('no ISF header');
    expect(parseIsf('/* not json */ void main() {}').refusals[0]).toContain('not valid JSON');
  });

  it.each([
    ['point2D', { INPUTS: [{ NAME: 'p', TYPE: 'point2D' }] }, 'point2D input "p"'],
    ['a second image', { INPUTS: [{ NAME: 'startImage', TYPE: 'image' }] }, 'image input "startImage"'],
    ['audio', { INPUTS: [{ NAME: 'a', TYPE: 'audioFFT' }] }, 'audioFFT input "a"'],
    ['persistent', { PASSES: [{ TARGET: 'buf', PERSISTENT: true }] }, 'PERSISTENT buffer "buf"'],
    ['v1 persistent', { PERSISTENT_BUFFERS: ['old'] }, 'PERSISTENT buffer "old"'],
    ['two passes', { PASSES: [{ TARGET: 'a' }, {}] }, '2 PASSES'],
    ['a pass target', { PASSES: [{ TARGET: 'a' }] }, 'pass target "a"'],
    ['imported images', { IMPORTED: { noise: { PATH: 'noise.png' } } }, 'IMPORTED image'],
  ])('refuses %s, saying why', (_name, header, reason) => {
    expect(valid('X.fs', file(header)).join(' ')).toContain(reason);
  });
});

describe('validating an ISF module', () => {
  it('takes names the other dialects reserve, because inputs are bare uniforms', () => {
    expect(valid('X.fs', file({ INPUTS: [{ NAME: 'scale', TYPE: 'float' }, { NAME: 'seed', TYPE: 'float' }] }))).toEqual([]);
  });

  it('refuses names the wrapper or GLSL keeps', () => {
    expect(valid('X.fs', file({ INPUTS: [{ NAME: 'TIME', TYPE: 'float' }] })).join(' ')).toContain('"TIME"');
    expect(valid('X.fs', file({ INPUTS: [{ NAME: 'sample', TYPE: 'float' }] })).join(' ')).toContain('"sample"');
    expect(valid('X.fs', file({ INPUTS: [{ NAME: 'pf_x', TYPE: 'float' }] })).join(' ')).toContain('"pf_x"');
  });

  it('holds a manifest to what the header says', () => {
    const source = isfFileSource('X.fs', file({ INPUTS: [{ NAME: 'inputImage', TYPE: 'image' }, { NAME: 'a', TYPE: 'float' }] }));
    const manifest = { ...source.manifest, kind: 'source' as const, params: [] };
    const problems = validateShaderModule({ ...source, manifest }, new Set()).join(' ');
    expect(problems).toContain('makes it a effect');
    expect(problems).toContain('ISF inputs a');
  });

  it('builds id, name and tags from the file, keeping the credit', () => {
    const source = isfFileSource('Soft Glow.fs', file({ DESCRIPTION: 'Glows', CREDIT: 'by Someone', CATEGORIES: ['Blur', 'Stylize'], VSN: '2.0' }));
    expect(source.manifest).toMatchObject({ id: 'user.isf.soft-glow', name: 'Soft Glow', version: '2.0', description: 'Glows — by Someone', tags: ['isf', 'blur', 'stylize'] });
  });
});

describe('wrapping an ISF shader', () => {
  it('declares bare uniforms of the types ISF promises, and no u_ ones', () => {
    const source = isfFileSource('X.fs', file({ INPUTS: [
      { NAME: 'amount', TYPE: 'float' }, { NAME: 'flip', TYPE: 'bool' }, { NAME: 'mode', TYPE: 'long', VALUES: [0, 1] }, { NAME: 'tint', TYPE: 'color' },
    ] }));
    const { prelude, suffix } = shaderWrapping(source.manifest);
    for (const line of ['uniform float amount;', 'uniform bool flip;', 'uniform int mode;', 'uniform vec4 tint;', '#define main pf_isf_main']) expect(prelude).toContain(line);
    expect(prelude).not.toContain('u_amount');
    expect(suffix).toContain('pf_isf_main();');
  });

  it('leaves the Pulseforge prelude alone: golden frames depend on its text', () => {
    expect(shaderPrelude('source', []).startsWith('#version 300 es\nprecision highp float;')).toBe(true);
    expect(shaderPrelude('source', [])).not.toContain('isf');
  });
});

describe('scanning ISF files', () => {
  let root: string;
  const builtin = new Set<string>();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pulseforge-isf-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('loads a loose .fs file and reports a refused one', async () => {
    writeFileSync(join(root, 'Good.fs'), file({ INPUTS: [] }));
    writeFileSync(join(root, 'Point.fs'), file({ INPUTS: [{ NAME: 'p', TYPE: 'point2D' }] }));
    const scan = await scanModules(root, builtin);
    expect(scan.modules.map((m) => m.manifest.id)).toEqual(['user.isf.good']);
    expect(scan.problems).toHaveLength(1);
    expect(scan.problems[0]).toMatchObject({ folder: 'Point.fs' });
  });

  it('refuses a custom vertex shader once, on the .fs it belongs to', async () => {
    writeFileSync(join(root, 'Warp.fs'), file({ INPUTS: [] }));
    writeFileSync(join(root, 'Warp.vs'), 'void main() { isf_vertShaderInit(); }\n');
    writeFileSync(join(root, 'Alone.vs'), 'void main() {}\n');
    const scan = await scanModules(root, builtin);
    expect(scan.modules).toEqual([]);
    expect(scan.problems.map((p) => p.folder).sort()).toEqual(['Alone.vs', 'Warp.fs']);
    expect(scan.problems.find((p) => p.folder === 'Warp.fs')?.problems.join(' ')).toContain('custom vertex shader Warp.vs');
  });

  it('reads the header of a module folder that declares the dialect', async () => {
    mkdirSync(join(root, 'tint'));
    writeFileSync(join(root, 'tint', 'module.json'), JSON.stringify({ id: 'me.effect.tint', name: 'Tint', dialect: 'isf', shader: 'tint.fs' }));
    writeFileSync(join(root, 'tint', 'tint.fs'), file({ INPUTS: [{ NAME: 'inputImage', TYPE: 'image' }, { NAME: 'amount', TYPE: 'float' }] }));
    const scan = await scanModules(root, builtin);
    expect(scan.problems).toEqual([]);
    expect(scan.modules[0]?.manifest).toMatchObject({ id: 'me.effect.tint', kind: 'effect', name: 'Tint' });
    expect(scan.modules[0]?.manifest.params?.map((p) => p.key)).toEqual(['amount']);
  });

  it('reads a library beside the folder, with its refusals marked as the library\'s', async () => {
    const library = join(root, 'lib');
    mkdirSync(library);
    writeFileSync(join(library, 'Plasma.fs'), file({ INPUTS: [] }));
    writeFileSync(join(library, 'Stateful.fs'), file({ PASSES: [{ TARGET: 'b', PERSISTENT: true }] }));
    const scan = await scanModules(join(root, 'absent'), builtin, [library, join(root, 'not-installed')]);
    expect(scan.modules.map((m) => m.manifest.id)).toEqual(['isf.vidvox.plasma']);
    expect(scan.problems).toEqual([expect.objectContaining({ folder: 'Stateful.fs', library: true })]);
  });

  it('keeps a person\'s ids apart from the library\'s, and reports a clash inside it', async () => {
    const library = join(root, '_lib');
    mkdirSync(library);
    writeFileSync(join(root, 'A.fs'), file({ INPUTS: [] }));
    writeFileSync(join(library, 'A.fs'), file({ INPUTS: [] }));
    writeFileSync(join(library, 'a-.fs'), file({ INPUTS: [] }));
    const scan = await scanModules(root, builtin, [library]);
    expect(scan.modules.map((m) => m.manifest.id)).toEqual(['user.isf.a', 'isf.vidvox.a']);
    expect(scan.problems.map((p) => p.folder)).toEqual(['a-.fs']);
  });
});
