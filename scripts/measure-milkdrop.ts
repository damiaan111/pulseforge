// `npm run milkdrop:measure` — renders every installed MilkDrop preset and measures what it looks
// like, so the auto-director can choose one by the track (src/director/milkdrop-catalogue.ts).
//
// The director is a pure function, and must make the same project on any machine, so what it knows
// about a preset is measured once, here, and committed. The presets are pinned by hash, so the
// numbers cannot drift from them. A run takes about half an hour and carries on where it stopped:
// results go to out/milkdrop-measure.json as they arrive. `--write` turns them into the catalogue.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { MILKDROP_JS_DIR, ROOT } from '../setup/lib/paths.ts';
import { analyzeMix } from '../src/analysis/analyze.ts';
import type { RenderProject } from '../src/engine/core/project.ts';
import { rational } from '../src/engine/core/time.ts';
import { bundleElectron } from '../spike/harness.ts';
import { renderFrames, type RenderedFrame } from '../spike/lib/frames-run.ts';
import { synthesizeTestTrack } from '../spike/test-signal.ts';

const RESULTS = join(ROOT, 'out', 'milkdrop-measure.json');
const CATALOGUE = join(ROOT, 'src', 'director', 'milkdrop-catalogue.ts');
const WORKERS = 4;
const SECONDS = 14;
/** Pairs of neighbours at 8, 10 and 12 s: long enough for a preset to build its picture. */
const FRAMES = [240, 241, 300, 301, 360, 361];

/** Below this much light, or this share of the frame lit, a preset reads as a black screen. */
const MIN_LUMA = 0.03;
const MIN_COVERAGE = 0.04;
/** Nothing changes across four seconds: a frozen picture. */
const MIN_CHANGE = 0.004;
/** A whole-frame jump between neighbouring frames: strobing, which hurts to watch. */
const MAX_FLICKER = 0.18;
/** No structure at all: a flat wash of colour. */
const MIN_DETAIL = 0.002;

interface Measured {
  readonly name: string;
  readonly failed?: string;
  readonly luma?: number;
  readonly coverage?: number;
  readonly saturation?: number;
  readonly hue?: number;
  readonly motion?: number;
  readonly change?: number;
  readonly flicker?: number;
  readonly detail?: number;
}

const lumaOf = (r: number, g: number, b: number) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

function lumaPlane(frame: RenderedFrame): Float32Array {
  const plane = new Float32Array(frame.width * frame.height);
  for (let i = 0; i < plane.length; i += 1) {
    plane[i] = lumaOf(frame.pixels[i * 4] ?? 0, frame.pixels[i * 4 + 1] ?? 0, frame.pixels[i * 4 + 2] ?? 0);
  }
  return plane;
}

const meanOf = (plane: Float32Array) => plane.reduce((sum, v) => sum + v, 0) / plane.length;

function difference(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  return sum / a.length;
}

function measure(name: string, frames: readonly RenderedFrame[]): Measured {
  const planes = frames.map(lumaPlane);
  let saturation = 0;
  let lit = 0;
  let hueX = 0;
  let hueY = 0;
  let pixels = 0;
  let detail = 0;
  for (const [index, frame] of frames.entries()) {
    const plane = planes[index] as Float32Array;
    for (let i = 0; i < plane.length; i += 1) {
      const r = frame.pixels[i * 4] ?? 0;
      const g = frame.pixels[i * 4 + 1] ?? 0;
      const b = frame.pixels[i * 4 + 2] ?? 0;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      pixels += 1;
      if ((i + 1) % frame.width !== 0) detail += Math.abs((plane[i] ?? 0) - (plane[i + 1] ?? 0));
      if ((plane[i] ?? 0) < 0.08 || max === 0) continue;
      lit += 1;
      const s = (max - min) / max;
      saturation += s;
      if (max === min) continue;
      const delta = max - min;
      const sector = max === r ? ((g - b) / delta + 6) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
      const angle = (sector / 6) * 2 * Math.PI;
      hueX += s * Math.cos(angle);
      hueY += s * Math.sin(angle);
    }
  }
  const pairs = [0, 2, 4];
  const means = planes.map(meanOf);
  return {
    name,
    luma: means.reduce((sum, v) => sum + v, 0) / means.length,
    coverage: lit / pixels,
    saturation: lit === 0 ? 0 : saturation / lit,
    hue: ((Math.atan2(hueY, hueX) * 180) / Math.PI + 360) % 360,
    motion: pairs.reduce((sum, i) => sum + difference(planes[i] as Float32Array, planes[i + 1] as Float32Array), 0) / pairs.length,
    change: difference(planes[0] as Float32Array, planes[4] as Float32Array),
    flicker: Math.max(...pairs.map((i) => Math.abs((means[i] ?? 0) - (means[i + 1] ?? 0)))),
    detail: detail / pixels,
  };
}

