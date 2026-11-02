import { describe, expect, it } from 'vitest';

import { buildFfmpegArgs, encodeSettingsFor, settingsProblems, videotoolboxQuality, type EncodeJob, type EncodeSettings } from '../../src/export/ffmpeg-args.ts';

// The Mac's encoder (VideoToolbox). Pure argument building, so it runs on every system.

const job = (settings: EncodeSettings): EncodeJob => ({
  width: 1920,
  height: 1080,
  fps: { num: 60, den: 1 },
  settings,
  audioPath: undefined,
  outputPath: 'out.mp4',
  bitexact: false,
});

const after = (args: readonly string[], flag: string) => args[args.indexOf(flag) + 1];

describe('VideoToolbox arguments', () => {
  it('encodes H.264 on the hardware at a constant quality, never on Apple\'s software fallback', () => {
    const args = buildFfmpegArgs(job({ ...encodeSettingsFor('h264'), encoder: 'videotoolbox' }));
    expect(after(args, '-c:v')).toBe('h264_videotoolbox');
    expect(after(args, '-allow_sw')).toBe('0');
    expect(after(args, '-q:v')).toBe('66');
    expect(after(args, '-profile:v')).toBe('high');
    expect(args).not.toContain('-cq');
    expect(args).not.toContain('-preset');
  });

  it('encodes the 10-bit HEVC master as main10, tagged for Apple players', () => {
    const args = buildFfmpegArgs(job({ ...encodeSettingsFor('hevc'), encoder: 'videotoolbox' }));
    expect(after(args, '-c:v')).toBe('hevc_videotoolbox');
    expect(after(args, '-profile:v')).toBe('main10');
    expect(after(args, '-tag:v')).toBe('hvc1');
  });

  it('takes the file-size ceiling as its rate, since its quality mode has no maximum', () => {
    const args = buildFfmpegArgs(job({ ...encodeSettingsFor('h264', 'balanced'), encoder: 'videotoolbox' }));
    expect(after(args, '-b:v')).toBe(String(Math.round(1920 * 1080 * 60 * 0.16)));
    expect(args).not.toContain('-q:v');
  });

  it('maps quality the opposite way to CQ, within its 1–100 scale', () => {
    expect(videotoolboxQuality(17)).toBe(66);
    expect(videotoolboxQuality(19)).toBe(62);
    expect(videotoolboxQuality(27)).toBeLessThan(videotoolboxQuality(17));
    expect(videotoolboxQuality(0)).toBe(100);
    expect(videotoolboxQuality(51)).toBe(1);
  });

  it('refuses 4:4:4, and has no NVENC minimum size', () => {
    const settings: EncodeSettings = { ...encodeSettingsFor('h264'), chroma: '444', conversion: 'swscale', encoder: 'videotoolbox' };
    expect(settingsProblems(settings, 1920, 1080).join(' ')).toMatch(/4:2:0 only/);
    expect(settingsProblems({ ...encodeSettingsFor('h264'), encoder: 'videotoolbox' }, 128, 48)).toEqual([]);
  });
});
