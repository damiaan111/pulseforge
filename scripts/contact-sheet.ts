// `npm run contact-sheet -- <folder>` — the auto-director's contact sheet (auto-director-spec §10.4, §12).
//
// "Run the template across a folder of varied tracks and render a contact sheet of stills at fixed
// timestamps. This is the only reliable way to see whether a template generalises or was secretly
// tuned to one song." Every track × every template (or the ones named), one still each at the
// track's loudest moment, into out/contact-sheet/: a PNG per tile and index.html, a grid with each
// tile's summary and the director's reading of the track. Problems are obvious at a glance in a grid
// and invisible one track at a time.
//
// The tracks are read in place and nothing is written beside them. Analysis goes through its own
// cache under cache/, so a second run over the same folder skips straight to rendering.
//
// Usage:
//   npm run contact-sheet -- <folder> [--templates id,id] [--seed N] [--width 320] [--limit N]

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';

import { FFMPEG_EXE, ROOT } from '../setup/lib/paths.ts';
import { bundleElectron } from '../spike/harness.ts';
import { renderFrames } from '../spike/lib/frames-run.ts';
import { AnalysisCache } from '../src/analysis/cache.ts';
import { analyzeCached } from '../src/analysis/cached.ts';
import { decodeMono48k } from '../src/analysis/decode.ts';
import { direct } from '../src/director/direct.ts';
import { buildTrackDigest, describeStyle, styleVector } from '../src/director/digest.ts';
import { loadTemplates } from '../src/director/template-library.ts';
import { readTemplateFiles } from '../src/director/template-store.ts';
import { BUILTIN_MODULES } from '../src/engine/engine.ts';
import { sourceToTimelineSeconds } from '../src/engine/core/time.ts';
import { createDocument } from '../src/project/create.ts';
import { toRenderProject } from '../src/project/snapshot.ts';

const AUDIO = new Set(['.wav', '.mp3', '.flac', '.m4a', '.ogg', '.opus', '.aac', '.aiff']);

interface Args {
  readonly folder: string;
  readonly templates: readonly string[] | null;
  readonly seed: number;
  readonly width: number;
  readonly limit: number;
}

function parseArgs(argv: readonly string[]): Args {
  let folder: string | undefined;
  let templates: string[] | null = null;
  let seed = 1;
  let width = 320;
  let limit = Infinity;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const next = () => argv[++i] ?? '';
    if (arg === '--templates') templates = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--seed') seed = Number(next());
    else if (arg === '--width') width = Math.max(64, Math.round(Number(next()) / 2) * 2);
    else if (arg === '--limit') limit = Number(next());
    else if (!arg.startsWith('--')) folder = arg;
    else throw new Error(`Unknown option ${arg}`);
  }
  if (folder === undefined) throw new Error('Usage: npm run contact-sheet -- <folder of tracks> [--templates id,id] [--seed N] [--width 320] [--limit N]');
  return { folder: resolve(folder), templates, seed, width, limit };
}

