// ISF shaders on the GPU: coordinates, time and colour as ISF defines them, inputs reaching their bare
// uniforms with the right meaning, an effect that passes its input through changing nothing, a compile
// error naming the author's line, and the installed library compiling for real.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import type { AnyLayerSpec, RenderProject } from '../../src/engine/core/project.ts';
import { rational } from '../../src/engine/core/time.ts';
import { BUILTIN_MODULES } from '../../src/engine/engine.ts';
import { isfFileSource, type ShaderModuleSource } from '../../src/engine/modules/shader-module.ts';
import { scanModules } from '../../src/modules-folder/scan.ts';
import { ISF_DIR, ROOT } from '../../setup/lib/paths.ts';
import { bundleElectron } from '../../spike/harness.ts';
import { renderFrames, type RenderedFrame } from '../../spike/lib/frames-run.ts';

const ELECTRON = resolve(import.meta.dirname, '..', '..', 'node_modules', 'electron', 'dist', 'electron.exe');
const available = existsSync(ELECTRON);
const W = 200;
const H = 100;
/** The library when it is not installed where the app would have it. */
const LIBRARY = process.env['PULSEFORGE_ISF_TEST_DIR'] ?? ISF_DIR;

/** A few of each kind from the library: generators and effects with colours, longs and bools. */
const SAMPLES = ['Noise.fs', 'Spiral.fs', 'Worley Cells.fs', 'Truchet Tile.fs', 'Color Invert.fs', 'Bad TV.fs', 'CMYK Halftone.fs', 'Toon.fs'];

function lit(frame: RenderedFrame): number {
  let count = 0;
  for (let i = 0; i < frame.pixels.length; i += 4) if ((frame.pixels[i] ?? 0) + (frame.pixels[i + 1] ?? 0) + (frame.pixels[i + 2] ?? 0) > 24) count += 1;
  return count / (frame.width * frame.height);
}

const GRADIENT = isfFileSource('Gradient.fs', `/*{ "ISFVSN": "2", "INPUTS": [] }*/
void main() {
  gl_FragColor = vec4(isf_FragNormCoord.x, isf_FragNormCoord.y, fract(TIME), 1.0);
}
`);

/** Red is the value `long` delivers, green a `float` named as a reserved uniform of the other dialects, blue a bool. */
const INPUTS = isfFileSource('Inputs.fs', `/*{ "INPUTS": [
  { "NAME": "mode", "TYPE": "long", "VALUES": [1, 2, 4], "DEFAULT": 2 },
  { "NAME": "scale", "TYPE": "float", "DEFAULT": 0.5 },
  { "NAME": "flag", "TYPE": "bool", "DEFAULT": 0 }
] }*/
void main() {
  gl_FragColor = vec4(float(mode) / 4.0, scale, flag ? 1.0 : 0.0, 1.0);
}
`);

/** Writes its colour straight out, alpha included. */
const COLOR = isfFileSource('Color.fs', `/*{ "INPUTS": [ { "NAME": "tint", "TYPE": "color", "DEFAULT": [0.5, 0.25, 1.0, 1.0] } ] }*/
void main() { gl_FragColor = tint; }
`);

const PASS_THROUGH = isfFileSource('Pass.fs', `/*{ "INPUTS": [ { "NAME": "inputImage", "TYPE": "image" } ] }*/
void main() { gl_FragColor = IMG_THIS_PIXEL(inputImage); }
`);

/** Every way of reading the input, each an identity; a wrong macro shows as a difference from Pass. */
const READS = isfFileSource('Reads.fs', `/*{ "INPUTS": [ { "NAME": "inputImage", "TYPE": "image" } ] }*/
void main() {
  vec4 a = IMG_NORM_PIXEL(inputImage, isf_FragNormCoord);
  vec4 b = IMG_PIXEL(inputImage, gl_FragCoord.xy);
  vec4 c = IMG_THIS_NORM_PIXEL(inputImage);
  vec4 d = texture2D(inputImage, gl_FragCoord.xy / IMG_SIZE(inputImage));
  gl_FragColor = (a + b + c + d) / 4.0;
}
`);

/** Display 0.5 grey, read as what the author sees. */
const PROBE = isfFileSource('Probe.fs', `/*{ "INPUTS": [ { "NAME": "inputImage", "TYPE": "image" } ] }*/
void main() {
  vec4 c = IMG_THIS_PIXEL(inputImage);
  gl_FragColor = vec4(abs(c.r - 0.5) < 0.02 ? 1.0 : 0.0, 0.0, 0.0, 1.0);
}
`);

