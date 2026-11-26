import { describe, expect, it } from 'vitest';
import { EXPORT_PRESETS, findExportPreset, presetCanvas, suggestedOutputName } from '../../src/export/export-presets.ts';
import { resolveConversion, defaultEncodeSettings } from '../../src/export/ffmpeg-args.ts';

describe('export presets', () => {
  it('have unique ids', () => {
    expect(new Set(EXPORT_PRESETS.map((p) => p.id)).size).toBe(EXPORT_PRESETS.length);
  });

  it('keep every fixed 8-bit size on the GPU NV12 path (D39)', () => {
    for (const preset of EXPORT_PRESETS) {
      if (preset.size === null || preset.codec !== 'h264') continue;
      const settings = resolveConversion(defaultEncodeSettings('h264'), preset.size.width, preset.size.height);
      expect(settings.conversion, preset.id).toBe('gpu-nv12');
    }
  });

  it('render project-size presets at the project canvas', () => {
    const master = findExportPreset('master-hevc10');
    expect(master?.codec).toBe('hevc');
    expect(presetCanvas(master!, { width: 1280, height: 720 })).toEqual({ width: 1280, height: 720 });
    expect(presetCanvas(findExportPreset('shorts')!, { width: 1280, height: 720 })).toEqual({ width: 1080, height: 1920 });
  });

  it('suggest a filename Windows will accept', () => {
    expect(suggestedOutputName('My: Song / "Live"?', findExportPreset('square')!)).toBe('My Song  Live - square.mp4');
    expect(suggestedOutputName('  ', findExportPreset('square')!)).toBe('Untitled - square.mp4');
  });
});
