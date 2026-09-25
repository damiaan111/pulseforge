import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ALL_TIERS, FUTURE_TIERS, type Tier } from './manifest.ts';
import { SetupError, formatSetupError, formatUnexpectedError } from './lib/errors.ts';
import { writeLicenses } from './lib/licenses.ts';
import { readVendorLock, writeVendorLock } from './lib/lockfile.ts';
import { createLogger, formatBytes, type Logger } from './lib/log.ts';
import { SETUP_LOG, SETUP_PID, VENDOR } from './lib/paths.ts';
import { requiredBytes, runPreflight, type Check } from './lib/preflight.ts';
import { ffmpegStep, fontStep, pythonStep, uvStep } from './steps/archives.ts';
import { demucsModelStep } from './steps/demucs-model.ts';
import { lyricsModelsStep } from './steps/lyrics-models.ts';
import { pythonEnvStep, pythonLyricsEnvStep } from './steps/python-env.ts';
import type { Step, StepContext } from './steps/types.ts';

/** In dependency order: Python before uv's resolve, the env before the model check. */
const STEPS: readonly Step[] = [ffmpegStep, fontStep, pythonStep, uvStep, pythonEnvStep, demucsModelStep, pythonLyricsEnvStep, lyricsModelsStep];

const USAGE = `
Usage: npm run setup -- [options]

Provisions everything Pulseforge needs into vendor/, verified against pinned SHA-256
checksums. Safe to re-run at any time: finished work is kept and downloads resume.

Options:
  --plan          Show what would be downloaded and where, check preconditions, change nothing.
  --tier <list>   Comma-separated tiers to install (default: ${ALL_TIERS.join(',')}).
                    core   FFmpeg (NVENC build)
                    stems  portable Python, uv, torch CUDA + Demucs wheelhouse, htdemucs weights
                    lyrics WhisperX wheelhouse, Whisper medium, wav2vec2 (English alignment)
  --verify        Re-check installed artefacts against their checksums, offline. Changes nothing.
  --relock        Re-resolve setup/python/requirements.lock.txt from requirements.in (needs network).
  --from <dir>    Take pinned archives/models from <dir> instead of the network.
  --help          Show this help.
`;

interface Options {
  plan: boolean;
  verify: boolean;
  relock: boolean;
  tiers: Tier[];
  fromDir: string | undefined;
}

function parseOptions(argv: string[]): Options | string {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      options: {
        plan: { type: 'boolean', default: false },
        verify: { type: 'boolean', default: false },
        relock: { type: 'boolean', default: false },
        tier: { type: 'string' },
        from: { type: 'string' },
        help: { type: 'boolean', default: false },
      },
    });
  } catch (error) {
    return `${(error as Error).message}\n${USAGE}`;
  }
  const { values } = parsed;
  if (values.help) return USAGE;
  if (values.plan && values.verify) return `--plan and --verify cannot be combined.\n${USAGE}`;

  const tiers: Tier[] = [];
  for (const name of (values.tier ?? ALL_TIERS.join(',')).split(',').map((t) => t.trim()).filter(Boolean)) {
    if ((ALL_TIERS as readonly string[]).includes(name)) {
      tiers.push(name as Tier);
    } else if (name in FUTURE_TIERS) {
      return `The "${name}" tier is not available yet: ${FUTURE_TIERS[name] ?? ''}\nAvailable now: ${ALL_TIERS.join(', ')}.`;
    } else {
      return `Unknown tier "${name}". Available: ${ALL_TIERS.join(', ')}.\n${USAGE}`;
    }
  }
  if (tiers.length === 0) return `--tier was empty. Available: ${ALL_TIERS.join(', ')}.`;
  return {
    plan: values.plan,
    verify: values.verify,
    relock: values.relock,
    tiers,
    fromDir: values.from !== undefined ? resolve(values.from) : undefined,
  };
}

