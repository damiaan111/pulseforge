// Opaque, sortable identifiers for layers, effects, bindings and lyric lines
// (data-formats §1.4).
//
// ULID layout: 48-bit millisecond timestamp + 80 bits of randomness, Crockford base32,
// 26 characters. Sortable by creation order, collision-free in practice, and never derived
// from a name — renaming a layer must never move what a modulation points at.
//
// Ids are generated once and never reused after deletion. Generation is injectable so tests
// (and any future deterministic import path) can produce fixed ids; the default draws on the
// wall clock and the platform CSPRNG, both of which are fine here — this is src/project/,
// not the engine.

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const TIME_CHARS = 10;
const RANDOM_CHARS = 16;
const RANDOM_BYTES = 10;
export const ID_LENGTH = TIME_CHARS + RANDOM_CHARS;

/** 2^48 ms ≈ year 10889; beyond that the timestamp no longer fits in 10 characters. */
const MAX_TIME_MS = 2 ** 48 - 1;

export interface IdSource {
  /** Milliseconds since the Unix epoch. */
  now(): number;
  /** Fills `into` with cryptographically random bytes. */
  randomBytes(into: Uint8Array<ArrayBuffer>): void;
}

export const defaultIdSource: IdSource = {
  now: () => Date.now(),
  randomBytes: (into) => {
    crypto.getRandomValues(into);
  },
};

function encodeTime(ms: number): string {
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > MAX_TIME_MS) {
    throw new RangeError(`id timestamp must be an integer in 0..${MAX_TIME_MS} ms, got ${ms}`);
  }
  const out = new Array<string>(TIME_CHARS);
  let rest = ms;
  for (let i = TIME_CHARS - 1; i >= 0; i -= 1) {
    out[i] = CROCKFORD[rest % 32] as string;
    rest = Math.floor(rest / 32);
  }
  return out.join('');
}

/** 10 bytes → 16 base32 characters, most significant bits first. */
function encodeRandom(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let acc = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(acc >> bits) & 31] as string;
    }
  }
  return out;
}

export function createIdFactory(source: IdSource = defaultIdSource): () => string {
  const bytes = new Uint8Array(RANDOM_BYTES);
  return () => {
    source.randomBytes(bytes);
    return encodeTime(source.now()) + encodeRandom(bytes);
  };
}

/** The process-wide generator. Tests and importers build their own with `createIdFactory`. */
export const newId = createIdFactory();

export function isValidId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== ID_LENGTH) return false;
  for (const ch of value) {
    if (!CROCKFORD.includes(ch)) return false;
  }
  return true;
}

/**
 * A counted generator for fixtures and tests: `testIds('L')` yields
 * `0000000000L000000000000001`, `…002`, … — valid ids, stable across runs, and readable
 * in a diff. Not for production documents: they must be globally unique.
 */
export function createTestIdFactory(tag = '0'): () => string {
  if (tag.length !== 1 || !CROCKFORD.includes(tag)) {
    throw new RangeError(`test id tag must be a single Crockford base32 character, got "${tag}"`);
  }
  let n = 0;
  return () => {
    n += 1;
    // Crockford base32, not `toString(32)` — the built-in alphabet includes I, L, O and U,
    // which Crockford deliberately omits, so those ids would not validate.
    let counter = '';
    let rest = n;
    for (let i = 0; i < RANDOM_CHARS - 1; i += 1) {
      counter = (CROCKFORD[rest % 32] as string) + counter;
      rest = Math.floor(rest / 32);
    }
    return '0'.repeat(TIME_CHARS) + tag + counter;
  };
}