async function writePng(raw: Uint8Array, width: number, height: number, path: string, scratch: string): Promise<void> {
  const rawPath = join(scratch, 'tile.rgba');
  await writeFile(rawPath, raw);
  await new Promise<void>((done, fail) => {
    const child = spawn(FFMPEG_EXE, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-i', rawPath, '-frames:v', '1', path], { windowsHide: true });
    child.on('close', (code) => (code === 0 ? done() : fail(new Error(`ffmpeg exited ${code} writing ${path}`))));
    child.on('error', fail);
  });
  await rm(rawPath, { force: true });
}

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(FFMPEG_EXE)) throw new Error('The vendored FFmpeg is missing — run `npm run setup`.');
  const out = join(ROOT, 'out', 'contact-sheet');
  const scratch = join(ROOT, 'out', 'contact-sheet-scratch');
  await mkdir(out, { recursive: true });
  await mkdir(scratch, { recursive: true });

  const library = loadTemplates(await readTemplateFiles({ builtin: join(ROOT, 'templates', 'builtin'), user: join(ROOT, 'out', 'no-user-templates') }));
  for (const p of library.problems) console.warn(`template problem: ${p.path}: ${p.message}`);
  const templates = library.templates.map((t) => t.template).filter((t) => args.templates === null || args.templates.includes(t.id));
  if (templates.length === 0) throw new Error(`No templates match ${args.templates?.join(', ') ?? ''}.`);

  const tracks = (await readdir(args.folder)).filter((f) => AUDIO.has(extname(f).toLowerCase())).sort().slice(0, args.limit);
  if (tracks.length === 0) throw new Error(`No audio files in ${args.folder}.`);
  console.log(`${tracks.length} track(s) × ${templates.length} template(s)`);

  await bundleElectron();
  const cache = new AnalysisCache({ root: join(ROOT, 'cache', 'contact-sheet-analysis') });
  const modules = { get: (id: string) => BUILTIN_MODULES.find((m) => m.manifest.id === id)?.manifest, all: BUILTIN_MODULES.map((m) => m.manifest) };
  const rows: string[] = [];

  for (const [t, file] of tracks.entries()) {
    const path = join(args.folder, file);
    const started = performance.now();
    const decoded = await decodeMono48k(FFMPEG_EXE, path);
    const result = await analyzeCached(decoded.pcm, cache, { audioHash: decoded.pcmSha256 });
    const durationSeconds = decoded.pcm.length / 48_000;
    const digest = buildTrackDigest({ analysis: result.analysis, durationSeconds, onsetTimes: result.onsetTimes, sections: result.sections });
    const style = styleVector(digest);
    const name = basename(file, extname(file));
    const document = createDocument({ name, id: '0000000000C000000000000001', timestamp: '2026-01-01T00:00:00.000Z', canvas: { width: args.width, height: Math.round((args.width * 9) / 16 / 2) * 2 } });
    const withAudio = { ...document, audio: { ...document.audio, path, durationTicks: decoded.pcm.length } };
    const loudest = [...result.sections].sort((a, b) => b.energy - a.energy)[0];
    const moment = loudest === undefined ? durationSeconds * 0.4 : (loudest.startSeconds + loudest.endSeconds) / 2;
    const frame = Math.floor(sourceToTimelineSeconds(moment, { leadInTicks: 0, clipInTicks: 0 }) * 60);
    const mix = result.analysis.sources.get('mix');
    if (mix === undefined) throw new Error(`${file}: the analysis has no mix`);

    const cells: string[] = [];
    for (const template of templates) {
      const directed = direct({
        document: withAudio, templates, modules, digest, style, analysis: result.analysis,
        beats: result.beatGrid?.beats ?? [], onsets: result.onsetTimes, vocalSegments: [], title: name,
      }, { seed: args.seed, templateId: template.id });
      const { project } = toRenderProject(directed.document);
      const frames = await renderFrames({ name: `contact-${t}-${template.id}`, project, frames: [frame], pcm: decoded.pcm, analysis: { mix, beatGrid: result.beatGrid } });
      const still = frames.frames[0];
      const tile = `${String(t).padStart(2, '0')}-${template.id}.png`;
      if (still !== undefined) await writePng(still.pixels, still.width, still.height, join(out, tile), scratch);
      const guardrails = directed.log.filter((e) => e.step === 'guardrail').map((e) => e.text);
      cells.push(`<td><img src="${tile}" width="${args.width}" alt=""><div class="s">${escape(directed.roll.summary)}</div>${guardrails.length > 0 ? `<div class="g" title="${escape(guardrails.join('\n'))}">${guardrails.length} guardrail(s)</div>` : ''}${frames.warnings.length > 0 ? `<div class="w" title="${escape(frames.warnings.join('\n'))}">${frames.warnings.length} warning(s)</div>` : ''}</td>`);
    }
    const ranked = direct({
      document: withAudio, templates, modules, digest, style, analysis: result.analysis,
      beats: result.beatGrid?.beats ?? [], onsets: result.onsetTimes, vocalSegments: [], title: name,
    }, { seed: args.seed }).template.name;
    rows.push(`<tr><th><b>${escape(name)}</b><br>${escape(describeStyle(style))}<br>${Math.round(digest.bpm)} BPM · ${result.sections.length} sections<br>best match: <b>${escape(ranked)}</b></th>${cells.join('')}</tr>`);
    console.log(`${file}: ${((performance.now() - started) / 1000).toFixed(1)} s`);
  }

  const html = `<!doctype html><meta charset="utf-8"><title>Contact sheet</title>
<style>body{background:#111;color:#ddd;font:12px system-ui;margin:16px}table{border-collapse:collapse}th,td{padding:6px;vertical-align:top;border:1px solid #333}th{text-align:left;width:220px;font-weight:400}img{display:block}.s{margin-top:4px}.g{color:#ffb020}.w{color:#ff6060}</style>
<h1>Auto-director contact sheet</h1><p>Seed ${args.seed}; one still per track and template, at the middle of the loudest section.</p>
<table><tr><th></th>${templates.map((t) => `<th>${escape(t.name)}</th>`).join('')}</tr>${rows.join('\n')}</table>`;
  await writeFile(join(out, 'index.html'), html);
  await rm(scratch, { recursive: true, force: true });
  console.log(`Wrote ${join(out, 'index.html')}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
