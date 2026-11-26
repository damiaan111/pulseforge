// Waveform peaks for the timeline (ui-spec §3, data-formats §4.1 `peaks/`).
//
// Drawing a waveform means answering "what is the loudest and quietest sample in this pixel
// column" a few thousand times per repaint, at whatever zoom the user has landed on. Scanning
// the PCM for that is hopeless: a 5-minute track is 14.4 M samples, and the timeline repaints on
// every drag. So peaks are precomputed once into a **pyramid** — successive halvings, like image
// mipmaps — and a query picks the level that is just finer than the pixels it has to fill.
//
// Each bucket keeps **min and max**, not an average or an absolute peak. A waveform drawn from
// averages loses its shape as it zooms out, and one drawn from absolute peaks loses asymmetry;
// min/max keeps the envelope looking like the same sound at every zoom, which is what makes a
// waveform usable for lining lyrics up against (lyrics-spec §5).
//
// This is a cache artefact like any other (M33): rebuildable from the audio, so losing it costs
// time and nothing else.

/** Samples per bucket at level 0. 256 at 48 kHz ≈ 5.3 ms — finer than any useful zoom. */
export const BASE_BUCKET_SAMPLES = 256;

export const PEAKS_FORMAT_VERSION = 1;

export interface PeakLevel {
  /** Samples of source audio behind each bucket. */
  readonly bucketSamples: number;
  /** Interleaved [min, max] per bucket, so one array and one cache line per bucket. */
  readonly data: Float32Array;
}

export interface PeakPyramid {
  readonly sampleRate: number;
  readonly sampleCount: number;
  readonly levels: readonly PeakLevel[];
}

export interface PeakWindow {
  readonly min: Float32Array;
  readonly max: Float32Array;
}

/**
 * Build the pyramid. Level 0 is computed from the PCM; every level above is computed from the
 * level below — halving each time, so the whole structure costs one pass over the audio plus a
 * geometric tail, and never revisits the samples.
 */
export function buildPeakPyramid(
  pcm: Float32Array,
  sampleRate: number,
  baseBucketSamples = BASE_BUCKET_SAMPLES,
): PeakPyramid {
  if (baseBucketSamples < 1) throw new RangeError(`bucket size must be at least 1, got ${baseBucketSamples}`);

  const bucketCount = Math.max(1, Math.ceil(pcm.length / baseBucketSamples));
  const base = new Float32Array(bucketCount * 2);
  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = bucket * baseBucketSamples;
    const end = Math.min(start + baseBucketSamples, pcm.length);
    let min = 0;
    let max = 0;
    if (start < end) {
      min = Infinity;
      max = -Infinity;
      for (let i = start; i < end; i += 1) {
        const value = pcm[i] as number;
        if (value < min) min = value;
        if (value > max) max = value;
      }
    }
    base[bucket * 2] = min;
    base[bucket * 2 + 1] = max;
  }

  const levels: PeakLevel[] = [{ bucketSamples: baseBucketSamples, data: base }];
  // Stop at one bucket: a level that covers the whole track is as coarse as any query can need.
  while ((levels[levels.length - 1] as PeakLevel).data.length / 2 > 1) {
    levels.push(halve(levels[levels.length - 1] as PeakLevel));
  }
  return { sampleRate, sampleCount: pcm.length, levels };
}

function halve(level: PeakLevel): PeakLevel {
  const buckets = level.data.length / 2;
  const nextBuckets = Math.ceil(buckets / 2);
  const data = new Float32Array(nextBuckets * 2);
  for (let bucket = 0; bucket < nextBuckets; bucket += 1) {
    const a = bucket * 2;
    const b = Math.min(a + 1, buckets - 1);
    data[bucket * 2] = Math.min(level.data[a * 2] as number, level.data[b * 2] as number);
    data[bucket * 2 + 1] = Math.max(level.data[a * 2 + 1] as number, level.data[b * 2 + 1] as number);
  }
  return { bucketSamples: level.bucketSamples * 2, data };
}

/**
 * Min/max per column for a time range — exactly what a timeline repaint needs.
 *
 * Picks the coarsest level that still has at least one bucket per column, so a zoomed-out view
 * reads a few hundred buckets rather than millions of samples, and a zoomed-in view keeps full
 * detail. Columns beyond the end of the audio are zero rather than absent: the timeline draws a
 * flat line past the end, which is what silence looks like.
 */
