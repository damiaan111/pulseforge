// core.text.lyrics on the real GPU (M20, lyrics-spec §6): the karaoke wipe fills left to right in
// the "being sung" colour, a finished line is all "sung", the next line previews dimmer below, every
// fill mode draws and differs, and the whole thing is deterministic across runs and render order.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import type { RenderLyrics } from '../../src/engine/core/lyrics.ts';
import type { RenderProject } from '../../src/engine/core/project.ts';
import { rational } from '../../src/engine/core/time.ts';
import { DEFAULT_FONT_FILE } from '../../setup/lib/paths.ts';
import { bundleElectron } from '../../spike/harness.ts';
import { renderFrames, type RenderedFrame } from '../../spike/lib/frames-run.ts';

const ELECTRON = resolve(import.meta.dirname, '..', '..', 'node_modules', 'electron', 'dist', 'electron.exe');
const available = existsSync(ELECTRON) && existsSync(DEFAULT_FONT_FILE);
const T = (s: number) => Math.round(s * 48_000);

const LYRICS: RenderLyrics = {
  lines: [
    {
      id: 'l1', text: 'Hello bright world', startTicks: T(1), endTicks: T(3), role: 'lead', style: null,
      words: [{ startTicks: T(1), endTicks: T(1.5) }, { startTicks: T(1.5), endTicks: T(2.2) }, { startTicks: T(2.2), endTicks: T(3) }],
    },
    { id: 'l2', text: 'Second line here', startTicks: T(3), endTicks: T(5), role: 'lead', style: null, words: [] },
  ],
  untimedLines: 0,
};

function project(params: Record<string, unknown> = {}, lyrics: RenderLyrics | null = LYRICS): RenderProject {
  return {
    schemaVersion: 0,
    seed: 3,
    durationTicks: T(6),
    canvas: { width: 640, height: 360, fps: rational(60), background: '#000000' },
    audio: { leadInTicks: 0, clipInTicks: 0 },
    layers: [{ id: 'ly', module: 'core.text.lyrics', enabled: true, opacity: 1, blend: 'normal', params: { shadow: 0, ...params } }],
    ...(lyrics === null ? {} : { lyrics }),
  };
}

type Kind = 'pink' | 'white' | 'dim' | 'dark';
function kind(frame: RenderedFrame, x: number, y: number): Kind {
  const { r, g, b } = frame.at(x, y);
  if (r > 180 && g < 120 && b > 80 && b < 220) return 'pink';
  if (r > 200 && g > 200 && b > 200) return 'white';
  if (r + g + b > 60) return 'dim';
  return 'dark';
}

/** The kinds of lit pixel in a band of rows, left to right, collapsed to runs of the same kind. */
function runs(frame: RenderedFrame, y0: number, y1: number): Kind[] {
  const columns: Kind[] = [];
  for (let x = 0; x < frame.width; x += 1) {
    let found: Kind = 'dark';
    for (let y = y0; y < y1 && found === 'dark'; y += 1) {
      const k = kind(frame, x, y);
      if (k === 'pink' || k === 'white') found = k;
    }
    if (found !== 'dark') columns.push(found);
  }
  return columns.filter((k, i) => i === 0 || columns[i - 1] !== k);
}

function count(frame: RenderedFrame, which: Kind, y0 = 0, y1 = frame.height): number {
  let n = 0;
  for (let y = y0; y < y1; y += 1) for (let x = 0; x < frame.width; x += 1) if (kind(frame, x, y) === which) n += 1;
  return n;
}

