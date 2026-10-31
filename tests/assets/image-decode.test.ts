// Image decode through the vendored FFmpeg: size, orientation, hash, and a clear error for a file
// that is not an image.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ImageDecodeError, decodeAttachedPicture, decodeImageFile } from '../../src/assets/image-decode.ts';
import { FFMPEG_EXE, FFPROBE_EXE, ROOT } from '../../setup/lib/paths.ts';

const available = existsSync(FFMPEG_EXE) && existsSync(FFPROBE_EXE);
const DIR = join(ROOT, 'out', 'test-image-decode');

describe.skipIf(!available)('decodeImageFile', () => {
  it('decodes a PNG top row first, with the file hash', async () => {
    mkdirSync(DIR, { recursive: true });
    const png = join(DIR, 'split.png');
    // 8×6: red on top, blue below.
    const made = spawnSync(FFMPEG_EXE, [
      '-v', 'error', '-y', '-filter_complex', 'color=c=red:s=8x3,format=rgba[t];color=c=blue:s=8x3,format=rgba[b];[t][b]vstack',
      '-frames:v', '1', png,
    ], { windowsHide: true });
    expect(made.status, made.stderr.toString()).toBe(0);

    const image = await decodeImageFile(FFMPEG_EXE, FFPROBE_EXE, png);
    expect([image.width, image.height]).toEqual([8, 6]);
    expect(image.pixels.length).toBe(8 * 6 * 4);
    expect([...image.pixels.slice(0, 4)]).toEqual([255, 0, 0, 255]);
    const last = (8 * 6 - 1) * 4;
    expect([...image.pixels.slice(last, last + 4)]).toEqual([0, 0, 255, 255]);
    expect(image.sha256).toBe(createHash('sha256').update(readFileSync(png)).digest('hex'));
  }, 60_000);

  it('scales down past the size limit', async () => {
    const png = join(DIR, 'split.png');
    const image = await decodeImageFile(FFMPEG_EXE, FFPROBE_EXE, png, 4);
    expect([image.width, image.height, image.sourceWidth]).toEqual([4, 3, 8]);
    expect(image.pixels.length).toBe(4 * 3 * 4);
  }, 60_000);

  it('names the file when it is not an image', async () => {
    mkdirSync(DIR, { recursive: true });
    const bogus = join(DIR, 'not-an-image.png');
    writeFileSync(bogus, 'hello');
    await expect(decodeImageFile(FFMPEG_EXE, FFPROBE_EXE, bogus)).rejects.toThrow(ImageDecodeError);
  }, 60_000);
});

describe.skipIf(!available)('decodeAttachedPicture', () => {
  const ffmpeg = (...args: string[]) => {
    const made = spawnSync(FFMPEG_EXE, ['-v', 'error', '-y', ...args], { windowsHide: true });
    expect(made.status, made.stderr.toString()).toBe(0);
  };

  it('reads the embedded picture of a song, and only that', async () => {
    mkdirSync(DIR, { recursive: true });
    const cover = join(DIR, 'cover.png');
    const plain = join(DIR, 'plain.flac');
    const tagged = join(DIR, 'tagged.flac');
    ffmpeg('-f', 'lavfi', '-i', 'color=c=red:s=16x16', '-frames:v', '1', cover);
    ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', plain);
    ffmpeg('-i', plain, '-i', cover, '-map', '0:a', '-map', '1:v', '-c', 'copy', '-disposition:v', 'attached_pic', tagged);

    const image = await decodeAttachedPicture(FFMPEG_EXE, FFPROBE_EXE, tagged);
    expect([image?.width, image?.height]).toEqual([16, 16]);
    // lavfi's colour source runs through YUV, so red comes back a shade off.
    expect(image?.pixels[0]).toBeGreaterThan(240);
    expect(image?.pixels[1]).toBeLessThan(10);
    expect(await decodeAttachedPicture(FFMPEG_EXE, FFPROBE_EXE, plain)).toBeNull();
  }, 60_000);

  it('does not take a video track for cover art', async () => {
    mkdirSync(DIR, { recursive: true });
    const clip = join(DIR, 'clip.mkv');
    ffmpeg('-f', 'lavfi', '-i', 'color=c=blue:s=16x16:d=0.2', '-c:v', 'ffv1', clip);
    expect(await decodeAttachedPicture(FFMPEG_EXE, FFPROBE_EXE, clip)).toBeNull();
  }, 60_000);

  it('scales a large picture down, so colours never cost a full decode', async () => {
    mkdirSync(DIR, { recursive: true });
    const cover = join(DIR, 'big-cover.png');
    const plain = join(DIR, 'plain2.flac');
    const tagged = join(DIR, 'big-tagged.flac');
    ffmpeg('-f', 'lavfi', '-i', 'color=c=green:s=64x32', '-frames:v', '1', cover);
    ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=220:duration=1', plain);
    ffmpeg('-i', plain, '-i', cover, '-map', '0:a', '-map', '1:v', '-c', 'copy', '-disposition:v', 'attached_pic', tagged);
    const image = await decodeAttachedPicture(FFMPEG_EXE, FFPROBE_EXE, tagged, 16);
    expect([image?.width, image?.height, image?.sourceWidth]).toEqual([16, 8, 64]);
  }, 60_000);
});
