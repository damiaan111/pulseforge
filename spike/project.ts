import type { RenderProject } from '../src/engine/core/project.ts';
import { rational } from '../src/engine/core/time.ts';

/** The P0 test project: one bar visualizer on a dark field (the neon target look, minus the glow). */
export function spikeProject(width: number, height: number): RenderProject {
  return {
    schemaVersion: 0,
    seed: 1337,
    canvas: { width, height, fps: rational(60), background: '#0b0614' },
    audio: { leadInTicks: 0, clipInTicks: 0 },
    layers: [
      {
        id: 'layer-bars',
        module: 'core.visualizer.bars',
        enabled: true,
        opacity: 1,
        blend: 'normal',
        params: { source: 'mix', barCount: 64, barWidth: 0.72, fill: '#ff2d95' },
      },
    ],
  };
}
