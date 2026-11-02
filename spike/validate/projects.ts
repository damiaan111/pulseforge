// Test projects and signals for the validation checks.

import type { RenderProject } from '../../src/engine/core/project.ts';
import { rational } from '../../src/engine/core/time.ts';

function base(width: number, height: number, layers: RenderProject['layers'], background = '#0b0614'): RenderProject {
  return {
    schemaVersion: 0,
    seed: 1337,
    canvas: { width, height, fps: rational(60), background },
    audio: { leadInTicks: 0, clipInTicks: 0 },
    layers,
  };
}

export function patternProject(width: number, height: number): RenderProject {
  return base(width, height, [{ id: 'pattern', module: 'core.test.pattern', enabled: true, opacity: 1, blend: 'normal', params: {} }], '#000000');
}

/** First click deliberately between frames (1.01 s = frame 60.6), so each flash must round up to frame 61, 121, … */
export const CLICK_SCHEDULE = { first: 1.01, period: 0.5, duration: 0.05 };

export function clickProject(width: number, height: number): RenderProject {
  return base(
    width,
    height,
    [{ id: 'flash', module: 'core.test.flash', enabled: true, opacity: 1, blend: 'normal', params: { firstSeconds: CLICK_SCHEDULE.first, periodSeconds: CLICK_SCHEDULE.period, durationSeconds: CLICK_SCHEDULE.duration } }],
    '#000000',
  );
}

/**
 * A heavier stand-in until effects exist: six bars layers over the full frame with add/screen blends.
 * Still cheap in shader terms — throughput here bounds the pipeline, not a real neon project.
 */
export function heavyProject(width: number, height: number): RenderProject {
  const colors = ['#ff2d95', '#22d3ee', '#a855f7', '#f59e0b', '#10b981', '#f43f5e'];
  return base(
    width,
    height,
    colors.map((fill, i) => ({
      id: `bars-${i}`,
      module: 'core.visualizer.bars',
      enabled: true,
      opacity: 0.85,
      blend: i === 0 ? 'normal' : i % 2 === 0 ? 'add' : 'screen',
      params: { barCount: 32 + i * 32, barWidth: 0.6, baseline: 0.3 + i * 0.12, maxHeight: 0.35, fill },
    })),
  );
}

/** Stereo clicks (5 ms bursts) at the flash schedule, at 48 kHz. */
export function clickTrack(seconds: number): [Float32Array, Float32Array] {
  const rate = 48_000;
  const left = new Float32Array(Math.round(seconds * rate));
  for (let t = CLICK_SCHEDULE.first; t < seconds; t += CLICK_SCHEDULE.period) {
    const start = Math.round(t * rate);
    for (let i = 0; i < 240 && start + i < left.length; i++) left[start + i] = i % 2 === 0 ? 0.8 : -0.8;
  }
  return [left, Float32Array.from(left)];
}

export function clickTimes(seconds: number): number[] {
  const times: number[] = [];
  for (let t = CLICK_SCHEDULE.first; t < seconds; t += CLICK_SCHEDULE.period) times.push(Math.round(t * 48_000) / 48_000);
  return times;
}
