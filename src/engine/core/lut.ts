// Colour look-up tables (S11, PROJECT.md §8 "LUT support"): the `.cube` format Resolve, Premiere,
// After Effects and every LUT pack write.
//
// Pure: a parser from text to a 3D table, used by the studio (from IPC text), the export child
// (from the file) and the tests alike, so every renderer applies the same numbers. A 1D LUT is
// expanded to a 3D one (each channel through its own curve), so the engine has one kind of table
// and one shader. Every problem is reported with its line — a LUT that silently half-loaded would
// be a grade nobody asked for.

export interface Lut3D {
  readonly title: string;
  /** Points per axis. */
  readonly size: number;
  readonly domainMin: readonly [number, number, number];
  readonly domainMax: readonly [number, number, number];
  /** size³ RGB triples, red varying fastest (the .cube order). */
  readonly data: Float32Array;
  /** What the file was, for the inspector: "3D, 33 points" or "1D, 1024 points (as 3D, 33)". */
  readonly description: string;
}

/** A LUT asset in the render project (S11): its content hash names the table the host registered. */
export interface LutAssetRef {
  readonly kind: 'lut';
  readonly hash: string;
  readonly name: string;
}

export class CubeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CubeParseError';
  }
}

/** The largest table accepted: 129³ is ~2.1 M entries, beyond any LUT in use. */
export const MAX_LUT_3D_SIZE = 129;
const MAX_LUT_1D_SIZE = 65_536;
/** The size a 1D LUT is expanded to; its curves are sampled exactly at these points. */
const EXPANDED_1D_SIZE = 33;

