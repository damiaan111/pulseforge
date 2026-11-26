// Which GitHub release is newer than this build, and for which system. Pure, so it is tested without the
// network; shell/updater.ts does the asking and the downloading, and only when someone presses the
// button (D52: the one exception to "no update checks").

/** The repository the releases come from. Downloads from anywhere else are refused. */
export const UPDATE_REPOSITORY = 'damiaan111/pulseforge';
export const RELEASES_API = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases?per_page=30`;
const DOWNLOAD_PREFIX = `https://github.com/${UPDATE_REPOSITORY}/releases/download/`;

/** Windows releases are tagged `v1.1.1`, the Mac's `v1.1.0-mac.1`; each system follows its own. */
export type UpdateChannel = 'windows' | 'mac';

/** What this code reads of GitHub's release JSON. */
export interface GitHubRelease {
  readonly tag_name: string;
  readonly html_url: string;
  readonly body?: string | null;
  readonly draft?: boolean;
  readonly assets: readonly { readonly name: string; readonly size: number; readonly browser_download_url: string }[];
}

export interface ReleaseChoice {
  readonly version: string;
  readonly notes: string;
  readonly page: string;
  readonly assetName: string;
  readonly assetUrl: string;
  readonly bytes: number;
  /** From the release notes' `SHA-256:` line; null when the release names none, and then nothing is installed. */
  readonly sha256: string | null;
}

/** `1.1.1` → [1, 1, 1, 0]; `1.1.0-mac.2` → [1, 1, 0, 2]. Null for anything else. */
export function parseVersion(text: string): readonly number[] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-mac\.(\d+))?$/.exec(text.trim());
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4] ?? 0)];
}

/** Negative when `a` is older than `b`, zero when equal; unparsable versions sort first. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === null || right === null) return (left === null ? 0 : 1) - (right === null ? 0 : 1);
  for (let i = 0; i < 4; i += 1) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** The SHA-256 a release's notes give for its download. */
export function releaseChecksum(body: string | null | undefined): string | null {
  const match = /SHA-256:\s*`([0-9a-f]{64})`/i.exec(body ?? '');
  return match?.[1]?.toLowerCase() ?? null;
}

/** Only this repository's own release downloads. */
export function isReleaseDownload(url: string): boolean {
  return url.startsWith(DOWNLOAD_PREFIX) && !url.includes('..');
}

function belongsTo(tag: string, channel: UpdateChannel): boolean {
  return channel === 'mac' ? /^v\d+\.\d+\.\d+-mac\.\d+$/.test(tag) : /^v\d+\.\d+\.\d+$/.test(tag);
}

function installer(release: GitHubRelease, channel: UpdateChannel): GitHubRelease['assets'][number] | undefined {
  const wanted = channel === 'mac' ? /\.dmg$/i : /^Pulseforge-Setup-.*\.exe$/i;
  return release.assets.find((asset) => wanted.test(asset.name) && isReleaseDownload(asset.browser_download_url));
}

/** The newest release for this system that has an installer; undefined when there is none. */
export function pickRelease(releases: readonly GitHubRelease[], channel: UpdateChannel): ReleaseChoice | undefined {
  let best: ReleaseChoice | undefined;
  for (const release of releases) {
    if (release.draft === true || !belongsTo(release.tag_name, channel)) continue;
    const asset = installer(release, channel);
    if (asset === undefined) continue;
    const version = release.tag_name.replace(/^v/, '');
    if (best !== undefined && compareVersions(version, best.version) <= 0) continue;
    best = {
      version,
      notes: (release.body ?? '').trim(),
      page: release.html_url,
      assetName: asset.name,
      assetUrl: asset.browser_download_url,
      bytes: asset.size,
      sha256: releaseChecksum(release.body),
    };
  }
  return best;
}
