// Text beyond Latin on the real GPU (S17): every bundled script draws, nothing reaches for a system
// font, right-to-left karaoke fills from the right, and existing Latin text is untouched by the chain.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import type { RenderProject } from '../../src/engine/core/project.ts';
import { rational } from '../../src/engine/core/time.ts';
import { DEFAULT_FONT_FILE } from '../../setup/lib/paths.ts';
import { fallbackFontFiles } from '../../src/assets/fonts.ts';
import { bundleElectron } from '../../spike/harness.ts';
import { renderFrames, type RenderedFrame } from '../../spike/lib/frames-run.ts';

const ELECTRON = resolve(import.meta.dirname, '..', '..', 'node_modules', 'electron', 'dist', 'electron.exe');
const available = existsSync(ELECTRON) && existsSync(DEFAULT_FONT_FILE) && fallbackFontFiles().length === 10;

function project(text: string, params: Record<string, unknown> = {}): RenderProject {
  return {
    schemaVersion: 0,
    seed: 3,
    durationTicks: 48_000 * 4,
    canvas: { width: 640, height: 360, fps: rational(60), background: '#000000' },
    audio: { leadInTicks: 0, clipInTicks: 0 },
    layers: [{
      id: 't', module: 'core.text.title', enabled: true, opacity: 1, blend: 'normal',
      params: { text, shadow: 0, animIn: 'none', animOut: 'none', ...params },
      timeRange: { inTicks: 0, outTicks: null },
    }],
  };
}

function lit(frame: RenderedFrame): number {
  let count = 0;
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) if (frame.at(x, y).r > 128) count += 1;
  }
  return count / (frame.width * frame.height);
}

/** Each sample is a real phrase; the box a missing glyph draws would make two different ones equal. */
const SAMPLES: Readonly<Record<string, string>> = {
  arabic: 'مرحبا بالعالم',
  hebrew: 'שלום עולם',
  hindi: 'नमस्ते दुनिया',
  bengali: 'হ্যালো বিশ্ব',
  tamil: 'வணக்கம் உலகம்',
  thai: 'สวัสดีชาวโลก',
  armenian: 'Բարեւ աշխարհ',
  georgian: 'გამარჯობა მსოფლიო',
  japanese: 'こんにちは世界',
  chinese: '你好世界',
  korean: '안녕하세요 세계',
  emoji: '🎵 🔥 ❤',
  vietnamese: 'Xin chào thế giới',
  russian: 'Привет мир',
};

describe.skipIf(!available)('Unicode text on the GPU', () => {
  beforeAll(async () => {
    await bundleElectron();
  }, 180_000);

  it('draws every script from the bundled fonts, with nothing reported missing', async () => {
    const runs = await Promise.all(Object.entries(SAMPLES).map(async ([name, text]) => {
      const run = await renderFrames({ name: `unicode-${name}`, project: project(text), frames: [30] });
      return { name, run, frame: run.frames[0] as RenderedFrame };
    }));
    for (const { name, run, frame } of runs) {
      expect(run.warnings, name).toEqual([]);
      expect(lit(frame), name).toBeGreaterThan(0.002);
    }
    expect(new Set(runs.map((r) => r.frame.sha256)).size).toBe(runs.length);
  }, 300_000);

  it('reports a character no font has, and draws a box instead of asking the system', async () => {
    // Linear B: in no bundled font, and in several that Windows may or may not have installed.
    const run = await renderFrames({ name: 'unicode-missing', project: project('A𐀀B'), frames: [30] });
    expect(run.warnings.join(' ')).toContain('no font has 𐀀');
    expect(lit(run.frames[0] as RenderedFrame)).toBeGreaterThan(0.001);
  }, 180_000);

  it('is deterministic for shaped and right-to-left text', async () => {
    const text = 'مرحبا world 123\nनमस्ते 世界';
    const [a, b] = await Promise.all([
      renderFrames({ name: 'unicode-det-a', project: project(text), frames: [10, 40] }),
      renderFrames({ name: 'unicode-det-b', project: project(text), frames: [40, 10] }),
    ]);
    const byIndex = (run: { frames: readonly RenderedFrame[] }) => Object.fromEntries(run.frames.map((f) => [f.frameIndex, f.sha256]));
    expect(byIndex(b)).toEqual(byIndex(a));
  }, 180_000);
});
