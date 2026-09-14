// A deterministic synthetic track for the spike: kicks, a bassline, a chord swell, a
// rising sweep and seeded hi-hats. No audio file needed, identical on every run, and
// it exercises the whole spectrum so the bars actually move.

import { random01 } from '../src/engine/core/prng.ts';
import { ANALYSIS_SAMPLE_RATE } from '../src/analysis/spectrum.ts';

export function synthesizeTestTrack(seconds: number): Float32Array {
  const rate = ANALYSIS_SAMPLE_RATE;
  const pcm = new Float32Array(Math.round(seconds * rate));
  const beat = 0.5; // 120 BPM
  for (let i = 0; i < pcm.length; i++) {
    const t = i / rate;
    const beatPhase = (t % beat) / beat;
    const beatIndex = Math.floor(t / beat);

    const kickEnv = Math.exp(-beatPhase * 18);
    const kick = 0.6 * kickEnv * Math.sin(2 * Math.PI * (50 + 90 * kickEnv) * t);

    const bassNote = [55, 55, 65.41, 49][Math.floor(beatIndex / 4) % 4] ?? 55;
    const bass = 0.25 * Math.sin(2 * Math.PI * bassNote * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * t / 2));

    const swell = 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / 8);
    const chord = 0.06 * swell * ([220, 277.18, 329.63].reduce((sum, f) => sum + Math.sin(2 * Math.PI * f * t), 0));

    const sweepHz = 200 * (40 ** ((t % 5) / 5));
    const sweep = 0.05 * Math.sin(2 * Math.PI * sweepHz * t);

    const hatPhase = ((t + beat / 2) % beat) / beat;
    const hat = hatPhase < 0.08 ? 0.15 * Math.exp(-hatPhase * 60) * (random01(20260914, i) * 2 - 1) : 0;

    pcm[i] = kick + bass + chord + sweep + hat;
  }
  return pcm;
}
