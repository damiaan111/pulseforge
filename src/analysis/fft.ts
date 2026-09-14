// In-place iterative radix-2 FFT with precomputed tables. Allocation-free per transform.

export interface Fft {
  readonly size: number;
  /** Transforms re/im (length `size`) in place. */
  transform(re: Float64Array, im: Float64Array): void;
}

export function createFft(size: number): Fft {
  if (!Number.isInteger(Math.log2(size)) || size < 2) throw new RangeError(`FFT size must be a power of two, got ${size}`);
  const bits = Math.log2(size);
  const reverse = new Uint32Array(size);
  for (let i = 0; i < size; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    reverse[i] = r;
  }
  const cos = new Float64Array(size / 2);
  const sin = new Float64Array(size / 2);
  for (let i = 0; i < size / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / size);
    sin[i] = -Math.sin((2 * Math.PI * i) / size);
  }

  return {
    size,
    transform(re, im) {
      for (let i = 0; i < size; i++) {
        const j = reverse[i] ?? 0;
        if (j > i) {
          const tr = re[i] ?? 0;
          re[i] = re[j] ?? 0;
          re[j] = tr;
          const ti = im[i] ?? 0;
          im[i] = im[j] ?? 0;
          im[j] = ti;
        }
      }
      for (let len = 2; len <= size; len <<= 1) {
        const half = len >> 1;
        const step = size / len;
        for (let start = 0; start < size; start += len) {
          for (let k = 0; k < half; k++) {
            const c = cos[k * step] ?? 0;
            const s = sin[k * step] ?? 0;
            const a = start + k;
            const b = a + half;
            const bre = re[b] ?? 0;
            const bim = im[b] ?? 0;
            const tre = bre * c - bim * s;
            const tim = bre * s + bim * c;
            const are = re[a] ?? 0;
            const aim = im[a] ?? 0;
            re[b] = are - tre;
            im[b] = aim - tim;
            re[a] = are + tre;
            im[a] = aim + tim;
          }
        }
      }
    },
  };
}

/** Periodic Hann window (Σw² = 3N/8 exactly, used for level normalisation). */
export function hannWindow(size: number): Float64Array {
  const w = new Float64Array(size);
  for (let n = 0; n < size; n++) w[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / size);
  return w;
}
