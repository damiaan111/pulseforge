// The render CLI's pure parts: argument handling and aspect sizing.
//
// The render itself needs Electron and a GPU and is exercised by hand and by `npm run golden`;
// what is worth testing here is that a mistyped flag produces a sentence a person can act on
// rather than a stack trace, which PROJECT.md §14 calls out as a requirement, not a nicety.

import { basename } from 'node:path';
import { describe, expect, it } from 'vitest';

import { canvasForAspect, parseArgs, type CliError } from '../../src/cli/render.ts';

const base = ['project.pvproj', '-o', 'out.mp4'];

describe('parseArgs', () => {
  it('reads the project, the output and the defaults', () => {
    const options = parseArgs(base);
    expect(basename(options.projectPath)).toBe('project.pvproj');
    expect(basename(options.outputPath)).toBe('out.mp4');
    expect(options.codec).toBe('h264');
    expect(options.aspect).toBeUndefined();
    expect(options.size).toBeUndefined();
    expect(options.quiet).toBe(false);
  });

  it('accepts the long form of the output flag', () => {
    expect(basename(parseArgs(['p.pvproj', '--out', 'v.mp4']).outputPath)).toBe('v.mp4');
  });

  it('parses a size, an aspect, a codec and a duration', () => {
    const options = parseArgs([...base, '--size', '1920x1080', '--aspect', '9:16', '--codec', 'hevc', '--seconds', '12.5', '--quiet']);
    expect(options.size).toEqual({ width: 1920, height: 1080 });
    expect(options.aspect).toBe('9:16');
    expect(options.codec).toBe('hevc');
    expect(options.seconds).toBe(12.5);
    expect(options.quiet).toBe(true);
  });

  it('says what to do when the project or output is missing', () => {
    expect(() => parseArgs([])).toThrow(/No project file given/);
    expect(() => parseArgs(['p.pvproj'])).toThrow(/No output file given/);
    try {
      parseArgs([]);
    } catch (error) {
      expect((error as CliError).fixes.join(' ')).toContain('npm run render');
    }
  });

  it('names the codecs that exist rather than failing at render time', () => {
    // AV1 encode does not exist on Ampere (PROJECT.md §4), so it has to be refused up front.
    try {
      parseArgs([...base, '--codec', 'av1']);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as CliError).message).toContain('av1');
      expect((error as CliError).fixes.join(' ')).toContain('h264');
    }
  });

  it('rejects a malformed size and a nonsense duration', () => {
    expect(() => parseArgs([...base, '--size', 'big'])).toThrow(/looks like 1920x1080|look like 1920x1080/);
    expect(() => parseArgs([...base, '--seconds', 'soon'])).toThrow(/positive number/);
  });

  it('rejects a flag with no value instead of swallowing the next flag', () => {
    expect(() => parseArgs(['p.pvproj', '-o', '--codec', 'hevc'])).toThrow(/needs a value/);
  });

  it('treats a negative number as a value, not as a flag', () => {
    // Nothing takes a negative value today, but a leading "-" must not make "-30" a flag —
    // that is a trap that only surfaces when the first such option is added.
    // It reaches validation (which rejects it) rather than dying at "--seconds needs a value".
    expect(() => parseArgs([...base, '--seconds', '-3'])).toThrow(/positive number/);
    // And a negative value is carried through for an option that does not validate the sign.
    expect(parseArgs([...base, '--aspect', '-1']).aspect).toBe('-1');
  });
});

describe('canvasForAspect', () => {
  it('keeps roughly the pixel count while changing the shape', () => {
    const from1080p = canvasForAspect('9:16', { width: 1920, height: 1080 });
    expect(from1080p.width / from1080p.height).toBeCloseTo(9 / 16, 2);
    const pixels = from1080p.width * from1080p.height;
    expect(pixels).toBeGreaterThan(1920 * 1080 * 0.95);
    expect(pixels).toBeLessThan(1920 * 1080 * 1.05);
  });

  it('always returns even dimensions, because 4:2:0 cannot encode an odd one', () => {
    for (const aspect of ['16:9', '9:16', '1:1', '4:5']) {
      const size = canvasForAspect(aspect, { width: 1280, height: 720 });
      expect(size.width % 2).toBe(0);
      expect(size.height % 2).toBe(0);
    }
  });

  it('lists the aspects it knows when given one it does not', () => {
    try {
      canvasForAspect('21:9', { width: 1920, height: 1080 });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as CliError).fixes.join(' ')).toContain('16:9');
      expect((error as CliError).fixes.join(' ')).toContain('--size');
    }
  });
});