describe.skipIf(!available)('lyrics layer on the GPU', () => {
  beforeAll(async () => {
    await bundleElectron();
  }, 180_000);

  it('wipes left to right: sung on the left, still to come on the right; all sung at the end', async () => {
    // Frame 20 (0.33 s) is before the 0.6 s lead-in; 120 is 2.0 s, "bright" 71 % through.
    const run = await renderFrames({ name: 'lyrics-wipe', project: project(), frames: [20, 120] });
    expect(run.warnings).toEqual([]);
    const [before, mid] = run.frames as [RenderedFrame, RenderedFrame];
    // Frame 185 (3.08 s) is in the hold-out of a line on its own: every word sung, nothing next.
    const alone = await renderFrames({ name: 'lyrics-wipe-end', project: project({}, { lines: [LYRICS.lines[0]!], untimedLines: 0 }), frames: [185] });
    const end = alone.frames[0] as RenderedFrame;
    expect(count(before, 'white') + count(before, 'pink')).toBe(0);

    // The current line sits at the centre; only its band is read.
    const band = [150, 190] as const;
    expect(runs(mid, ...band)).toEqual(['pink', 'white']);
    expect(count(mid, 'pink', ...band)).toBeGreaterThan(200);
    expect(count(end, 'white', ...band)).toBe(0);
    expect(count(end, 'pink', ...band)).toBeGreaterThan(count(mid, 'pink', ...band));
    // The next line previews below, dimmer: lit but never full white.
    expect(count(mid, 'dim', 200, 260)).toBeGreaterThan(100);
    expect(count(mid, 'white', 200, 260)).toBe(0);
  }, 180_000);

  it('wipes a right-to-left line from the right (S17), by word and by row', async () => {
    const hebrew: RenderLyrics = {
      lines: [{
        id: 'l1', text: 'שלום עולם יפה', startTicks: T(1), endTicks: T(3), role: 'lead', style: null,
        words: [{ startTicks: T(1), endTicks: T(1.6) }, { startTicks: T(1.6), endTicks: T(2.3) }, { startTicks: T(2.3), endTicks: T(3) }],
      }],
      untimedLines: 0,
    };
    for (const fillMode of ['wipe', 'gradientSweep']) {
      const run = await renderFrames({ name: `lyrics-rtl-${fillMode}`, project: project({ fill: fillMode }, hebrew), frames: [114, 200] });
      const middle = run.frames.find((f) => f.frameIndex === 114) as RenderedFrame;
      const sequence = runs(middle, 100, 260);
      expect(run.warnings, fillMode).toEqual([]);
      // Read from the left of the screen: still to come, then sung.
      expect(sequence.indexOf('white'), fillMode).toBeLessThan(sequence.lastIndexOf('pink'));
      expect(sequence[sequence.length - 1], fillMode).toBe('pink');
      expect(sequence[0], fillMode).toBe('white');
    }
  }, 180_000);

  it('agrees with the canvas on where words land in a mixed line (S17)', async () => {
    // Drawn as "world 123 שלום": once 123 has started, world alone on the left is still to come.
    const mixed: RenderLyrics = {
      lines: [{
        id: 'l1', text: 'שלום 123 world', startTicks: T(1), endTicks: T(3), role: 'lead', style: null,
        words: [{ startTicks: T(1), endTicks: T(1.5) }, { startTicks: T(1.5), endTicks: T(2.5) }, { startTicks: T(2.5), endTicks: T(3) }],
      }],
      untimedLines: 0,
    };
    const run = await renderFrames({ name: 'lyrics-mixed', project: project({ fill: 'wordSwap' }, mixed), frames: [120] });
    expect(runs(run.frames[0] as RenderedFrame, 100, 260)).toEqual(['white', 'pink']);
  }, 180_000);

  it('draws every fill mode, each differently, and "none" never in the sung colour', async () => {
    const modes = ['wipe', 'wordSwap', 'wordPop', 'fillStroke', 'gradientSweep', 'bouncingBall', 'none'];
    const hashes: string[] = [];
    for (const fill of modes) {
      const run = await renderFrames({ name: `lyrics-fill-${fill}`, project: project({ fill }), frames: [120] });
      expect(run.warnings, fill).toEqual([]);
      const frame = run.frames[0] as RenderedFrame;
      expect(count(frame, 'white') + count(frame, 'pink'), fill).toBeGreaterThan(300);
      if (fill === 'none') expect(count(frame, 'pink')).toBe(0);
      hashes.push(frame.sha256);
    }
    expect(new Set(hashes).size).toBe(modes.length);
  }, 400_000);

  it('is deterministic across runs and render order', async () => {
    const params = { fill: 'wordPop', glow: 0.6, plate: true, animIn: 'typewriter' };
    const a = await renderFrames({ name: 'lyrics-det-a', project: project(params), frames: [40, 120, 185, 250] });
    const b = await renderFrames({ name: 'lyrics-det-b', project: project(params), frames: [250, 185, 120, 40] });
    expect(a.frames.map((f) => f.sha256)).toEqual([...b.frames].reverse().map((f) => f.sha256));
  }, 180_000);

  it('says so when the project has no lyrics', async () => {
    const run = await renderFrames({ name: 'lyrics-none', project: project({}, null), frames: [60] });
    expect(run.warnings.some((w) => w.includes('no lyrics yet'))).toBe(true);
  }, 180_000);
});
