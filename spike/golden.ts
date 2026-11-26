// `npm run golden` — re-render the golden set and compare against the committed references
// (export-spec §16, PROJECT.md §14).
//
// This is the test that makes the determinism contract real rather than aspirational: it runs
// whole project *documents* through the actual path — load → migrate → parse → toRenderProject
// → engine → compositor → readback — at several canvas shapes, and compares pixels.
//
// Two tolerance policies, as the spec sets out:
//   - a hash match is a pass, full stop. That is the determinism contract on this machine.
//   - a hash mismatch is measured (SSIM, max channel delta). Within the cross-machine budget it
//     is reported as a warning and named as such, because a different GPU rounds filtering
//     differently; beyond it, it is a failure.
//
// References are generated and committed **on the RTX machine**. `--update` rewrites them, and
// the diff should be read before committing: that diff is the record of what a change did to
// every project's appearance.
//
// Usage: npm run golden [-- --update] [-- --only neon-bars]

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { ROOT, FFMPEG_EXE } from '../setup/lib/paths.ts';
import type { RenderProject } from '../src/engine/core/project.ts';
import { ENGINE_VERSION } from '../src/engine/engine.ts';
import { loadDocument } from '../src/project/load.ts';
import { toRenderProject } from '../src/project/snapshot.ts';
import { bundleElectron, fail } from './harness.ts';
import { compareFrames, withinCrossMachineBudget } from './lib/compare.ts';
import { renderFrames, type RenderedFrame } from './lib/frames-run.ts';

const GOLDEN_DIR = join(ROOT, 'tests', 'golden');
const REFERENCE_DIR = join(GOLDEN_DIR, 'references');
const MANIFEST = join(REFERENCE_DIR, 'manifest.json');
const SCRATCH = join(ROOT, 'out', 'golden');

interface CanvasEntry {
  readonly aspect: string;
  readonly width: number;
  readonly height: number;
}

interface GoldenEntry {
  readonly name: string;
  readonly project: string;
  readonly canvases: readonly CanvasEntry[];
  readonly frames: readonly number[];
}

interface ReferenceRecord {
  readonly key: string;
  readonly width: number;
  readonly height: number;
  readonly sha256: string;
  /** Notes `toRenderProject` produced — a change here is as meaningful as a pixel change. */
  readonly notes: readonly string[];
}

interface Manifest {
  readonly engineVersion: string;
  readonly generatedOn: string;
  readonly records: readonly ReferenceRecord[];
}

const key = (entry: GoldenEntry, canvas: CanvasEntry, frame: number) =>
  `${entry.name}-${canvas.aspect.replace(':', 'x')}-${String(frame).padStart(5, '0')}`;

/**
 * Writes a PNG beside the hash, so a failure can be looked at rather than only measured.
 * The raw frame goes to a scratch file under `out/` — never next to the references, where it
 * would be a hundred times the size of the PNG and would end up committed.
 */
async function writePng(raw: Uint8Array, width: number, height: number, path: string): Promise<boolean> {
  if (!existsSync(FFMPEG_EXE)) return false;
  await mkdir(dirname(path), { recursive: true });
  await mkdir(SCRATCH, { recursive: true });
  const rawPath = join(SCRATCH, 'frame.rgba');
  await writeFile(rawPath, raw);
  const ok = await new Promise<boolean>((done) => {
    const child = spawn(FFMPEG_EXE, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-i', rawPath,
      '-frames:v', '1', path,
    ], { windowsHide: true });
    child.on('close', (code) => done(code === 0));
    child.on('error', () => done(false));
  });
  await rm(rawPath, { force: true });
  return ok;
}

/** A stale "actual" from an earlier failing run would be read as current evidence. */
async function clearActual(id: string): Promise<void> {
  await rm(join(REFERENCE_DIR, `${id}.actual.png`), { force: true });
}

