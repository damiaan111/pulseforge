// What MilkDrop is fed, and how a preset becomes a script. The rendering is in
// tests/golden/milkdrop-gpu.test.ts.

import { describe, expect, it } from 'vitest';

import { analyzeMix, resampleWaveform } from '../../src/analysis/analyze.ts';
import { MILKDROP_SAMPLES, WAVEFORM_RATE } from '../../src/engine/core/milkdrop.ts';
import { waveformBytes } from '../../src/engine/modules/milkdrop.ts';
import { presetScript } from '../../setup/steps/milkdrop.ts';

const track = (data: Float32Array) => ({ rate: WAVEFORM_RATE, channels: 1, data });

describe('the waveform track', () => {
  it('keeps the length of the song', () => {
    expect(resampleWaveform(new Float32Array(48_000)).length).toBe(WAVEFORM_RATE);
  });

  it('keeps a slow tone, and averages what it covers', () => {
    expect([...resampleWaveform(new Float32Array(48).fill(0.5)).slice(0, 4)]).toEqual([0.5, 0.5, 0.5, 0.5]);
    const alternating = Float32Array.from({ length: 4800 }, (_, i) => (i % 2 === 0 ? 1 : -1));
    expect(Math.max(...resampleWaveform(alternating).map(Math.abs))).toBeLessThan(0.5);
  });

  it('comes out of the analysis, at its own rate', () => {
    const waveform = analyzeMix(new Float32Array(48_000)).analysis.sources.get('mix')?.features.get('waveform');
    expect(waveform?.rate).toBe(WAVEFORM_RATE);
    expect(waveform?.data.length).toBe(WAVEFORM_RATE);
  });
});

describe('the samples a frame hears', () => {
  const out = new Uint8Array(MILKDROP_SAMPLES);

  it('are the ones just before its time, as bytes around 128', () => {
    const data = new Float32Array(WAVEFORM_RATE).fill(0);
    data[WAVEFORM_RATE - 1] = 1;
    data[WAVEFORM_RATE - 2] = -1;
    waveformBytes(track(data), 1, out);
    expect(out[MILKDROP_SAMPLES - 1]).toBe(255);
    expect(out[MILKDROP_SAMPLES - 2]).toBe(1);
    expect(out[0]).toBe(128);
  });

  it('are silence before the song, after it, and with no track', () => {
    expect(new Set(waveformBytes(track(new Float32Array(100).fill(1)), -1, out))).toEqual(new Set([128]));
    expect(new Set(waveformBytes(undefined, 1, out))).toEqual(new Set([128]));
  });

  it('are clamped, not wrapped', () => {
    waveformBytes(track(new Float32Array(WAVEFORM_RATE).fill(3)), 1, out);
    expect(out[MILKDROP_SAMPLES - 1]).toBe(255);
  });
});

describe('a preset as a script', () => {
  const preset = {
    baseVals: { decay: 0.9 },
    init_eqs_str: 'a.x=1;',
    frame_eqs_str: 'a.y=a.x+1;',
    pixel_eqs_str: '',
    warp: 'shader',
    comp: '',
    shapes: [{ baseVals: { enabled: 1 }, init_eqs_str: 'a.s=2;', frame_eqs_str: '' }],
    waves: [{ baseVals: { enabled: 1 }, init_eqs_str: '', frame_eqs_str: '', point_eqs_str: 'a.p=3;' }, { baseVals: {} }],
  };
  type Compiled = {
    init_eqs(a: Record<string, number>): Record<string, number>;
    frame_eqs(a: Record<string, number>): Record<string, number>;
    pixel_eqs: unknown;
    warp: string;
    baseVals: unknown;
    init_eqs_str?: string;
    shapes: { init_eqs(a: Record<string, number>): Record<string, number>; init_eqs_str?: string }[];
    waves: { point_eqs: ((a: Record<string, number>) => Record<string, number>) | string }[];
  };
  const run = (): Compiled => {
    const table: { __pfMilkdrop?: Record<string, Compiled> } = {};
    new Function('globalThis', presetScript('A "quoted" name', preset))(table);
    return table.__pfMilkdrop?.['A "quoted" name'] as Compiled;
  };

  it('turns equations into real functions, so nothing needs compiling at run time', () => {
    const compiled = run();
    expect(compiled.init_eqs({}).x).toBe(1);
    expect(compiled.frame_eqs({ x: 4 }).y).toBe(5);
    expect(compiled.shapes[0]?.init_eqs({}).s).toBe(2);
    expect((compiled.waves[0]?.point_eqs as (a: Record<string, number>) => Record<string, number>)({}).p).toBe(3);
  });

  it('keeps the rest, and drops the source strings', () => {
    const compiled = run();
    expect(compiled.baseVals).toEqual({ decay: 0.9 });
    expect(compiled.warp).toBe('shader');
    expect(compiled.init_eqs_str).toBeUndefined();
    expect(compiled.shapes[0]?.init_eqs_str).toBeUndefined();
  });

  it('marks empty pixel and point equations as Butterchurn expects', () => {
    const compiled = run();
    expect(compiled.pixel_eqs).toBe('');
    expect(compiled.waves[1]?.point_eqs).toBe('');
  });
});
