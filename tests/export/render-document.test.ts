import { describe, expect, it } from 'vitest';
import { RenderDocumentError, canvasForAspect, parseProgress } from '../../src/export/render-document.ts';

describe('parseProgress', () => {
  it('reports the encoded count, not the read-back count (export-spec §13)', () => {
    expect(parseProgress('frames read back 282/300, encoded 200')).toEqual({ encoded: 200, total: 300 });
  });

  it('ignores lines that are not progress', () => {
    expect(parseProgress('Decoding song.wav')).toBeUndefined();
    expect(parseProgress('version 1/2')).toBeUndefined();
  });
});

describe('canvasForAspect (shared by the CLI and the studio)', () => {
  it('keeps the pixel count and even dimensions', () => {
    const size = canvasForAspect('9:16', { width: 1920, height: 1080 });
    expect(size.width % 2).toBe(0);
    expect(size.height % 2).toBe(0);
    expect(size.height).toBeGreaterThan(size.width);
    expect(Math.abs(size.width * size.height - 1920 * 1080) / (1920 * 1080)).toBeLessThan(0.01);
  });

  it('refuses an unknown aspect with the choices', () => {
    expect(() => canvasForAspect('21:9', { width: 1920, height: 1080 })).toThrow(RenderDocumentError);
  });
});
