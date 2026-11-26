// Which characters a font has, read from its `cmap` table (S17).
//
// The rasteriser needs this for one reason: canvas 2D falls back to fonts **installed on the
// system** for a character nothing in the stack has, which would make a frame depend on the
// machine (PROJECT.md §8.13). Knowing the coverage up front lets those characters be reported and
// replaced before the canvas sees them.
//
// Pure, and only what is needed: SFNT files (.ttf, .otf), the Unicode subtables, formats 4 and 12.
// A compressed web font gives null, meaning "not known": WOFF would need a decompressor here.

export interface FontCoverage {
  has(codePoint: number): boolean;
}

/** Sorted, inclusive [first, last] pairs. */
class Ranges implements FontCoverage {
  private readonly pairs: readonly number[];

  constructor(pairs: readonly number[]) {
    this.pairs = pairs;
  }

  has(codePoint: number): boolean {
    let lo = 0;
    let hi = this.pairs.length / 2 - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (codePoint < (this.pairs[mid * 2] as number)) hi = mid - 1;
      else if (codePoint > (this.pairs[mid * 2 + 1] as number)) lo = mid + 1;
      else return true;
    }
    return false;
  }
}

function format12(view: DataView, at: number): number[] {
  const groups = view.getUint32(at + 12);
  const pairs: number[] = [];
  for (let i = 0; i < groups; i += 1) {
    const group = at + 16 + i * 12;
    pairs.push(view.getUint32(group), view.getUint32(group + 4));
  }
  return pairs;
}

function format4(view: DataView, at: number): number[] {
  const segments = view.getUint16(at + 6) / 2;
  const ends = at + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const offsets = deltas + segments * 2;
  const pairs: number[] = [];
  const add = (first: number, last: number) => {
    if (pairs.length > 0 && pairs[pairs.length - 1] === first - 1) pairs[pairs.length - 1] = last;
    else pairs.push(first, last);
  };
  for (let s = 0; s < segments; s += 1) {
    const end = view.getUint16(ends + s * 2);
    const start = view.getUint16(starts + s * 2);
    const delta = view.getUint16(deltas + s * 2);
    const offsetAt = offsets + s * 2;
    const offset = view.getUint16(offsetAt);
    if (start === 0xffff) continue;
    if (offset === 0) {
      // The glyph is code + delta; a result of 0 is the missing glyph.
      const zero = (0x10000 - delta) & 0xffff;
      if (zero < start || zero > end) add(start, end);
      else {
        if (zero > start) add(start, zero - 1);
        if (zero < end) add(zero + 1, end);
      }
      continue;
    }
    for (let code = start; code <= end; code += 1) {
      if (view.getUint16(offsetAt + offset + (code - start) * 2) !== 0) add(code, code);
    }
  }
  return pairs;
}

/** The font's coverage; null when it is not a plain SFNT or has no Unicode subtable to read. */
export function parseCmap(bytes: Uint8Array): FontCoverage | null {
  if (bytes.length < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = view.getUint32(0);
  if (tag !== 0x00010000 && tag !== 0x4f54544f /* OTTO */ && tag !== 0x74727565 /* true */) return null;

  try {
    const tables = view.getUint16(4);
    let cmap = -1;
    for (let i = 0; i < tables; i += 1) {
      const record = 12 + i * 16;
      if (view.getUint32(record) === 0x636d6170 /* cmap */) cmap = view.getUint32(record + 8);
    }
    if (cmap < 0) return null;

    let best: { at: number; format: number } | null = null;
    const subtables = view.getUint16(cmap + 2);
    for (let i = 0; i < subtables; i += 1) {
      const record = cmap + 4 + i * 8;
      const platform = view.getUint16(record);
      const encoding = view.getUint16(record + 2);
      const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
      if (!unicode) continue;
      const at = cmap + view.getUint32(record + 4);
      const format = view.getUint16(at);
      if (format === 12 && best?.format !== 12) best = { at, format };
      else if (format === 4 && best === null) best = { at, format };
    }
    if (best === null) return null;
    return new Ranges(best.format === 12 ? format12(view, best.at) : format4(view, best.at));
  } catch (cause) {
    // A table that runs off the end of the file: unreadable, like any other font we cannot parse.
    if (cause instanceof RangeError) return null;
    throw cause;
  }
}
