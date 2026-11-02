// Builds and runs the desktop app. `npm run build` bundles, `npm run dev` bundles and launches.
//
// Three bundles, because they run in three different places with three different privileges:
//
//   dist/app/main.js        Electron main — Node, full privileges, ESM
//   dist/app/preload.cjs    the bridge — sandboxed, must be CommonJS (a sandboxed preload has
//                           no ESM loader), and is the only code that sees both sides
//   dist/app/renderer/      the page — browser only, no Node built-ins at all
//   dist/app/render-host/   the export renderer (spike/electron), built here so an installed app
//                           never needs esbuild; dist/app/boot.mjs starts it or the studio
//
// The renderer bundle is built with `platform: 'browser'` deliberately: if UI code ever imports
// `node:fs`, this build fails rather than producing a bundle that would break at runtime inside
// the sandbox. That is a second enforcement of the boundary, alongside the ESLint rule.

import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build, context, type BuildOptions } from 'esbuild';
import electronPath from 'electron';
import { ROOT } from '../setup/lib/paths.ts';

const OUT = join(ROOT, 'dist', 'app');
const RENDERER_OUT = join(OUT, 'renderer');
const HOST_OUT = join(OUT, 'render-host');

/**
 * The installed app's entry (package.json `main`). An installed Electron app always starts its own
 * code, whatever script it is handed, so the render host is asked for with a switch instead.
 */
const BOOT = `// Built by scripts/app.ts. The studio, or with --pulseforge-render-host the export renderer.
if (process.argv.includes('--pulseforge-render-host')) await import('./render-host/main.cjs');
else await import('./main.js');
`;

/** What a bundle may import at runtime: Node's own modules and Electron. Anything else is not installed. */
async function assertSelfContained(file: string): Promise<void> {
  const text = await readFile(file, 'utf8');
  const outside = [...text.matchAll(/^\s*import\s+(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/gm)]
    .map((match) => match[1] ?? '')
    .filter((name) => !name.startsWith('node:') && !name.startsWith('.') && name !== 'electron');
  const required = [...text.matchAll(/require\(["']([^"']+)["']\)/g)].map((match) => match[1] ?? '')
    .filter((name) => !name.startsWith('node:') && !name.startsWith('.') && name !== 'electron' && !NODE_BUILTINS.has(name));
  const missing = [...new Set([...outside, ...required])];
  if (missing.length > 0) throw new Error(`${file} loads ${missing.join(', ')} at runtime, which the installer does not ship. Bundle it, or load it only from source.`);
}
const NODE_BUILTINS = new Set(['assert', 'buffer', 'child_process', 'crypto', 'events', 'fs', 'module', 'os', 'path', 'process', 'stream', 'url', 'util', 'worker_threads', 'zlib']);

const shared: BuildOptions = {
  bundle: true,
  sourcemap: 'linked',
  logLevel: 'info',
  target: 'node22',
};

async function bundle(watch: boolean): Promise<void> {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(RENDERER_OUT, { recursive: true });

  const builds: BuildOptions[] = [
    {
      ...shared,
      entryPoints: [join(ROOT, 'src', 'shell', 'main.ts')],
      outfile: join(OUT, 'main.js'),
      platform: 'node',
      format: 'esm',
      // Electron is provided by the runtime, not bundled. esbuild ships a native binary and
      // cannot be bundled either: the render queue uses it at runtime to build the render host.
      external: ['electron', 'esbuild'],
      // esbuild emits ESM that uses import.meta; main.ts relies on import.meta.dirname.
      banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    },
    {
      ...shared,
      entryPoints: [join(ROOT, 'src', 'shell', 'preload.ts')],
      outfile: join(OUT, 'preload.cjs'),
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
    },
    {
      ...shared,
      entryPoints: [join(ROOT, 'src', 'ui', 'main.tsx')],
      outfile: join(RENDERER_OUT, 'main.js'),
      // Browser, with no Node shims: an accidental `node:fs` import in UI code fails here.
      platform: 'browser',
      format: 'esm',
      target: 'chrome130',
      jsx: 'automatic',
    },
    // The export renderer, as spike/harness.ts bundles it from source.
    ...(['main', 'renderer'] as const).map((name): BuildOptions => ({
      ...shared,
      entryPoints: [join(ROOT, 'spike', 'electron', `${name}.ts`)],
      outfile: join(HOST_OUT, name === 'main' ? 'main.cjs' : 'renderer.js'),
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
    })),
  ];

  const copyStatic = async () => {
    await copyFile(join(ROOT, 'src', 'ui', 'index.html'), join(RENDERER_OUT, 'index.html'));
    await copyFile(join(ROOT, 'src', 'ui', 'styles.css'), join(RENDERER_OUT, 'styles.css'));
    await mkdir(HOST_OUT, { recursive: true });
    await writeFile(join(HOST_OUT, 'index.html'), '<!doctype html><meta charset="utf-8"><title>pulseforge render</title><script src="renderer.js"></script>\n');
    await writeFile(join(OUT, 'boot.mjs'), BOOT);
  };

  if (!watch) {
    await Promise.all(builds.map((options) => build(options)));
    await copyStatic();
    // An installed app has no node_modules: a bundle that reaches for a package would crash on start.
    await Promise.all([join(OUT, 'main.js'), join(OUT, 'preload.cjs'), join(HOST_OUT, 'main.cjs'), join(HOST_OUT, 'renderer.js')].map(assertSelfContained));
    return;
  }

  const contexts = await Promise.all(builds.map((options) => context(options)));
  await Promise.all(contexts.map((c) => c.watch()));
  await copyStatic();
}

function launch(smoke: boolean, forwarded: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(electronPath as unknown as string, [join(OUT, 'main.js'), ...forwarded], {
      stdio: 'inherit',
      windowsHide: false,
      env: {
        ...process.env,
        ELECTRON_ENABLE_LOGGING: '1',
        ...(smoke ? { PULSEFORGE_SMOKE: '1' } : {}),
      },
    });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 0));
  });
}

const args = process.argv.slice(2);
const smoke = args.includes('--smoke');
// Anything that is not one of our own switches goes to the app, so `npm run dev -- song.pvproj`
// opens that project the way a double-click will once the file type is associated.
const forwarded = args.filter((arg) => arg !== '--dev' && arg !== '--smoke');
// --smoke launches once and exits; it has no reason to sit in a watch loop.
const dev = args.includes('--dev') && !smoke;

await bundle(dev);
if (dev || smoke) {
  process.exit(await launch(smoke, forwarded));
} else {
  console.log(`Built to ${OUT}`);
}