export function parseCube(text: string): Lut3D {
  let title = '';
  let size3d = 0;
  let size1d = 0;
  let domainMin: [number, number, number] = [0, 0, 0];
  let domainMax: [number, number, number] = [1, 1, 1];
  const values: number[] = [];
  const lines = text.split(/\r?\n/);

  for (const [index, raw] of lines.entries()) {
    const at = `line ${index + 1}`;
    const line = raw.replace(/#.*$/, '').trim();
    if (line === '') continue;
    const words = line.split(/\s+/);
    const keyword = (words[0] as string).toUpperCase();
    const numbers = (from: number, count: number): number[] => {
      const out = words.slice(from, from + count).map(Number);
      if (out.length !== count || out.some((n) => !Number.isFinite(n))) throw new CubeParseError(`${at}: expected ${count} numbers after ${keyword}`);
      return out;
    };
    if (keyword === 'TITLE') {
      title = line.slice(5).trim().replace(/^"(.*)"$/, '$1');
    } else if (keyword === 'LUT_3D_SIZE') {
      size3d = numbers(1, 1)[0] as number;
      if (!Number.isInteger(size3d) || size3d < 2 || size3d > MAX_LUT_3D_SIZE) throw new CubeParseError(`${at}: LUT_3D_SIZE must be a whole number from 2 to ${MAX_LUT_3D_SIZE}`);
    } else if (keyword === 'LUT_1D_SIZE') {
      size1d = numbers(1, 1)[0] as number;
      if (!Number.isInteger(size1d) || size1d < 2 || size1d > MAX_LUT_1D_SIZE) throw new CubeParseError(`${at}: LUT_1D_SIZE must be a whole number from 2 to ${MAX_LUT_1D_SIZE}`);
    } else if (keyword === 'DOMAIN_MIN') {
      domainMin = numbers(1, 3) as [number, number, number];
    } else if (keyword === 'DOMAIN_MAX') {
      domainMax = numbers(1, 3) as [number, number, number];
    } else if (keyword === 'LUT_1D_INPUT_RANGE' || keyword === 'LUT_3D_INPUT_RANGE') {
      // The older form of the domain: one range for all three channels.
      const [lo, hi] = numbers(1, 2) as [number, number];
      domainMin = [lo, lo, lo];
      domainMax = [hi, hi, hi];
    } else if (/^[-+.\d]/.test(keyword)) {
      const triple = words.map(Number);
      if (triple.length !== 3 || triple.some((n) => !Number.isFinite(n))) throw new CubeParseError(`${at}: a table row must be three numbers, got "${line}"`);
      values.push(...triple);
    } else {
      // Unknown keywords (vendor extensions) are allowed by the format and carry no table data.
    }
  }

  if (size3d > 0 && size1d > 0) throw new CubeParseError('the file declares both LUT_1D_SIZE and LUT_3D_SIZE');
  if (size3d === 0 && size1d === 0) throw new CubeParseError('no LUT_3D_SIZE or LUT_1D_SIZE line: this is not a .cube LUT');
  for (let c = 0; c < 3; c += 1) {
    if (!((domainMax[c] as number) > (domainMin[c] as number))) throw new CubeParseError('DOMAIN_MAX must be above DOMAIN_MIN on every channel');
  }

  if (size3d > 0) {
    const expected = size3d ** 3;
    if (values.length !== expected * 3) throw new CubeParseError(`LUT_3D_SIZE ${size3d} needs ${expected} rows, the file has ${values.length / 3}`);
    return { title, size: size3d, domainMin, domainMax, data: Float32Array.from(values), description: `3D, ${size3d} points` };
  }

  if (values.length !== size1d * 3) throw new CubeParseError(`LUT_1D_SIZE ${size1d} needs ${size1d} rows, the file has ${values.length / 3}`);
  // Each channel through its own curve, sampled (linearly) at the expanded grid's points.
  const curve = (channel: number, x: number): number => {
    const position = x * (size1d - 1);
    const lo = Math.floor(position);
    const hi = Math.min(size1d - 1, lo + 1);
    const f = position - lo;
    return (values[lo * 3 + channel] as number) * (1 - f) + (values[hi * 3 + channel] as number) * f;
  };
  const n = EXPANDED_1D_SIZE;
  const data = new Float32Array(n ** 3 * 3);
  for (let b = 0; b < n; b += 1) {
    for (let g = 0; g < n; g += 1) {
      for (let r = 0; r < n; r += 1) {
        const i = ((b * n + g) * n + r) * 3;
        data[i] = curve(0, r / (n - 1));
        data[i + 1] = curve(1, g / (n - 1));
        data[i + 2] = curve(2, b / (n - 1));
      }
    }
  }
  return { title, size: n, domainMin, domainMax, data, description: `1D, ${size1d} points (as 3D, ${n})` };
}

/**
 * The table applied to one colour on the CPU — trilinear, exactly as the GPU's filtered 3D texture
 * does it — for the tests and for anything that needs a LUT's answer without a context.
 */
export function applyLut(lut: Lut3D, rgb: readonly [number, number, number]): [number, number, number] {
  const n = lut.size;
  const p = [0, 1, 2].map((c) => {
    const t = ((rgb[c] as number) - (lut.domainMin[c] as number)) / ((lut.domainMax[c] as number) - (lut.domainMin[c] as number));
    return Math.min(1, Math.max(0, t)) * (n - 1);
  }) as [number, number, number];
  const i0 = p.map((v) => Math.min(n - 2, Math.floor(v)));
  const f = p.map((v, c) => v - (i0[c] as number));
  const at = (r: number, g: number, b: number, c: number) => lut.data[((b * n + g) * n + r) * 3 + c] as number;
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c += 1) {
    let sum = 0;
    for (let dz = 0; dz < 2; dz += 1) {
      for (let dy = 0; dy < 2; dy += 1) {
        for (let dx = 0; dx < 2; dx += 1) {
          const w = (dx ? f[0]! : 1 - f[0]!) * (dy ? f[1]! : 1 - f[1]!) * (dz ? f[2]! : 1 - f[2]!);
          sum += w * at(i0[0]! + dx, i0[1]! + dy, i0[2]! + dz, c);
        }
      }
    }
    out[c] = sum;
  }
  return out;
}
