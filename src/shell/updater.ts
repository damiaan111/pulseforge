// Settings → "Check for updates" (D52). The one place Pulseforge reaches the network after setup, and only
// when someone presses the button: it asks GitHub for this repository's releases, and on a second press
// downloads the installer into DATA_ROOT, checks it against the SHA-256 in the release notes, and hands
// over. Node's own fetch, in the main process: the page's session stays locked (lockDownSession).

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { DATA_ROOT } from '../../setup/lib/paths.ts';
import { RELEASES_API, isReleaseDownload, pickRelease, type GitHubRelease, type ReleaseChoice, type UpdateChannel } from './update-release.ts';

/** Downloaded installers wait here; the newest one is replaced by the next. */
export const UPDATES_DIR = join(DATA_ROOT, 'updates');

const HEADERS = { 'User-Agent': 'Pulseforge', Accept: 'application/vnd.github+json' };

export async function findUpdate(channel: UpdateChannel): Promise<ReleaseChoice | undefined> {
  const response = await fetch(RELEASES_API, { headers: HEADERS, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} ${response.statusText}.`);
  return pickRelease(await response.json() as GitHubRelease[], channel);
}

/** Downloads the installer and proves it is the published one; resolves to its path. */
export async function downloadUpdate(choice: ReleaseChoice, onProgress: (received: number, total: number) => void): Promise<string> {
  if (choice.sha256 === null) throw new Error('This release names no SHA-256, so its download cannot be checked. Download it from the release page instead.');
  if (!isReleaseDownload(choice.assetUrl) || !/^[\w.+-]+$/.test(choice.assetName)) throw new Error(`Refusing to download ${choice.assetUrl}.`);
  await mkdir(UPDATES_DIR, { recursive: true });
  const target = join(UPDATES_DIR, choice.assetName);
  const partial = `${target}.part`;
  const response = await fetch(choice.assetUrl, { headers: { 'User-Agent': 'Pulseforge' }, signal: AbortSignal.timeout(30 * 60_000) });
  if (!response.ok || response.body === null) throw new Error(`The download failed: ${response.status} ${response.statusText}.`);

  const hash = createHash('sha256');
  const out = createWriteStream(partial);
  let received = 0;
  try {
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      received += chunk.length;
      if (!out.write(chunk)) await new Promise<void>((resolve) => out.once('drain', () => resolve()));
      onProgress(received, choice.bytes);
    }
    await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => (error ? reject(error) : resolve())));
  } catch (error) {
    out.destroy();
    await rm(partial, { force: true });
    throw error;
  }
  const digest = hash.digest('hex');
  if (digest !== choice.sha256) {
    await rm(partial, { force: true });
    throw new Error(`The download does not match the release's SHA-256 (got ${digest.slice(0, 12)}…, expected ${choice.sha256.slice(0, 12)}…). Nothing was installed.`);
  }
  await rename(partial, target);
  return target;
}
