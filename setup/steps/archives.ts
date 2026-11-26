import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { FFMPEG, FONT_INTER, PYTHON, UV, type ArchiveArtefact } from '../manifest.ts';
import { installArchive, isInstalled } from '../lib/archive.ts';
import { ensureDownloaded, sha256File } from '../lib/download.ts';
import { pythonEnv } from '../lib/env.ts';
import { SetupError } from '../lib/errors.ts';
import { upsertArtefact } from '../lib/lockfile.ts';
import { formatBytes } from '../lib/log.ts';
import { DOWNLOADS, FFMPEG_EXE, FONTS, PYTHON_EXE, UV_EXE, VENDOR } from '../lib/paths.ts';
import { runChecked } from '../lib/proc.ts';
import type { Step, StepContext } from './types.ts';

type PostInstallCheck = (ctx: StepContext, step: string) => Promise<void>;

function archiveStep(artefact: ArchiveArtefact, title: string, check: PostInstallCheck): Step {
  const archivePath = join(DOWNLOADS, artefact.fileName);
  return {
    id: artefact.id,
    title,
    tier: artefact.tier,

    async describe() {
      const installed = await isInstalled(artefact);
      const kept = existsSync(archivePath);
      return {
        name: artefact.name,
        version: artefact.version,
        download: installed && kept ? 'already downloaded' : formatBytes(artefact.sizeBytes),
        source: artefact.url,
        destination: `vendor/${artefact.installDir}/ (archive kept in vendor/downloads/)`,
        status: installed ? 'installed' : kept ? 'downloaded, not yet extracted' : 'not installed',
      };
    },

    async run(ctx) {
      ctx.log.heading(title);
      const result = await ensureDownloaded(
        {
          step: title,
          label: artefact.name,
          url: artefact.url,
          dest: archivePath,
          sha256: artefact.sha256,
          expectedSize: artefact.sizeBytes,
          ...(ctx.fromDir !== undefined ? { fromDir: ctx.fromDir } : {}),
        },
        ctx.log,
      );
      ctx.log.ok(
        result.source === 'cached'
          ? `Archive present and verified (${formatBytes(result.bytes)})`
          : `Downloaded and verified ${artefact.fileName} (${formatBytes(result.bytes)})`,
      );

      if (await isInstalled(artefact)) {
        ctx.log.ok(`Already installed in vendor/${artefact.installDir}`);
      } else {
        ctx.log.info(`Extracting to vendor/${artefact.installDir} …`);
        await installArchive(archivePath, artefact, title, ctx.log);
        ctx.log.ok(`Installed in vendor/${artefact.installDir}`);
      }

      await check(ctx, title);
      upsertArtefact(ctx.lock, {
        id: artefact.id,
        name: artefact.name,
        version: artefact.version,
        url: artefact.url,
        fileName: artefact.fileName,
        sha256: result.sha256,
        sizeBytes: result.bytes,
        license: artefact.license,
        installPath: artefact.installDir,
      });
    },

    async verify(ctx) {
      ctx.log.heading(`Verify: ${title}`);
      if (!existsSync(archivePath)) {
        throw new SetupError({
          step: title,
          what: `The kept archive ${artefact.fileName} is missing from vendor/downloads/.`,
          likelyCause: 'It was deleted. Without it this artefact cannot be rebuilt offline if the upstream URL disappears.',
          fix: ['Run `npm run setup` (with internet) to fetch it again.'],
        });
      }
      const actual = await sha256File(archivePath);
      if (actual !== artefact.sha256) {
        throw new SetupError({
          step: title,
          what: `${artefact.fileName} no longer matches its pinned SHA-256.`,
          likelyCause: `The file on disk was modified or corrupted. Expected ${artefact.sha256}, got ${actual}.`,
          fix: ['Delete it and run `npm run setup` to fetch a clean copy.'],
        });
      }
      if (!(await isInstalled(artefact))) {
        throw new SetupError({
          step: title,
          what: `vendor/${artefact.installDir} is missing or incomplete.`,
          fix: ['Run `npm run setup`. It re-extracts from the kept archive without downloading.'],
        });
      }
      await check(ctx, title);
      ctx.log.ok('Archive checksum, install and executable all verified');
    },
  };
}

