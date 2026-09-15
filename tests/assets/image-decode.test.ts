// Image decode through the vendored FFmpeg: size, orientation, hash, and a clear error for a file
// that is not an image.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ImageDecodeError, decodeImageFile } from '../../src/assets/image-decode.ts';
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
