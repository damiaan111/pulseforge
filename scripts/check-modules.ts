// `npm run modules:check` — the module conformance test (M35, PROJECT.md §8.17, module-spec §11).
//
// For every module in modules/ it renders on the real GPU and checks what a module must promise
// before it can be trusted in an export:
//
//   determinism   the same frames rendered twice, in different orders, are byte-identical
//   draws         it produces something at its defaults (visualizers and sources)
//   reflow        it still draws at 9:16 and 1:1, not only the 16:9 it was written on
//   params        its declared defaults resolve cleanly and survive a JSON round trip
//
// A module that fails is reported here rather than quietly producing exports that do not
// reproduce. Folders that do not even load are listed with their reasons first.
//
// Usage: npm run modules:check [-- <modules dir>]

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { AnyLayerSpec, RenderProject } from '../src/engine/core/project.ts';
import { resolveParams } from '../src/engine/core/params.ts';
import { rational } from '../src/engine/core/time.ts';
import { BUILTIN_MODULES } from '../src/engine/engine.ts';
import { shaderModuleManifest, type ShaderModuleSource } from '../src/engine/modules/shader-module.ts';
import { scanModules } from '../src/modules-folder/scan.ts';
import { MODULES_DIR, ROOT } from '../setup/lib/paths.ts';
import { bundleElectron } from '../spike/harness.ts';
import { renderFrames, type RenderedFrame } from '../spike/lib/frames-run.ts';

interface CheckResult {
  readonly id: string;
  readonly folder: string;
  readonly passed: boolean;
  readonly checks: Readonly<Record<string, { readonly ok: boolean; readonly detail: string }>>;
}

const SIZES = { '16:9': [320, 180], '9:16': [180, 320], '1:1': [240, 240] } as const;
const FRAMES = [12, 40, 75];

function lit(frame: RenderedFrame): number {
  let count = 0;
  for (let i = 0; i < frame.pixels.length; i += 4) {
    if ((frame.pixels[i] ?? 0) + (frame.pixels[i + 1] ?? 0) + (frame.pixels[i + 2] ?? 0) > 24) count += 1;
  }
  return count / (frame.width * frame.height);
}

function project(source: ShaderModuleSource, width: number, height: number): RenderProject {
  const module: AnyLayerSpec = { id: 'module', module: source.manifest.id, enabled: true, opacity: 1, blend: 'normal', params: {} };
  // An effect needs something to work on: a test pattern with the effect in its chain.
  const layers: AnyLayerSpec[] = source.manifest.kind === 'effect'
    ? [{ id: 'pattern', module: 'core.test.pattern', enabled: true, opacity: 1, blend: 'normal', params: {}, effects: [{ id: 'fx', module: source.manifest.id, enabled: true, params: {} }] }]
    : [module];
  return {
    schemaVersion: 0,
    seed: 7,
    durationTicks: 48_000 * 2,
    canvas: { width, height, fps: rational(60), background: '#000000' },
    audio: { leadInTicks: 0, clipInTicks: 0 },
    layers,
  };
}

async function check(source: ShaderModuleSource): Promise<CheckResult> {
  const checks: Record<string, { ok: boolean; detail: string }> = {};
  const modules = [source];
  const slug = source.origin.replace(/\W+/g, '-');

  // params: defaults resolve with no issues and round-trip through JSON unchanged.
  const manifest = shaderModuleManifest(source);
  const resolved = resolveParams(manifest.params, {});
  const roundTrip = JSON.parse(JSON.stringify(resolved.values)) as unknown;
  checks['params'] = resolved.issues.length === 0 && JSON.stringify(roundTrip) === JSON.stringify(resolved.values)
    ? { ok: true, detail: `${manifest.params.length} parameter(s) resolve and round-trip` }
    : { ok: false, detail: resolved.issues.map((i) => `${i.key}: ${i.detail}`).join('; ') || 'defaults do not round-trip' };

  // determinism: two runs, opposite orders.
  const [w, h] = SIZES['16:9'];
  const [a, b] = await Promise.all([
    renderFrames({ name: `check-${slug}-a`, project: project(source, w, h), frames: FRAMES, modules }),
    renderFrames({ name: `check-${slug}-b`, project: project(source, w, h), frames: [...FRAMES].reverse(), modules }),
  ]);
  const broken = a.warnings.find((warning) => warning.includes('is broken'));
  if (broken !== undefined) {
    return { id: source.manifest.id, folder: source.origin, passed: false, checks: { ...checks, compile: { ok: false, detail: broken } } };
  }
  checks['compile'] = { ok: true, detail: 'compiles' };
  const hashes = (run: { frames: readonly RenderedFrame[] }) => Object.fromEntries(run.frames.map((f) => [f.frameIndex, f.sha256]));
  const same = JSON.stringify(hashes(a)) === JSON.stringify(Object.fromEntries(Object.entries(hashes(b)).sort(([x], [y]) => Number(x) - Number(y))));
  checks['determinism'] = same
    ? { ok: true, detail: `${FRAMES.length} frames identical across runs and render order` }
    : { ok: false, detail: 'the same frame rendered differently between runs — something depends on more than time and parameters' };

  // draws + reflow: something visible at every aspect.
  const coverage: string[] = [];
  let drawsEverywhere = true;
  for (const [aspect, [width, height]] of Object.entries(SIZES)) {
    const run = aspect === '16:9' ? a : await renderFrames({ name: `check-${slug}-${aspect.replace(':', 'x')}`, project: project(source, width, height), frames: [40], modules });
    const frame = run.frames.find((f) => f.frameIndex === 40) ?? run.frames[0]!;
    const fraction = lit(frame);
    coverage.push(`${aspect} ${(fraction * 100).toFixed(1)}%`);
    if (fraction < 0.001) drawsEverywhere = false;
  }
  checks['reflow'] = drawsEverywhere
    ? { ok: true, detail: `draws at every aspect (${coverage.join(', ')})` }
    : { ok: false, detail: `draws nothing at some aspect (${coverage.join(', ')}) — sizes should use u_scale, not raw pixels` };

  return { id: source.manifest.id, folder: source.origin, passed: Object.values(checks).every((c) => c.ok), checks };
}

async function main(): Promise<void> {
  const dir = process.argv[2] ?? MODULES_DIR;
  const scan = await scanModules(dir, new Set(BUILTIN_MODULES.map((m) => m.manifest.id)));
  console.log(`Modules in ${dir}: ${scan.modules.length} loadable, ${scan.problems.length} not`);
  for (const problem of scan.problems) console.log(`  ✖ modules/${problem.folder}: ${problem.problems.join('; ')}`);
  if (scan.modules.length === 0) return;

  await bundleElectron();
  const results: CheckResult[] = [];
  for (const source of scan.modules) {
    const result = await check(source);
    results.push(result);
    console.log(`  ${result.passed ? '✔' : '✖'} ${result.id} (modules/${result.folder})`);
    for (const [name, c] of Object.entries(result.checks)) console.log(`      ${c.ok ? 'ok  ' : 'FAIL'} ${name}: ${c.detail}`);
  }

  const out = join(ROOT, 'out', 'modules-check.json');
  await mkdir(join(ROOT, 'out'), { recursive: true });
  await writeFile(out, `${JSON.stringify({ dir, problems: scan.problems, results }, null, 2)}\n`);
  console.log(`Written to ${out}`);
  if (scan.problems.length > 0 || results.some((r) => !r.passed)) process.exitCode = 1;
}

await main();
