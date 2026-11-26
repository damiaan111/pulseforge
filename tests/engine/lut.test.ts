// .cube LUTs (S11): 3D and 1D tables parse, the domain is honoured, problems name their line, and
// the CPU lookup (the reference the GPU test compares against) is exact on the grid.

import { describe, expect, it } from 'vitest';

import { CubeParseError, applyLut, parseCube } from '../../src/engine/core/lut.ts';

/** A 2-point 3D LUT that inverts: out = 1 - in, per channel. */
function invert3d(): string {
  const rows: string[] = [];
  for (let b = 0; b < 2; b += 1) for (let g = 0; g < 2; g += 1) for (let r = 0; r < 2; r += 1) rows.push(`${1 - r} ${1 - g} ${1 - b}`);
  return `# a comment\nTITLE "Invert"\nLUT_3D_SIZE 2\n\n${rows.join('\n')}\n`;
}

describe('parseCube', () => {
  it('reads a 3D table with its title, red varying fastest', () => {
    const lut = parseCube(invert3d());
    expect(lut).toMatchObject({ title: 'Invert', size: 2, description: '3D, 2 points' });
    expect(Array.from(lut.data.slice(0, 6))).toEqual([1, 1, 1, 0, 1, 1]);
    expect(applyLut(lut, [0.25, 0.5, 1])).toEqual([0.75, 0.5, 0]);
  });

  it('expands a 1D table to 3D: each channel through its own curve', () => {
    const lut = parseCube('LUT_1D_SIZE 3\n0 0 0\n0.25 0.5 1\n1 1 1\n');
    expect(lut.description).toBe('1D, 3 points (as 3D, 33)');
    const [r, g, b] = applyLut(lut, [0.5, 0.5, 0.5]);
    expect(r).toBeCloseTo(0.25, 6);
    expect(g).toBeCloseTo(0.5, 6);
    expect(b).toBeCloseTo(1, 6);
  });

  it('honours DOMAIN_MIN/MAX and the older input-range form', () => {
    const lut = parseCube(invert3d().replace('LUT_3D_SIZE 2', 'LUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 2 2 2'));
    expect(applyLut(lut, [1, 1, 1])).toEqual([0.5, 0.5, 0.5]);
    expect(parseCube(invert3d().replace('LUT_3D_SIZE 2', 'LUT_3D_SIZE 2\nLUT_3D_INPUT_RANGE 0 4')).domainMax).toEqual([4, 4, 4]);
  });

  it('says what is wrong, and where', () => {
    expect(() => parseCube('hello')).toThrow(CubeParseError);
    expect(() => parseCube('LUT_3D_SIZE 2\n1 0 0\n')).toThrow(/needs 8 rows, the file has 1/);
    expect(() => parseCube('LUT_3D_SIZE 2\n1 0\n')).toThrow(/line 2: a table row must be three numbers/);
    expect(() => parseCube('LUT_3D_SIZE 1000\n')).toThrow(/line 1: LUT_3D_SIZE/);
    expect(() => parseCube('LUT_1D_SIZE 2\nLUT_3D_SIZE 2\n')).toThrow(/both/);
    expect(() => parseCube(`${invert3d()}DOMAIN_MAX 0 0 0\n`)).toThrow(/DOMAIN_MAX/);
  });
});