/** Line 4 of the file has a type error. */
const BROKEN = isfFileSource('Broken.fs', `/*{ "INPUTS": [] }*/
void main() {
  float ok = 1.0;
  vec2 wrong = 3.0 * true;
  gl_FragColor = vec4(ok);
}
`);

const layer = (source: ShaderModuleSource, params: Record<string, unknown> = {}): AnyLayerSpec => ({
  id: `layer-${source.manifest.id}`, module: source.manifest.id, enabled: true, opacity: 1, blend: 'normal', params,
});

const pattern = (effects: readonly ShaderModuleSource[]): AnyLayerSpec => ({
  id: 'pattern', module: 'core.test.pattern', enabled: true, opacity: 1, blend: 'normal', params: {},
  effects: effects.map((source, i) => ({ id: `fx-${i}`, module: source.manifest.id, enabled: true, params: {} })),
});

const grey = (effects: readonly ShaderModuleSource[]): AnyLayerSpec => ({
  id: 'grey', module: 'core.source.background', enabled: true, opacity: 1, blend: 'normal', params: { mode: 'solid', colorA: '#808080' },
  effects: effects.map((source, i) => ({ id: `fx-${i}`, module: source.manifest.id, enabled: true, params: {} })),
});

function project(layers: readonly AnyLayerSpec[]): RenderProject {
  return {
    schemaVersion: 0, seed: 3, durationTicks: 48_000 * 2,
    canvas: { width: W, height: H, fps: rational(10), background: '#000000' },
    audio: { leadInTicks: 0, clipInTicks: 0 },
    layers,
  };
}

