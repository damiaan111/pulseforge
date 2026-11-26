// The engine's only source of randomness (CLAUDE.md constraint 1).
//
// Stateless and keyed: value = hash(seed, ...keys). Seeking to any frame yields the
// value that frame always had, because nothing is drawn from a sequence.
//
// The algorithm is part of every project's appearance. Changing it changes renders,
// which is why tests/engine/prng.test.ts pins exact output values. The mixing uses
// only 32-bit integer operations so the GLSL copy (HASH_GLSL) computes identical bits.

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** Murmur3-style 32-bit finaliser: full avalanche on a 32-bit input. */
export function mix32(value: number): number {
  let h = value >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Combines a running hash with one 32-bit word. */
export function combine32(hash: number, word: number): number {
  return mix32((Math.imul(hash ^ (word >>> 0), FNV_PRIME) + 0x9e3779b9) >>> 0);
}

function hashString(text: string): number {
  let h = FNV_OFFSET;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), FNV_PRIME) >>> 0;
  }
  return mix32(h);
}

export type PrngKey = string | number;

function keyWord(key: PrngKey): number {
  if (typeof key === 'string') return hashString(key);
  if (!Number.isSafeInteger(key)) {
    // Non-integers would make the key depend on float formatting. Keys identify
    // things (layer ids, indices, beat numbers); they are never measurements.
    throw new RangeError(`PRNG keys must be integers or strings, got ${key}`);
  }
  // Fold both halves so keys above 2^32 stay distinct.
  const low = key >>> 0;
  const high = Math.floor(key / 0x1_0000_0000) >>> 0;
  return mix32(low ^ mix32(high ^ 0x5bd1e995));
}

/** 32-bit hash of a seed and any keys. Different key types never collide by construction. */
export function hash32(seed: number, ...keys: readonly PrngKey[]): number {
  let h = mix32(keyWord(seed));
  for (const key of keys) {
    h = combine32(h, typeof key === 'string' ? 0x73747200 : 0x6e756d00); // type tag
    h = combine32(h, keyWord(key));
  }
  return h;
}

/** Uniform in [0, 1), 32 bits of resolution. */
export function random01(seed: number, ...keys: readonly PrngKey[]): number {
  return hash32(seed, ...keys) / 0x1_0000_0000;
}

export type Prng = (...keys: readonly PrngKey[]) => number;

export function createPrng(seed: number): Prng {
  return (...keys) => random01(seed, ...keys);
}

/**
 * GLSL ES 3.00 twin of mix32/combine32 for per-pixel noise (dithering). Unsigned integer
 * multiply wraps mod 2^32 in GLSL exactly as Math.imul does, so the bits match.
 */
export const HASH_GLSL = /* glsl */ `
uint pf_mix32(uint h) {
  h ^= h >> 16u;
  h *= 0x85ebca6bu;
  h ^= h >> 13u;
  h *= 0xc2b2ae35u;
  h ^= h >> 16u;
  return h;
}
uint pf_combine32(uint h, uint word) {
  return pf_mix32((h ^ word) * 0x01000193u + 0x9e3779b9u);
}
`;
