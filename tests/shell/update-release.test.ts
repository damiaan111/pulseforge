import { describe, expect, it } from 'vitest';

import { compareVersions, isReleaseDownload, parseVersion, pickRelease, releaseChecksum, type GitHubRelease } from '../../src/shell/update-release.ts';

const HASH = 'bae1b53e8d80342166dab4fb4fceca7457e8b3f5cd87f0eb1696a2b674973df7';
const download = (tag: string, name: string) => `https://github.com/damiaan111/pulseforge/releases/download/${tag}/${name}`;

const release = (tag: string, asset: string, body = `SHA-256: \`${HASH}\``, extra: Partial<GitHubRelease> = {}): GitHubRelease => ({
  tag_name: tag,
  html_url: `https://github.com/damiaan111/pulseforge/releases/tag/${tag}`,
  body,
  assets: [{ name: asset, size: 121_723_035, browser_download_url: download(tag, asset) }],
  ...extra,
});

const RELEASES: readonly GitHubRelease[] = [
  release('v1.1.0-mac.1', 'Pulseforge-1.1.0-mac-arm64.dmg', 'no checksum here'),
  release('v1.1.1', 'Pulseforge-Setup-1.1.1.exe'),
  release('v1.1.0', 'Pulseforge-Setup-1.1.0.exe'),
  release('v1.2.0', 'Pulseforge-Setup-1.2.0.exe', '', { draft: true }),
];

describe('versions', () => {
  it('reads Windows and Mac versions, with or without the v', () => {
    expect(parseVersion('1.1.1')).toEqual([1, 1, 1, 0]);
    expect(parseVersion('v1.1.0-mac.2')).toEqual([1, 1, 0, 2]);
    expect(parseVersion('1.1')).toBeNull();
    expect(parseVersion('1.1.1-beta')).toBeNull();
  });

  it('orders them numerically, the Mac build number last', () => {
    expect(compareVersions('1.1.1', '1.1.0')).toBeGreaterThan(0);
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.1.0-mac.2', '1.1.0-mac.1')).toBeGreaterThan(0);
    expect(compareVersions('1.1.1', '1.1.1')).toBe(0);
    expect(compareVersions('nonsense', '1.0.0')).toBeLessThan(0);
  });
});

describe('choosing a release', () => {
  it('gives Windows the newest Windows release with an installer, never a draft or the Mac build', () => {
    const chosen = pickRelease(RELEASES, 'windows');
    expect(chosen?.version).toBe('1.1.1');
    expect(chosen?.assetName).toBe('Pulseforge-Setup-1.1.1.exe');
    expect(chosen?.sha256).toBe(HASH);
  });

  it('gives the Mac its own builds, and no checksum where the notes name none', () => {
    const chosen = pickRelease(RELEASES, 'mac');
    expect(chosen?.version).toBe('1.1.0-mac.1');
    expect(chosen?.sha256).toBeNull();
  });

  it('skips a release without the installer for this system', () => {
    expect(pickRelease([release('v2.0.0', 'notes.txt')], 'windows')).toBeUndefined();
  });

  it('downloads only from this repository', () => {
    expect(isReleaseDownload(download('v1.1.1', 'Pulseforge-Setup-1.1.1.exe'))).toBe(true);
    expect(isReleaseDownload('https://github.com/someone/else/releases/download/v1/x.exe')).toBe(false);
    expect(isReleaseDownload('https://github.com/damiaan111/pulseforge/releases/download/../../x.exe')).toBe(false);
    const foreign = { ...release('v9.0.0', 'Pulseforge-Setup-9.0.0.exe'), assets: [{ name: 'Pulseforge-Setup-9.0.0.exe', size: 1, browser_download_url: 'https://evil.example/x.exe' }] };
    expect(pickRelease([foreign], 'windows')).toBeUndefined();
  });

  it('reads the checksum line the release notes carry', () => {
    expect(releaseChecksum(`Download\n\nSHA-256: \`${HASH.toUpperCase()}\`\n`)).toBe(HASH);
    expect(releaseChecksum('SHA-256: abc')).toBeNull();
    expect(releaseChecksum(null)).toBeNull();
  });
});