function project(preset: string): RenderProject {
  return {
    schemaVersion: 0,
    seed: 1,
    durationTicks: 48_000 * SECONDS,
    canvas: { width: 320, height: 180, fps: rational(30), background: '#000000' },
    audio: { leadInTicks: 0, clipInTicks: 0 },
    layers: [{ id: 'm', module: 'core.visualizer.milkdrop', enabled: true, opacity: 1, blend: 'normal', params: { preset } }],
  };
}

function usable(m: Measured): boolean {
  return m.failed === undefined
    && (m.luma ?? 0) >= MIN_LUMA && (m.coverage ?? 0) >= MIN_COVERAGE && (m.change ?? 0) >= MIN_CHANGE
    && (m.flicker ?? 1) <= MAX_FLICKER && (m.detail ?? 0) >= MIN_DETAIL;
}

function readResults(): Map<string, Measured> {
  if (!existsSync(RESULTS)) return new Map();
  return new Map((JSON.parse(readFileSync(RESULTS, 'utf8')) as Measured[]).map((m) => [m.name, m]));
}

async function run(): Promise<void> {
  const names = (JSON.parse(readFileSync(join(MILKDROP_JS_DIR, 'index.json'), 'utf8')) as { name: string }[]).map((p) => p.name);
  const results = readResults();
  const queue = names.filter((name) => !results.has(name));
  console.log(`${names.length} presets, ${queue.length} to measure`);
  const pcm = synthesizeTestTrack(SECONDS);
  const analysed = analyzeMix(pcm);
  const analysis = { mix: analysed.analysis.sources.get('mix')!, beatGrid: analysed.beatGrid };
  await bundleElectron();
  mkdirSync(dirname(RESULTS), { recursive: true });
  const save = () => writeFileSync(RESULTS, JSON.stringify([...results.values()]));
  const worker = async (slot: number) => {
    for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
      try {
        const run = await renderFrames({ name: `md-measure-${slot}`, project: project(name), frames: FRAMES, pcm, analysis });
        const warning = run.warnings[0];
        results.set(name, warning === undefined ? measure(name, run.frames) : { name, failed: warning });
      } catch (error) {
        results.set(name, { name, failed: (error as Error).message.split('\n')[0] ?? 'failed' });
      }
      if (results.size % 25 === 0) {
        save();
        console.log(`${results.size} of ${names.length}`);
      }
    }
  };
  await Promise.all(Array.from({ length: WORKERS }, (_, slot) => worker(slot)));
  save();
  console.log('Measured. `npm run milkdrop:measure -- --write` makes the catalogue.');
}

const three = (value: number | undefined) => Math.round((value ?? 0) * 1000) / 1000;

function writeCatalogue(): void {
  const results = [...readResults().values()];
  const kept = results.filter(usable).sort((a, b) => (a.name < b.name ? -1 : 1));
  const rows = kept.map((m) => `  [${JSON.stringify(m.name)}, ${three(m.luma)}, ${three(m.coverage)}, ${three(m.saturation)}, ${Math.round(m.hue ?? 0)}, ${three(m.motion)}],`);
  writeFileSync(CATALOGUE, `// Generated by \`npm run milkdrop:measure -- --write\` (scripts/measure-milkdrop.ts); do not edit.
// What each usable MilkDrop preset looks like, measured from a render: ${kept.length} of the ${results.length} presets. The rest
// were black, frozen, strobing, flat or would not run.
// Name, mean luma, share of the frame lit, saturation, hue in degrees, motion between frames.

export const MILKDROP_MEASURES: readonly (readonly [string, number, number, number, number, number])[] = [
${rows.join('\n')}
];
`);
  const reasons = { failed: 0, dark: 0, frozen: 0, strobing: 0, flat: 0 };
  for (const m of results) {
    if (m.failed !== undefined) reasons.failed += 1;
    else if ((m.luma ?? 0) < MIN_LUMA || (m.coverage ?? 0) < MIN_COVERAGE) reasons.dark += 1;
    else if ((m.change ?? 0) < MIN_CHANGE) reasons.frozen += 1;
    else if ((m.flicker ?? 1) > MAX_FLICKER) reasons.strobing += 1;
    else if ((m.detail ?? 0) < MIN_DETAIL) reasons.flat += 1;
  }
  console.log(`${kept.length} of ${results.length} kept`, reasons);
}

if (process.argv.includes('--write')) writeCatalogue();
else await run();
