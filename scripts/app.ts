// Builds and runs the desktop app. `npm run build` bundles, `npm run dev` bundles and launches.
//
// Three bundles, because they run in three different places with three different privileges:
//
//   dist/app/main.js        Electron main — Node, full privileges, ESM
//   dist/app/preload.cjs    the bridge — sandboxed, must be CommonJS (a sandboxed preload has
//                           no ESM loader), and is the only code that sees both sides
//   dist/app/renderer/      the page — browser only, no Node built-ins at all
//
// The renderer bundle is built with `platform: 'browser'` deliberately: if UI code ever imports
// `node:fs`, this build fails rather than producing a bundle that would break at runtime inside
// the sandbox. That is a second enforcement of the boundary, alongside the ESLint rule.

import { spawn } from 'node:child_process';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { build, context, type BuildOptions } from 'esbuild';
import electronPath from 'electron';
import { ROOT } from '../setup/lib/paths.ts';

const OUT = join(ROOT, 'dist', 'app');
const RENDERER_OUT = join(OUT, 'renderer');

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
  ];

  const copyStatic = async () => {
    await copyFile(join(ROOT, 'src', 'ui', 'index.html'), join(RENDERER_OUT, 'index.html'));
    await copyFile(join(ROOT, 'src', 'ui', 'styles.css'), join(RENDERER_OUT, 'styles.css'));
  };

  if (!watch) {
    await Promise.all(builds.map((options) => build(options)));
    await copyStatic();
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
