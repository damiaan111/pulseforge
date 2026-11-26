// npm run validate — the P0 validation script (export-spec §17, PROJECT.md P0).
//
// Eight checks, one pasteable report: environment, determinism, readback benchmark, colour
// correctness, encoder matrix, throughput, stems, A/V sync. Writes out/validate/report.md and
// report.json. A failing check does not stop the others.
//
// Options: --quick (shorter runs, fewer variants, ~5 min), --only 2,4,8

import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { FFMPEG_EXE, PYTHON_EXE, ROOT } from '../setup/lib/paths.ts';
import { bundleElectron, fail } from './harness.ts';
import { checkColour, checkDeterminism, checkReadback } from './validate/checks-render.ts';
import { checkEncoders, checkEnvironment, checkStems, checkSync, checkThroughput } from './validate/checks-system.ts';
import type { Check, CheckOutcome, ValidateContext } from './validate/context.ts';

const CHECKS: ReadonlyArray<{ id: number; title: string; run: Check }> = [
  { id: 1, title: 'Environment', run: checkEnvironment },
  { id: 2, title: 'Determinism', run: checkDeterminism },
  { id: 3, title: 'Readback benchmark', run: checkReadback },
  { id: 4, title: 'Colour correctness', run: checkColour },
  { id: 5, title: 'Encoder matrix', run: checkEncoders },
  { id: 6, title: 'Throughput', run: checkThroughput },
  { id: 7, title: 'Stems (Demucs)', run: checkStems },
  { id: 8, title: 'A/V sync', run: checkSync },
];

const ICON = { pass: '✅', warn: '⚠️', fail: '❌', skip: '⏭️' } as const;

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { quick: { type: 'boolean', default: false }, only: { type: 'string' } } });
  if (!existsSync(FFMPEG_EXE) || !existsSync(PYTHON_EXE)) {
    fail('vendor/ is not provisioned.', ['Run `npm run setup` first (core + stems tiers).']);
  }
  const only = values.only?.split(',').map((s) => Number(s.trim()));
  if (only?.some((id) => !CHECKS.some((c) => c.id === id))) fail(`--only takes check numbers 1–8, got ${values.only}`, ['Example: --only 2,4,8']);

  const outDir = join(ROOT, 'out', 'validate');
  const workDir = join(outDir, 'work');
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  const started = new Date();
  const ctx: ValidateContext = {
    quick: values.quick,
    workDir,
    log: (line) => console.log(`    ${line}`),
  };

  console.log('▶ Bundling Electron harness');
  await bundleElectron();

  // Environment runs last so it can report the WebGL details the determinism check collects.
  const order = [...CHECKS.filter((c) => c.id !== 1), ...CHECKS.filter((c) => c.id === 1)];
  const outcomes: CheckOutcome[] = [];
  for (const check of order) {
    if (only !== undefined && !only.includes(check.id)) {
      outcomes.push({ id: check.id, title: check.title, status: 'skip', lines: ['Skipped (--only).'], data: {}, seconds: 0 });
      continue;
    }
    console.log(`\n▶ Check ${check.id}: ${check.title}`);
    const t0 = performance.now();
    try {
      const outcome = await check.run(ctx);
      outcomes.push({ ...outcome, seconds: (performance.now() - t0) / 1000 });
      console.log(`  ${ICON[outcome.status]} ${outcome.status.toUpperCase()} (${((performance.now() - t0) / 1000).toFixed(0)} s)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const log = (error as { log?: string }).log;
      outcomes.push({
        id: check.id,
        title: check.title,
        status: 'fail',
        lines: [`The check itself failed: \`${message}\``, ...(log ? ['', '```', ...log.trim().split('\n').slice(-12), '```'] : [])],
        data: { error: message },
        seconds: (performance.now() - t0) / 1000,
      });
      console.log(`  ${ICON.fail} FAILED: ${message}`);
    }
  }
  outcomes.sort((a, b) => a.id - b.id);

  const totalSeconds = outcomes.reduce((sum, o) => sum + o.seconds, 0);
  const md = [
    `# Pulseforge P0 validation report`,
    '',
    `${started.toISOString()} · ${values.quick ? 'quick mode' : 'full mode'} · ${(totalSeconds / 60).toFixed(1)} min`,
    '',
    '| # | Check | Result | Time |',
    '|---|---|---|---|',
    ...outcomes.map((o) => `| ${o.id} | ${o.title} | ${ICON[o.status]} ${o.status} | ${o.seconds.toFixed(0)} s |`),
    '',
    ...outcomes.flatMap((o) => [`## ${o.id}. ${o.title} — ${ICON[o.status]} ${o.status}`, '', ...o.lines, '']),
  ].join('\n');

  await writeFile(join(outDir, 'report.md'), md);
  await writeFile(join(outDir, 'report.json'), JSON.stringify({ started: started.toISOString(), quick: values.quick, outcomes }, null, 2));
  console.log(`\n${md}\n`);
  console.log(`Report: ${join(outDir, 'report.md')} (machine-readable: report.json)`);
  process.exitCode = outcomes.some((o) => o.status === 'fail') ? 1 : 0;
}

await main();