describe.skipIf(!available)('ISF shaders on the GPU', () => {
  beforeAll(async () => {
    await bundleElectron();
  }, 180_000);

  it('coordinates, colour and TIME as ISF defines them, repeatably', async () => {
    const [run, again] = await Promise.all([
      renderFrames({ name: 'isf-gradient', project: project([layer(GRADIENT)]), frames: [5], modules: [GRADIENT] }),
      renderFrames({ name: 'isf-gradient-2', project: project([layer(GRADIENT)]), frames: [5], modules: [GRADIENT] }),
    ]);
    expect(run.warnings).toEqual([]);
    const frame = run.frames[0]!;
    const middle = frame.at(W / 2, H / 2);
    expect(Math.abs(middle.r - 128)).toBeLessThanOrEqual(3);
    expect(frame.at(W / 2, 1).g).toBeGreaterThan(240);
    expect(frame.at(W / 2, H - 2).g).toBeLessThan(10);
    expect(Math.abs(middle.b - 128)).toBeLessThanOrEqual(3);
    expect(again.frames[0]!.sha256).toBe(frame.sha256);
  }, 180_000);

  it('a long arrives as its value, inputs as bare uniforms', async () => {
    const run = await renderFrames({ name: 'isf-inputs', project: project([layer(INPUTS, { mode: '4', flag: true })]), frames: [0], modules: [INPUTS] });
    expect(run.warnings).toEqual([]);
    const { r, g, b } = run.frames[0]!.at(W / 2, H / 2);
    expect(r).toBeGreaterThan(250); // 4, not index 2
    expect(Math.abs(g - 128)).toBeLessThanOrEqual(3);
    expect(b).toBeGreaterThan(250);
  }, 180_000);

  it('a colour arrives display-referred, not decoded to linear', async () => {
    const run = await renderFrames({ name: 'isf-color', project: project([layer(COLOR)]), frames: [0], modules: [COLOR] });
    expect(run.warnings).toEqual([]);
    const { r, g, b } = run.frames[0]!.at(W / 2, H / 2);
    expect(Math.abs(r - 128)).toBeLessThanOrEqual(3);
    expect(Math.abs(g - 64)).toBeLessThanOrEqual(3);
    expect(b).toBeGreaterThan(250);
  }, 180_000);

  it('passing the input through changes nothing, by any way of reading it', async () => {
    const [plain, passed, reads] = await Promise.all([
      renderFrames({ name: 'isf-plain', project: project([pattern([])]), frames: [3], modules: [] }),
      renderFrames({ name: 'isf-pass', project: project([pattern([PASS_THROUGH])]), frames: [3], modules: [PASS_THROUGH] }),
      renderFrames({ name: 'isf-reads', project: project([pattern([READS])]), frames: [3], modules: [READS] }),
    ]);
    expect(passed.warnings).toEqual([]);
    expect(reads.warnings).toEqual([]);
    const before = plain.frames[0]!.pixels;
    for (const after of [passed.frames[0]!.pixels, reads.frames[0]!.pixels]) {
      let worst = 0;
      for (let i = 0; i < before.length; i += 1) worst = Math.max(worst, Math.abs((before[i] ?? 0) - (after[i] ?? 0)));
      expect(worst).toBeLessThanOrEqual(1);
    }
  }, 180_000);

  it('the input reads as display colour inside the shader', async () => {
    const run = await renderFrames({ name: 'isf-probe', project: project([grey([PROBE])]), frames: [0], modules: [PROBE] });
    expect(run.warnings).toEqual([]);
    expect(run.frames[0]!.at(W / 2, H / 2).r).toBeGreaterThan(250);
  }, 180_000);

  it('a compile error names the line of the file, and the layer is skipped', async () => {
    const run = await renderFrames({ name: 'isf-broken', project: project([layer(GRADIENT), layer(BROKEN)]), frames: [0], modules: [GRADIENT, BROKEN] });
    const warning = run.warnings.find((w) => w.includes(BROKEN.manifest.id));
    expect(warning).toBeDefined();
    expect(warning).toMatch(/:4\b/);
    expect(run.frames[0]!.at(W / 2, 1).g).toBeGreaterThan(240);
  }, 180_000);

  describe.skipIf(!existsSync(LIBRARY))('the installed library', () => {
    const scanned = async () => scanModules(resolve(LIBRARY, 'absent'), new Set(BUILTIN_MODULES.map((m) => m.manifest.id)), [LIBRARY]);

    it('compiles, each file on its own layer, but for the five that are not GLSL ES', async () => {
      const scan = await scanned();
      const sources = scan.modules.filter((m) => m.manifest.kind === 'source');
      const effects = scan.modules.filter((m) => m.manifest.kind === 'effect');
      const run = await renderFrames({
        name: 'isf-library',
        project: project([...sources.map((m) => layer(m)), ...effects.map((m) => pattern([m]))]),
        frames: [7],
        modules: scan.modules,
      });
      const broken = run.warnings.filter((w) => w.includes('is broken'));
      // The counts are the result: what the library gives, and why the rest does not run.
      mkdirSync(join(ROOT, 'out'), { recursive: true });
      writeFileSync(join(ROOT, 'out', 'isf-library.json'), `${JSON.stringify({ loaded: scan.modules.length, refused: scan.problems, broken }, null, 2)}\n`);
      expect(scan.modules.length).toBe(110);
      expect(scan.problems.length).toBe(217);
      // Each redefines a built-in or leans on a desktop GLSL conversion, on a line the error names.
      const names = broken.map((w) => /modules\/(.+?): the shader/.exec(w)?.[1]).sort();
      expect(names).toEqual(['Broken LCD.fs', 'Poly Glitch.fs', 'Random Characters.fs', 'Tiny Date Time Overlay.fs', 'VU Meter.fs']);
    }, 600_000);

    it.each(SAMPLES)('%s draws, and the same thing in any render order', async (file) => {
      const source = (await scanned()).modules.find((m) => m.origin === file);
      expect(source, file).toBeDefined();
      const layers = source!.manifest.kind === 'effect' ? [pattern([source!])] : [layer(source!)];
      const [a, b] = await Promise.all([
        renderFrames({ name: `isf-sample-${file}-a`, project: project(layers), frames: [4, 15], modules: [source!] }),
        renderFrames({ name: `isf-sample-${file}-b`, project: project(layers), frames: [15, 4], modules: [source!] }),
      ]);
      expect(a.warnings.filter((w) => w.includes('is broken'))).toEqual([]);
      const byIndex = (run: { frames: readonly RenderedFrame[] }) => Object.fromEntries(run.frames.map((f) => [f.frameIndex, f.sha256]));
      expect(byIndex(b)).toEqual(byIndex(a));
      expect(lit(a.frames[0]!)).toBeGreaterThan(0.01);
    }, 180_000);
  });
});