async function readPng(path: string): Promise<Uint8Array | undefined> {
  if (!existsSync(FFMPEG_EXE) || !existsSync(path)) return undefined;
  return new Promise((done) => {
    const child = spawn(FFMPEG_EXE, ['-hide_banner', '-loglevel', 'error', '-i', path, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.on('close', (code) => done(code === 0 ? new Uint8Array(Buffer.concat(chunks)) : undefined));
    child.on('error', () => done(undefined));
  });
}

async function loadGoldens(): Promise<readonly GoldenEntry[]> {
  const text = await readFile(join(GOLDEN_DIR, 'goldens.json'), 'utf8');
  return (JSON.parse(text) as { entries: GoldenEntry[] }).entries;
}

/** One project document at one canvas shape, ready for the engine. */
async function projectFor(entry: GoldenEntry, canvas: CanvasEntry): Promise<{ project: RenderProject; notes: string[] }> {
  const path = resolve(GOLDEN_DIR, entry.project);
  const { document, issues } = loadDocument(await readFile(path, 'utf8'));
  if (issues.length > 0) {
    // A golden project with parse issues is a broken fixture, and would quietly change the
    // reference next time someone regenerated it.
    fail(`${entry.name}: ${path} has ${issues.length} parse issue(s)`, issues.map((i) => `${i.path}: ${i.detail}`));
  }
  const resized = { ...document, canvas: { ...document.canvas, width: canvas.width, height: canvas.height } };
  const snapshot = toRenderProject(resized);
  return { project: snapshot.project, notes: snapshot.notes.map((n) => `${n.path}: ${n.detail}`) };
}

interface Outcome {
  readonly key: string;
  readonly status: 'match' | 'new' | 'near' | 'differ' | 'notes-changed';
  readonly detail: string;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const update = args.includes('--update');
  const onlyIndex = args.indexOf('--only');
  const only = onlyIndex >= 0 ? args[onlyIndex + 1] : undefined;

  const entries = (await loadGoldens()).filter((e) => only === undefined || e.name === only);
  if (entries.length === 0) fail(`No golden entries matched --only ${only ?? ''}`, ['Check the names in tests/golden/goldens.json']);

  const previous: Manifest | undefined = existsSync(MANIFEST)
    ? (JSON.parse(await readFile(MANIFEST, 'utf8')) as Manifest)
    : undefined;
  const byKey = new Map((previous?.records ?? []).map((r) => [r.key, r]));

  console.log('▶ Bundling spike harness');
  await bundleElectron();
  await mkdir(REFERENCE_DIR, { recursive: true });

  const records: ReferenceRecord[] = [];
  const outcomes: Outcome[] = [];

  for (const entry of entries) {
    for (const canvas of entry.canvases) {
      const { project, notes } = await projectFor(entry, canvas);
      console.log(`▶ ${entry.name} @ ${canvas.aspect} (${canvas.width}×${canvas.height}), frames ${entry.frames.join(', ')}`);
      const run = await renderFrames({
        name: `golden-${entry.name}-${canvas.aspect.replace(':', 'x')}`,
        project,
        frames: entry.frames,
      });
      for (const warning of run.warnings) console.log(`    warning: ${warning}`);

      for (const frame of run.frames as readonly RenderedFrame[]) {
        const id = key(entry, canvas, frame.frameIndex);
        const record: ReferenceRecord = {
          key: id,
          width: frame.width,
          height: frame.height,
          sha256: frame.sha256,
          notes,
        };
        records.push(record);
        const png = join(REFERENCE_DIR, `${id}.png`);
        const reference = byKey.get(id);

        if (update) {
          await clearActual(id);
          await writePng(frame.pixels, frame.width, frame.height, png);
          outcomes.push({ key: id, status: reference === undefined ? 'new' : reference.sha256 === frame.sha256 ? 'match' : 'differ', detail: 'written' });
          continue;
        }

        if (reference === undefined) {
          await writePng(frame.pixels, frame.width, frame.height, join(REFERENCE_DIR, `${id}.actual.png`));
          outcomes.push({ key: id, status: 'new', detail: 'no reference committed — run with --update' });
          continue;
        }
        if (reference.sha256 === frame.sha256) {
          await clearActual(id);
          const notesChanged = reference.notes.join('\n') !== notes.join('\n');
          outcomes.push(notesChanged
            ? { key: id, status: 'notes-changed', detail: `pixels identical, but the snapshot notes changed:\n      was: ${reference.notes.join(' | ') || '(none)'}\n      now: ${notes.join(' | ') || '(none)'}` }
            : { key: id, status: 'match', detail: '' });
          continue;
        }

        // Hash mismatch: say how different, not just that it is.
        await writePng(frame.pixels, frame.width, frame.height, join(REFERENCE_DIR, `${id}.actual.png`));
        const referencePixels = await readPng(png);
        if (referencePixels === undefined || referencePixels.length !== frame.pixels.length) {
          outcomes.push({ key: id, status: 'differ', detail: 'hash mismatch; the reference PNG could not be read for a perceptual comparison' });
          continue;
        }
        const difference = compareFrames(frame.pixels, referencePixels, frame.width, frame.height);
        const measured = `SSIM ${difference.ssim.toFixed(5)}, max Δ ${difference.maxChannelDelta}, MAE ${difference.meanAbsoluteError.toFixed(3)}, ${(difference.changedPixels * 100).toFixed(2)}% of pixels changed`;
        outcomes.push(withinCrossMachineBudget(difference)
          ? { key: id, status: 'near', detail: `${measured} — within the cross-machine budget, so this is a different GPU or driver, not a regression` }
          : { key: id, status: 'differ', detail: measured });
      }
    }
  }

  if (update) {
    // With --only, the entries that were not re-rendered keep their references: rewriting the
    // manifest from this run alone would silently drop every other entry's.
    const rendered = new Set(records.map((r) => r.key));
    const kept = only === undefined ? [] : (previous?.records ?? []).filter((r) => !rendered.has(r.key));
    const manifest: Manifest = { engineVersion: ENGINE_VERSION, generatedOn: new Date().toISOString(), records: [...kept, ...records] };
    await writeFile(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  const counts = { match: 0, near: 0, differ: 0, new: 0, 'notes-changed': 0 };
  console.log('\n================ Pulseforge — golden frames ================');
  for (const outcome of outcomes) {
    counts[outcome.status] += 1;
    const mark = { match: '  ok  ', near: ' near ', differ: ' FAIL ', new: ' new  ', 'notes-changed': ' note ' }[outcome.status];
    console.log(`${mark} ${outcome.key}${outcome.detail === '' ? '' : `  ${outcome.detail}`}`);
  }
  console.log('------------------------------------------------------------');
  console.log(`Engine ${ENGINE_VERSION}${previous === undefined ? '' : ` · references from ${previous.engineVersion}, ${previous.generatedOn}`}`);
  console.log(`${counts.match} identical · ${counts.near} near · ${counts.differ} differing · ${counts.new} new · ${counts['notes-changed']} note-only`);
  if (update) console.log('References rewritten. Read the diff before committing it.');
  console.log('============================================================');

  const failed = counts.differ > 0 || (!update && (counts.new > 0 || counts['notes-changed'] > 0));
  process.exit(failed ? 1 : 0);
}

await main();