export function peaksForRange(
  pyramid: PeakPyramid,
  startSeconds: number,
  endSeconds: number,
  columns: number,
): PeakWindow {
  if (columns < 1) throw new RangeError(`columns must be at least 1, got ${columns}`);
  const min = new Float32Array(columns);
  const max = new Float32Array(columns);
  if (!(endSeconds > startSeconds)) return { min, max };

  const startSample = Math.max(0, Math.floor(startSeconds * pyramid.sampleRate));
  const endSample = Math.min(pyramid.sampleCount, Math.ceil(endSeconds * pyramid.sampleRate));
  const samplesPerColumn = ((endSeconds - startSeconds) * pyramid.sampleRate) / columns;

  const level = chooseLevel(pyramid, samplesPerColumn);
  const buckets = level.data.length / 2;

  for (let column = 0; column < columns; column += 1) {
    const from = startSample + column * samplesPerColumn;
    const to = from + samplesPerColumn;
    if (to <= 0 || from >= endSample) continue;

    const firstBucket = Math.max(0, Math.floor(from / level.bucketSamples));
    const lastBucket = Math.min(buckets - 1, Math.ceil(to / level.bucketSamples) - 1);
    let columnMin = 0;
    let columnMax = 0;
    if (firstBucket <= lastBucket) {
      columnMin = Infinity;
      columnMax = -Infinity;
      for (let bucket = firstBucket; bucket <= lastBucket; bucket += 1) {
        const low = level.data[bucket * 2] as number;
        const high = level.data[bucket * 2 + 1] as number;
        if (low < columnMin) columnMin = low;
        if (high > columnMax) columnMax = high;
      }
    }
    min[column] = columnMin;
    max[column] = columnMax;
  }
  return { min, max };
}

/** The coarsest level with at least one bucket per column — no more work than the pixels need. */
function chooseLevel(pyramid: PeakPyramid, samplesPerColumn: number): PeakLevel {
  let chosen = pyramid.levels[0] as PeakLevel;
  for (const level of pyramid.levels) {
    if (level.bucketSamples <= samplesPerColumn) chosen = level;
    else break;
  }
  return chosen;
}

/**
 * Serialise for the cache: a JSON header then the levels back to back, the same shape the
 * analysis container uses so both files read the same way.
 */
export function encodePeaks(pyramid: PeakPyramid): Uint8Array {
  const header = {
    formatVersion: PEAKS_FORMAT_VERSION,
    sampleRate: pyramid.sampleRate,
    sampleCount: pyramid.sampleCount,
    levels: pyramid.levels.map((level) => ({ bucketSamples: level.bucketSamples, length: level.data.length })),
  };
  const json = new TextEncoder().encode(JSON.stringify(header));
  const pad = (4 - ((4 + json.length) % 4)) % 4;
  const floats = pyramid.levels.reduce((sum, level) => sum + level.data.length, 0);
  const bytes = new Uint8Array(4 + json.length + pad + floats * 4);
  new DataView(bytes.buffer).setUint32(0, json.length, true);
  bytes.set(json, 4);

  let offset = 4 + json.length + pad;
  for (const level of pyramid.levels) {
    // Copy through a byte view: `level.data` may sit at an offset that is not float-aligned.
    bytes.set(new Uint8Array(level.data.buffer, level.data.byteOffset, level.data.byteLength), offset);
    offset += level.data.byteLength;
  }
  return bytes;
}

export function decodePeaks(bytes: Uint8Array): PeakPyramid {
  if (bytes.length < 8) throw new Error('This peaks file is too short to contain a header.');
  const copy = new Uint8Array(bytes);
  const jsonLength = new DataView(copy.buffer).getUint32(0, true);
  if (jsonLength === 0 || 4 + jsonLength > copy.length) throw new Error('This peaks file has a corrupt header.');

  const header = JSON.parse(new TextDecoder().decode(copy.subarray(4, 4 + jsonLength))) as {
    formatVersion: number;
    sampleRate: number;
    sampleCount: number;
    levels: { bucketSamples: number; length: number }[];
  };
  if (header.formatVersion !== PEAKS_FORMAT_VERSION) {
    throw new Error(`These peaks were written by format ${header.formatVersion}; this build reads ${PEAKS_FORMAT_VERSION}.`);
  }

  let offset = 4 + jsonLength + ((4 - ((4 + jsonLength) % 4)) % 4);
  const levels: PeakLevel[] = [];
  for (const level of header.levels) {
    const data = new Float32Array(level.length);
    new Uint8Array(data.buffer).set(copy.subarray(offset, offset + level.length * 4));
    levels.push({ bucketSamples: level.bucketSamples, data });
    offset += level.length * 4;
  }
  return { sampleRate: header.sampleRate, sampleCount: header.sampleCount, levels };
}