function acquireRunLock(): () => void {
  const release = () => rmSync(SETUP_PID, { force: true });
  try {
    writeFileSync(SETUP_PID, String(process.pid), { flag: 'wx' });
    return release;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const pid = Number(readFileSync(SETUP_PID, 'utf8').trim());
  if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && isAlive(pid)) {
    throw new SetupError({
      step: 'start',
      what: `Another setup run appears to be active (process ${pid}).`,
      likelyCause: 'Two setups writing into vendor/ at once would corrupt each other.',
      fix: [
        'Wait for the other run to finish, or close it.',
        `If no setup is running (the process id was reused), delete ${SETUP_PID} and re-run.`,
      ],
    });
  }
  writeFileSync(SETUP_PID, String(process.pid));
  return release;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function printChecks(log: Logger, checks: readonly Check[]): void {
  log.heading('Preconditions');
  for (const check of checks) {
    const line = `${check.name}: ${check.detail}`;
    if (check.status === 'ok') log.ok(line);
    else if (check.status === 'warn') log.warn(line);
    else log.info(`✖ ${line}`);
  }
}

function firstFailure(checks: readonly Check[]): SetupError | undefined {
  const failed = checks.filter((c) => c.status === 'fail');
  const first = failed[0];
  if (first === undefined) return undefined;
  return new SetupError({
    step: 'preconditions',
    what: failed.map((c) => `${c.name}: ${c.detail}`).join(' | '),
    fix: failed.flatMap((c) => c.fix ?? []),
  });
}

async function printPlan(log: Logger, steps: readonly Step[], options: Options): Promise<void> {
  const lock = await readVendorLock(log);
  log.heading(`Plan for tiers: ${options.tiers.join(', ')} (nothing is downloaded or changed)`);
  log.info(`Destination: ${VENDOR}`);
  if (options.fromDir !== undefined) log.info(`--from: files are taken from ${options.fromDir} instead of the network`);
  let index = 1;
  for (const step of steps) {
    const row = await step.describe(lock);
    log.info('');
    log.info(`${index++}. ${row.name}`);
    log.info(`   version:     ${row.version}`);
    log.info(`   download:    ${row.download}`);
    log.info(`   from:        ${row.source}`);
    log.info(`   into:        ${row.destination}`);
    log.info(`   status:      ${row.status}`);
  }
  log.info('');
  log.info(`Disk space to have free before starting: ~${formatBytes(requiredBytes(options.tiers))}`);
  log.info('Also written: vendor/vendor.lock.json, vendor/LICENSES.md, vendor/setup.log.');
  log.info('Temporary files: vendor/.tmp and vendor/.staging (not %TEMP%). Package caches: vendor/.cache.');
  log.info('Nothing is installed outside vendor/ except the Python locks in setup/python/ (requirements.lock.txt, requirements-lyrics.lock.txt), generated on first run for you to commit.');
  log.info('');
  log.info('Run `npm run setup` to execute this plan.');
}

export async function main(argv: string[]): Promise<number> {
  const options = parseOptions(argv);
  if (typeof options === 'string') {
    const isHelp = options === USAGE;
    (isHelp ? console.log : console.error)(options);
    return isHelp ? 0 : 2;
  }

  await mkdir(VENDOR, { recursive: true });
  const log = createLogger(SETUP_LOG);
  let currentStep = 'start';
  let release: (() => void) | undefined;
  const onInterrupt = () => {
    log.warn(`Interrupted during "${currentStep}". Nothing is left half-installed; re-run \`npm run setup\` to continue where it stopped.`);
    release?.();
    process.exit(130);
  };
  process.once('SIGINT', onInterrupt);

  try {
    if (!options.plan) release = acquireRunLock();
    const steps = STEPS.filter((s) => options.tiers.includes(s.tier));

    currentStep = 'preconditions';
    const preflight = await runPreflight(options.tiers, log);
    printChecks(log, preflight.checks);
    const failure = firstFailure(preflight.checks);

    if (options.plan) {
      await printPlan(log, steps, options);
      if (failure !== undefined) {
        log.warn('Setup would stop at the failed precondition(s) above. Fix those first.');
        return 1;
      }
      return 0;
    }
    if (failure !== undefined) throw failure;

    const ctx: StepContext = { log, lock: await readVendorLock(log), fromDir: options.fromDir, relock: options.relock };
    for (const step of steps) {
      currentStep = step.title;
      if (options.verify) {
        await step.verify(ctx);
      } else {
        await step.run(ctx);
        await writeVendorLock(ctx.lock); // persist progress after every step
      }
    }

    if (!options.verify) {
      currentStep = 'licences';
      await writeLicenses(ctx.lock);
    }

    log.heading(options.verify ? 'Verification passed' : 'Setup complete');
    log.ok(`Tiers: ${options.tiers.join(', ')}`);
    if (!options.verify) {
      log.info('Recorded: vendor/vendor.lock.json · vendor/LICENSES.md');
      log.info('Everything installed runs offline from here on. `npm run setup -- --verify` re-checks it at any time.');
    }
    return 0;
  } catch (error) {
    if (error instanceof SetupError) {
      log.detail(`SetupError: ${error.what}`);
      console.error(formatSetupError(error, SETUP_LOG));
    } else {
      log.detail(`Unexpected error in "${currentStep}": ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      console.error(formatUnexpectedError(currentStep, error, SETUP_LOG));
    }
    return 1;
  } finally {
    process.off('SIGINT', onInterrupt);
    release?.();
  }
}
