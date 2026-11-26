import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MILKDROP_PRESETS } from '../manifest.ts';
import { installArchive, isInstalled } from '../lib/archive.ts';
import { ensureDownloaded, sha256File } from '../lib/download.ts';
import { SetupError } from '../lib/errors.ts';
import { upsertArtefact } from '../lib/lockfile.ts';
import { formatBytes } from '../lib/log.ts';
import { DOWNLOADS, MILKDROP_JS_DIR, VENDOR } from '../lib/paths.ts';
import type { Step, StepContext } from './types.ts';

// The MilkDrop preset library, as an optional component. The package holds presets as JSON whose
// equations are strings, which Butterchurn compiles with `new Function`. The studio's content
// security policy forbids that, so each preset is written out here as a plain script with those
// equations as real functions: Butterchurn sees them compiled and skips the step, and the policy
// stays strict. The scripts come only from this pinned package.

const TITLE = 'MilkDrop presets (Butterchurn)';

interface PresetJson {
  readonly init_eqs_str?: string;
  readonly frame_eqs_str?: string;
  readonly pixel_eqs_str?: string;
  readonly shapes?: readonly (Record<string, unknown>)[];
  readonly waves?: readonly (Record<string, unknown>)[];
  readonly [key: string]: unknown;
}

const fn = (body: unknown) => `function(a){${typeof body === 'string' ? body : ''}\nreturn a;}`;

function withoutStrings(item: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(item).filter(([key]) => !key.endsWith('_eqs_str'))));
}

/** One preset as a script. Every shape and wave gets functions, enabled or not: unused ones cost nothing. */
export function presetScript(name: string, preset: PresetJson): string {
  const shapes = (preset.shapes ?? []).map((shape) => `Object.assign(${withoutStrings(shape)},{init_eqs:${fn(shape['init_eqs_str'])},frame_eqs:${fn(shape['frame_eqs_str'])}})`);
  const waves = (preset.waves ?? []).map((wave) => {
    const point = wave['point_eqs_str'];
    return `Object.assign(${withoutStrings(wave)},{init_eqs:${fn(wave['init_eqs_str'])},frame_eqs:${fn(wave['frame_eqs_str'])},point_eqs:${typeof point === 'string' && point !== '' ? fn(point) : '""'}})`;
  });
  const { shapes: _shapes, waves: _waves, ...rest } = preset;
  const pixel = preset.pixel_eqs_str;
  return `(globalThis.__pfMilkdrop??={})[${JSON.stringify(name)}]=Object.assign(${withoutStrings(rest)},{`
    + `init_eqs:${fn(preset.init_eqs_str)},frame_eqs:${fn(preset.frame_eqs_str)},pixel_eqs:${typeof pixel === 'string' && pixel !== '' ? fn(pixel) : '""'},`
    + `shapes:[${shapes.join(',')}],waves:[${waves.join(',')}]});\n`;
}

async function generate(ctx: StepContext): Promise<number> {
  const source = join(VENDOR, MILKDROP_PRESETS.installDir, 'presets', 'converted');
  await rm(MILKDROP_JS_DIR, { recursive: true, force: true });
  await mkdir(MILKDROP_JS_DIR, { recursive: true });
  const index: { name: string; file: string }[] = [];
  const skipped: string[] = [];
  for (const entry of (await readdir(source)).sort()) {
    if (!entry.endsWith('.json')) continue;
    const name = entry.slice(0, -'.json'.length);
    try {
      const script = presetScript(name, JSON.parse(await readFile(join(source, entry), 'utf8')) as PresetJson);
      // Parsed, not run: a preset that does not compile is left out here, not found in a render.
      new Function(script);
      const file = `${createHash('sha256').update(name).digest('hex').slice(0, 16)}.js`;
      await writeFile(join(MILKDROP_JS_DIR, file), script);
      index.push({ name, file });
    } catch {
      skipped.push(name);
    }
  }
  await writeFile(join(MILKDROP_JS_DIR, 'index.json'), `${JSON.stringify(index)}\n`);
  if (skipped.length > 0) ctx.log.warn(`${skipped.length} preset(s) would not compile and were left out: ${skipped.slice(0, 5).join(', ')}`);
  return index.length;
}

export const milkdropStep: Step = {
  id: 'milkdrop',
  title: TITLE,
  tier: 'milkdrop',

  async describe() {
    const installed = existsSync(join(MILKDROP_JS_DIR, 'index.json'));
    return {
      name: 'MilkDrop presets',
      version: MILKDROP_PRESETS.version,
      download: installed ? 'already downloaded' : formatBytes(MILKDROP_PRESETS.sizeBytes),
      source: MILKDROP_PRESETS.url,
      destination: 'vendor/milkdrop/',
      status: installed ? 'installed' : 'not installed',
    };
  },

  async run(ctx) {
    ctx.log.heading(TITLE);
    const archive = join(DOWNLOADS, MILKDROP_PRESETS.fileName);
    const result = await ensureDownloaded(
      {
        step: TITLE,
        label: MILKDROP_PRESETS.name,
        url: MILKDROP_PRESETS.url,
        dest: archive,
        sha256: MILKDROP_PRESETS.sha256,
        expectedSize: MILKDROP_PRESETS.sizeBytes,
        ...(ctx.fromDir !== undefined ? { fromDir: ctx.fromDir } : {}),
      },
      ctx.log,
    );
    if (!(await isInstalled(MILKDROP_PRESETS))) await installArchive(archive, MILKDROP_PRESETS, TITLE, ctx.log);
    upsertArtefact(ctx.lock, {
      id: MILKDROP_PRESETS.id,
      name: MILKDROP_PRESETS.name,
      version: MILKDROP_PRESETS.version,
      url: MILKDROP_PRESETS.url,
      fileName: MILKDROP_PRESETS.fileName,
      sha256: result.sha256,
      sizeBytes: result.bytes,
      license: MILKDROP_PRESETS.license,
      installPath: `${MILKDROP_PRESETS.installDir}/`,
    });
    ctx.log.ok(`${await generate(ctx)} presets ready`);
  },

  async verify(ctx) {
    ctx.log.heading(`Verify: ${TITLE}`);
    const archive = join(DOWNLOADS, MILKDROP_PRESETS.fileName);
    if (!existsSync(join(MILKDROP_JS_DIR, 'index.json')) || !existsSync(archive)) {
      throw new SetupError({ step: TITLE, what: 'The MilkDrop presets are not installed.', fix: ['Add them in Settings → Components, or run `npm run setup -- --components milkdrop`.'] });
    }
    if ((await sha256File(archive)) !== MILKDROP_PRESETS.sha256) {
      throw new SetupError({ step: TITLE, what: `${MILKDROP_PRESETS.fileName} no longer matches its pinned SHA-256.`, fix: [`Delete ${archive} and run setup again.`] });
    }
    ctx.log.ok('The preset package matches its pinned hash');
  },
};