const ffmpegCheck: PostInstallCheck = async (ctx, step) => {
  const version = await runChecked(FFMPEG_EXE, ['-hide_banner', '-version'], { step, log: ctx.log }, () => ({
    what: 'The vendored ffmpeg.exe does not run.',
    likelyCause: 'The extracted files are damaged, or antivirus quarantined them.',
    fix: [`Delete ${join(VENDOR, 'ffmpeg')} and re-run setup; it re-extracts from the kept archive.`],
  }));
  ctx.log.ok(version.stdout.split(/\r?\n/)[0] ?? 'ffmpeg runs');

  const encoders = await runChecked(FFMPEG_EXE, ['-hide_banner', '-encoders'], { step, log: ctx.log }, () => ({
    what: 'ffmpeg -encoders failed.',
    fix: [`Delete ${join(VENDOR, 'ffmpeg')} and re-run setup.`],
  }));
  const missing = ['h264_nvenc', 'hevc_nvenc'].filter((name) => !new RegExp(`\\s${name}\\s`).test(encoders.stdout));
  if (missing.length > 0) {
    throw new SetupError({
      step,
      what: `The pinned FFmpeg build does not include ${missing.join(' and ')}.`,
      likelyCause: 'The manifest points at a build without NVENC support.',
      fix: ['Pin an NVENC-capable LGPL build in setup/manifest.ts (BtbN win64-lgpl builds include NVENC).'],
    });
  }
  // These encoders are compiled in; whether this GPU and driver can actually use them
  // (no AV1 on Ampere) is a runtime capability probe, which is `npm run validate`'s job.
  ctx.log.ok('NVENC encoders present in the build: h264_nvenc, hevc_nvenc');
};

const pythonCheck: PostInstallCheck = async (ctx, step) => {
  const script =
    'import json, site, sys; print(json.dumps({"version": sys.version.split()[0], "executable": sys.executable, "userSite": bool(site.ENABLE_USER_SITE)}))';
  const result = await runChecked(PYTHON_EXE, ['-c', script], { step, log: ctx.log, env: pythonEnv() }, () => ({
    what: 'The vendored python.exe does not run.',
    likelyCause: 'The extracted files are damaged, or antivirus quarantined them.',
    fix: [`Delete ${join(VENDOR, 'python')} and re-run setup.`],
  }));
  const info = JSON.parse(result.stdout) as { version: string; executable: string; userSite: boolean };
  if (!info.executable.toLowerCase().startsWith(VENDOR.toLowerCase())) {
    throw new SetupError({
      step,
      what: `python.exe reports its executable as ${info.executable}, not the vendored copy.`,
      likelyCause: 'Something on this machine redirects Python launches (an App Execution Alias or a wrapper).',
      fix: ['Disable Python App Execution Aliases in Windows Settings > Apps > Advanced app settings, then re-run setup.'],
    });
  }
  if (info.userSite) {
    throw new SetupError({
      step,
      what: 'The vendored Python still has user site-packages enabled.',
      likelyCause: 'The isolation environment was not applied, so the system Python\'s packages could leak into the sidecar.',
      fix: ['This is a setup bug. Share vendor/setup.log.'],
    });
  }
  ctx.log.ok(`Python ${info.version}, isolated from the system Python (user site-packages disabled)`);
};

const uvCheck: PostInstallCheck = async (ctx, step) => {
  const result = await runChecked(UV_EXE, ['--version'], { step, log: ctx.log, env: pythonEnv() }, () => ({
    what: 'The vendored uv.exe does not run.',
    fix: [`Delete ${join(VENDOR, 'uv')} and re-run setup.`],
  }));
  ctx.log.ok(result.stdout.trim());
};

const fontCheck: PostInstallCheck = async (ctx, step) => {
  const file = join(FONTS, 'inter', 'extras', 'ttf', 'Inter-Regular.ttf');
  if (!existsSync(file)) {
    throw new SetupError({ step, what: `${file} is missing after extraction.`, fix: [`Delete ${join(FONTS, 'inter')} and re-run setup.`] });
  }
  ctx.log.ok('Inter present (extras/ttf)');
};

export const ffmpegStep = archiveStep(FFMPEG, 'FFmpeg (NVENC build)', ffmpegCheck);
export const fontStep = archiveStep(FONT_INTER, 'Bundled fonts (Inter)', fontCheck);
export const pythonStep = archiveStep(PYTHON, 'Portable Python', pythonCheck);
export const uvStep = archiveStep(UV, 'uv', uvCheck);
