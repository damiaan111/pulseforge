// Drop-in modules on the GPU (M35): the example from modules/ renders and is deterministic, an
// effect module reads its input, parameters reach the shader, and a shader that does not compile
// is isolated — its layer is skipped with the author's own line number, the rest of the frame draws.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import type { AnyLayerSpec, RenderProject } from '../../src/engine/core/project.ts';
import { rational } from '../../src/engine/core/time.ts';
import { BUILTIN_MODULES } from '../../src/engine/engine.ts';
import type { ShaderModuleSource } from '../../src/engine/modules/shader-module.ts';
import { scanModules } from '../../src/modules-folder/scan.ts';
import { MODULES_DIR } from '../../setup/lib/paths.ts';
import { bundleElectron } from '../../spike/harness.ts';
import { renderFrames, type RenderedFrame } from '../../spike/lib/frames-run.ts';

const ELECTRON = resolve(import.meta.dirname, '..', '..', 'node_modules', 'electron', 'dist', 'electron.exe');
const available = existsSync(ELECTRON);

let example: ShaderModuleSource;

/** An effect that inverts its input: the simplest proof that u_input and pf_input work. */
const INVERT: ShaderModuleSource = {
  origin: 'test-invert',
  manifest: { id: 'test.effect.invert', version: '1.0.0', kind: 'effect', name: 'Invert', params: [] },
  shader: 'void main() { vec4 c = pf_input(pf_uv()); outColor = vec4(c.a - c.rgb, c.a); }\n',
};

/** Fills with a colour parameter — proves parameters arrive as uniforms, sRGB-decoded. */
const FILL: ShaderModuleSource = {
  origin: 'test-fill',
  manifest: {
    id: 'test.source.fill', version: '1.0.0', kind: 'source', name: 'Fill',
    params: [{ key: 'tint', label: 'Tint', group: 'Look', type: 'color', default: '#ff0000' }],
  },
  shader: 'void main() { outColor = vec4(u_tint, 1.0); }\n',
};

/** Line 3 has a type error. */
const BROKEN: ShaderModuleSource = {
  origin: 'test-broken',
  manifest: { id: 'test.visualizer.broken', version: '1.0.0', kind: 'visualizer', name: 'Broken', params: [] },
  shader: 'void main() {\n  float ok = 1.0;\n  vec2 wrong = 3.0 * true;\n  outColor = vec4(ok);\n}\n',
};

const layer = (module: string, params: Record<string, unknown> = {}, effects: AnyLayerSpec['effects'] = []): AnyLayerSpec => ({
  id: `layer-${module}`, module, enabled: true, opacity: 1, blend: 'normal', params, effects,
});

function project(layers: readonly AnyLayerSpec[]): RenderProject {
  return {
    schemaVersion: 0,
    seed: 11,
    durationTicks: 48_000 * 2,
    canvas: { width: 240, height: 135, fps: rational(60), background: '#000000' },
    audio: { leadInTicks: 0, clipInTicks: 0 },
    layers,
  };
}

const lit = (frame: RenderedFrame) => {
  let count = 0;
  for (let i = 0; i < frame.pixels.length; i += 4) if ((frame.pixels[i] ?? 0) + (frame.pixels[i + 1] ?? 0) + (frame.pixels[i + 2] ?? 0) > 30) count += 1;
  return count / (frame.width * frame.height);
};

describe.skipIf(!available)('drop-in modules on the GPU', () => {
  beforeAll(async () => {
    await bundleElectron();
    const scan = await scanModules(MODULES_DIR, new Set(BUILTIN_MODULES.map((m) => m.manifest.id)));
    example = scan.modules.find((m) => m.manifest.id === 'example.visualizer.pulse-rings')!;
  }, 180_000);

  it('the shipped example draws, and draws the same thing every time', async () => {
    const modules = [example];
    const p = project([layer('example.visualizer.pulse-rings')]);
    const [a, b] = await Promise.all([
      renderFrames({ name: 'mod-example-a', project: p, frames: [10, 50], modules }),
      renderFrames({ name: 'mod-example-b', project: p, frames: [50, 10], modules }),
    ]);
    expect(a.warnings.filter((w) => w.includes('broken'))).toEqual([]);
    expect(lit(a.frames[0]!)).toBeGreaterThan(0.01);
    const byIndex = (run: { frames: readonly RenderedFrame[] }) => Object.fromEntries(run.frames.map((f) => [f.frameIndex, f.sha256]));
    expect(byIndex(b)).toEqual(byIndex(a));
    expect(byIndex(a)[10]).not.toEqual(byIndex(a)[50]); // it moves with time
  }, 180_000);

  it('passes parameters as uniforms, and an effect module reads its input', async () => {
    const run = await renderFrames({
      name: 'mod-fill-invert',
      project: project([layer('test.source.fill', { tint: '#ff0000' }, [{ id: 'fx', module: 'test.effect.invert', enabled: true, params: {} }])]),
      frames: [0],
      modules: [FILL, INVERT],
    });
    const { r, g, b } = run.frames[0]!.at(120, 67);
    // Red filled, then inverted: cyan.
    expect(r).toBeLessThan(10);
    expect(g).toBeGreaterThan(240);
    expect(b).toBeGreaterThan(240);
  }, 180_000);

  it('isolates a shader that does not compile: the layer is skipped, the author’s line is named, the frame still draws', async () => {
    const run = await renderFrames({
      name: 'mod-broken',
      project: project([layer('test.source.fill', { tint: '#00ff00' }), layer('test.visualizer.broken')]),
      frames: [0, 1],
      modules: [FILL, BROKEN],
    });
    const warning = run.warnings.find((w) => w.includes('test.visualizer.broken'));
    expect(warning).toBeDefined();
    expect(warning).toContain('is broken');
    expect(warning).toMatch(/:3\b/); // line 3 of the author's shader, not of the prelude
    expect(run.frames[0]!.at(120, 67).g).toBeGreaterThan(240); // the good layer still rendered
  }, 180_000);
});
