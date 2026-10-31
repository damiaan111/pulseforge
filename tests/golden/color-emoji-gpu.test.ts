// Colour emoji on the real GPU: asked for, an emoji keeps its own colours while letters keep the fill,
// the masks still drive every effect, and nothing changes for a title that does not ask.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import type { RenderProject } from '../../src/engine/core/project.ts';
import { rational } from '../../src/engine/core/time.ts';
import { COLOR_EMOJI_FILE, DEFAULT_FONT_FILE } from '../../setup/lib/paths.ts';
import { fallbackFontFiles } from '../../src/assets/fonts.ts';
import { bundleElectron } from '../../spike/harness.ts';
import { renderFrames, type RenderedFrame } from '../../spike/lib/frames-run.ts';

const ELECTRON = resolve(import.meta.dirname, '..', '..', 'node_modules', 'electron', 'dist', 'electron.exe');
const available = existsSync(ELECTRON) && existsSync(DEFAULT_FONT_FILE) && fallbackFontFiles().length > 0;

function project(params: Record<string, unknown>): RenderProject {
  return {
    schemaVersion: 0,
    seed: 3,
    durationTicks: 48_000 * 4,
    canvas: { width: 640, height: 360, fps: rational(60), background: '#000000' },
    audio: { leadInTicks: 0, clipInTicks: 0 },
    layers: [{
      id: 't', module: 'core.text.title', enabled: true, opacity: 1, blend: 'normal',
      params: { shadow: 0, animIn: 'none', animOut: 'none', size: 0.25, ...params },
      timeRange: { inTicks: 0, outTicks: null },
    }],
  };
}

/** Pixels that are visibly not grey: how much of the frame is coloured at all. */
function chromatic(frame: RenderedFrame): number {
  let count = 0;
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      const { r, g, b } = frame.at(x, y);
      if (Math.max(r, g, b) - Math.min(r, g, b) > 60) count += 1;
    }
  }
  return count;
}

const lit = (frame: RenderedFrame) => {
  let count = 0;
  for (let i = 0; i < frame.pixels.length; i += 4) if ((frame.pixels[i] ?? 0) + (frame.pixels[i + 1] ?? 0) + (frame.pixels[i + 2] ?? 0) > 60) count += 1;
  return count;
};

describe.skipIf(!available)('colour emoji on the GPU', () => {
  beforeAll(async () => {
    await bundleElectron();
  }, 180_000);

  it('a title that asks without the font draws in the text colour and says so', async () => {
    if (existsSync(COLOR_EMOJI_FILE)) return;
    const run = await renderFrames({ name: 'emoji-missing', project: project({ text: '🔥', colorEmoji: true }), frames: [30] });
    expect(run.warnings.join(' ')).toContain('colour emoji are not installed');
    expect(chromatic(run.frames[0]!)).toBe(0);
  }, 180_000);

  it.skipIf(!existsSync(COLOR_EMOJI_FILE))('draws its own colours where asked, and only there', async () => {
    const text = '🔥';
    const [mono, colored, again] = await Promise.all([
      renderFrames({ name: 'emoji-mono', project: project({ text }), frames: [30] }),
      renderFrames({ name: 'emoji-color', project: project({ text, colorEmoji: true }), frames: [30] }),
      renderFrames({ name: 'emoji-color-2', project: project({ text, colorEmoji: true }), frames: [30] }),
    ]);
    expect(colored.warnings).toEqual([]);
    expect(chromatic(mono.frames[0]!)).toBe(0);
    expect(chromatic(colored.frames[0]!)).toBeGreaterThan(500);
    expect(again.frames[0]!.sha256).toBe(colored.frames[0]!.sha256);
  }, 180_000);

  it.skipIf(!existsSync(COLOR_EMOJI_FILE))('leaves letters in the fill colour beside it, across and down', async () => {
    const letters = await renderFrames({ name: 'emoji-letters', project: project({ text: 'ABC', colorEmoji: true, color: '#00ff00' }), frames: [30] });
    const plain = await renderFrames({ name: 'emoji-letters-plain', project: project({ text: 'ABC', color: '#00ff00' }), frames: [30] });
    expect(letters.frames[0]!.sha256).toBe(plain.frames[0]!.sha256);
    const down = await renderFrames({ name: 'emoji-down', project: project({ text: '🔥', colorEmoji: true, direction: 'vertical' }), frames: [30] });
    expect(chromatic(down.frames[0]!)).toBeGreaterThan(500);
  }, 180_000);

  it.skipIf(!existsSync(COLOR_EMOJI_FILE))('stays under the masks: fade, typewriter and depth reach an emoji like a letter', async () => {
    const text = 'A 🔥';
    const [full, typing, depth] = await Promise.all([
      renderFrames({ name: 'emoji-full', project: project({ text, colorEmoji: true }), frames: [30] }),
      renderFrames({ name: 'emoji-typing', project: project({ text, colorEmoji: true, animIn: 'typewriter', animSeconds: 3 }), frames: [30] }),
      renderFrames({ name: 'emoji-depth', project: project({ text, colorEmoji: true, depth: 0.2, depthAngle: 0, depthColor: '#808080' }), frames: [30] }),
    ]);
    // At 0.5 s of 3 s only the first word is in: the emoji, the second word, has not appeared.
    expect(chromatic(typing.frames[0]!)).toBe(0);
    expect(lit(typing.frames[0]!)).toBeGreaterThan(200);
    expect(chromatic(depth.frames[0]!)).toBeGreaterThan(500);
    expect(lit(depth.frames[0]!)).toBeGreaterThan(lit(full.frames[0]!));
  }, 180_000);
});
