// The on-disk analysis cache (data-formats §4.1, §4.3–§4.5; M4, M33).
//
//   <root>/analysis/<audioHash>/<settingsHash>/
//     meta.json       versions, key inputs, per-source readiness, sizes
//     mix.bin         the container from container.ts — one file per source
//     drums.bin  bass.bin  vocals.bin  other.bin
//     beatgrid.json   beat times, bpm, confidence, onset times
//     peaks/mix.peaks the waveform pyramid the timeline draws from
//
// Two properties do the real work here.
//
// **The key must capture everything that changes the numbers.** `audioHash` is taken over the
// decoded PCM rather than the file, so re-encoding the same audio into a different container
// still hits the cache. `settingsHash` covers the spectrum settings, onset sensitivity, the bpm
// override, the stem model — and `ANALYSIS_VERSION`, which is the one people forget: without it
// a fixed onset detector keeps serving the old results out of cache and the fix appears not to
// work (data-formats §4.3).
//
// **Readiness is explicit.** The mix analyses in seconds, stems take minutes (PROJECT.md M5), so
// an entry is routinely half-populated. Callers get `'ready' | 'pending' | 'failed'` per source
// and can show that, rather than reading zeros that look exactly like silence.
//
// Everything here is rebuildable by definition (M33): deleting the tree costs time, never data.
// That is why there is no checksum and why `prune` can delete freely.

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AnalysisSet, BeatGrid, SourceAnalysis } from '../engine/core/analysis.ts';
import type { Stem } from '../engine/core/params.ts';
import { decodeAnalysis, encodeAnalysis, CONTAINER_VERSION } from './container.ts';
import { decodePeaks, encodePeaks, type PeakPyramid } from './peaks.ts';
import { ANALYSIS_VERSION, DEFAULT_SPECTRUM_SETTINGS, type SpectrumSettings } from './spectrum.ts';

export const CACHE_LAYOUT_VERSION = 1;

export type SourceState = 'ready' | 'pending' | 'failed';

/** Everything that changes the numbers. Anything absent here must not change them. */
export interface AnalysisKeyInputs {
  readonly settings?: SpectrumSettings;
  readonly onsetSensitivity?: number;
  readonly bpmOverride?: number | null;
  /** Which Demucs model produced the stems; changes their content, so it changes the key. */
  readonly stemModel?: string;
}

export interface SourceEntry {
  readonly state: SourceState;
  readonly bytes?: number;
  /** Present when `state` is `'failed'` — why, so the UI can say something useful. */
  readonly error?: string;
}

export interface CacheMeta {
  readonly cacheLayoutVersion: number;
  readonly analysisVersion: number;
  readonly containerVersion: number;
  readonly audioHash: string;
  readonly settingsHash: string;
  /** Readable copy of what went into `settingsHash` — for debugging a cache that missed. */
  readonly keyInputs: Record<string, unknown>;
  readonly durationSeconds: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sources: Readonly<Record<string, SourceEntry>>;
  readonly beatGrid?: BeatGrid;
}

export interface CacheEntrySummary {
  readonly audioHash: string;
  readonly settingsHash: string;
  readonly path: string;
  readonly bytes: number;
  readonly updatedAt: string;
  readonly sources: Readonly<Record<string, SourceEntry>>;
}

export interface AnalysisCacheOptions {
  /** Cache root — the app passes its configured cache directory (M33, §8.14). */
  readonly root: string;
  /** Injected so tests are byte-stable, like `History` does with its clock. */
  readonly now?: () => string;
}

/**
 * SHA-256 over the decoded PCM. Hashing the *samples* rather than the file is what makes a
 * re-encode of the same audio hit the same cache (data-formats §4.3). The little-endian view is
 * taken explicitly so a cache written on one machine means the same thing on another.
 */
export function hashPcm(pcm: Float32Array): string {
  const hash = createHash('sha256');
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  hash.update(bytes);
  return hash.digest('hex');
}

/**
 * The settings half of the key.
 *
 * Bands contribute their **semantics, not their labels**: renaming "bass" to "low" must not throw
 * away a valid cache, while moving its edges must (data-formats §4.3). So band names are dropped
 * and the ranges sorted before hashing.
 */
export function hashAnalysisSettings(inputs: AnalysisKeyInputs = {}): string {
  return createHash('sha256').update(JSON.stringify(analysisKeyInputs(inputs))).digest('hex');
}

/** The canonical, readable form of the key inputs — hashed, and also stored in `meta.json`. */
export function analysisKeyInputs(inputs: AnalysisKeyInputs = {}): Record<string, unknown> {
  const settings = inputs.settings ?? DEFAULT_SPECTRUM_SETTINGS;
  return {
    analysisVersion: ANALYSIS_VERSION,
    containerVersion: CONTAINER_VERSION,
    cacheLayoutVersion: CACHE_LAYOUT_VERSION,
    fftSize: settings.fftSize,
    bins: settings.bins,
    minHz: settings.minHz,
    maxHz: settings.maxHz,
    floorDb: settings.floorDb,
    bands: settings.bands
      .map((band) => [band.minHz, band.maxHz] as const)
      .slice()
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]),
    onsetSensitivity: inputs.onsetSensitivity ?? null,
    bpmOverride: inputs.bpmOverride ?? null,
    stemModel: inputs.stemModel ?? null,
  };
}

export class AnalysisCache {
  private readonly root: string;
  private readonly now: () => string;

  constructor(options: AnalysisCacheOptions) {
    this.root = options.root;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  get analysisRoot(): string {
    return join(this.root, 'analysis');
  }

  entryPath(audioHash: string, settingsHash: string): string {
    return join(this.analysisRoot, audioHash, settingsHash);
  }

  /** The meta for an entry, or null when there is no entry (a cache miss, not an error). */
  async readMeta(audioHash: string, settingsHash: string): Promise<CacheMeta | null> {
    const text = await readIfPresent(join(this.entryPath(audioHash, settingsHash), 'meta.json'));
    if (text === null) return null;
    let meta: CacheMeta;
    try {
      meta = JSON.parse(text) as CacheMeta;
    } catch {
      return null; // A corrupt entry is a miss: the cache is rebuildable, so re-analyse quietly.
    }
    // A layout change means the directory shape itself moved; an analysis change means the
    // numbers would be reinterpreted. Either way this entry is not ours to read.
    if (meta.cacheLayoutVersion !== CACHE_LAYOUT_VERSION || meta.analysisVersion !== ANALYSIS_VERSION) {
      return null;
    }
    return meta;
  }

  /** Per-source readiness without decoding anything — what a progress UI polls. */
  async readiness(audioHash: string, settingsHash: string): Promise<Readonly<Record<string, SourceEntry>>> {
    return (await this.readMeta(audioHash, settingsHash))?.sources ?? {};
  }

  /**
   * Read one source. Returns null on a miss, on a source that is still pending, or on an entry
   * written by another analysis version — the container refuses that one outright.
   */
  async readSource(audioHash: string, settingsHash: string, source: Stem): Promise<SourceAnalysis | null> {
    const meta = await this.readMeta(audioHash, settingsHash);
    if (meta?.sources[source]?.state !== 'ready') return null;
    const bytes = await readBytesIfPresent(join(this.entryPath(audioHash, settingsHash), `${source}.bin`));
    if (bytes === null) return null;
    try {
      // The container decodes into an `AnalysisSet` keyed by source, even though each file holds
      // exactly one — so take the source back out rather than handing up a one-entry set.
      return decodeAnalysis(bytes).analysis.sources.get(source) ?? null;
    } catch {
      return null; // Version mismatch or truncation: re-analyse rather than serve bad numbers.
    }
  }

  /**
   * Every ready source plus the beat grid, in the shape the engine consumes. Sources that are
   * still pending are simply absent from the map — `AnalysisSet` already treats a missing stem
   * as explicitly absent rather than silent (data-formats §4.4).
   */
  async readSet(audioHash: string, settingsHash: string): Promise<AnalysisSet | null> {
    const meta = await this.readMeta(audioHash, settingsHash);
    if (meta === null) return null;
    const sources = new Map<Stem, SourceAnalysis>();
    for (const [name, entry] of Object.entries(meta.sources)) {
      if (entry.state !== 'ready') continue;
      const analysis = await this.readSource(audioHash, settingsHash, name as Stem);
      if (analysis !== null) sources.set(name as Stem, analysis);
    }
    if (sources.size === 0) return null;
    return meta.beatGrid === undefined ? { sources } : { sources, beatGrid: meta.beatGrid };
  }

  /**
   * Write one source and update the entry's meta. Safe to call repeatedly as stems finish one at
   * a time — each call merges into the existing meta rather than replacing it.
   */
  async writeSource(
    audioHash: string,
    settingsHash: string,
    source: Stem,
    analysis: SourceAnalysis,
    options: {
      readonly keyInputs?: AnalysisKeyInputs;
      readonly durationSeconds?: number;
      readonly beatGrid?: BeatGrid;
      /** Onset times in seconds — the timeline's snap targets (ui-spec §3). */
      readonly onsetTimes?: readonly number[];
    } = {},
  ): Promise<void> {
    const dir = this.entryPath(audioHash, settingsHash);
    await mkdir(dir, { recursive: true });

    const bytes = encodeAnalysis(analysis, {
      source,
      ...(options.beatGrid === undefined ? {} : { beatGrid: options.beatGrid }),
      meta: { audioHash, settingsHash },
    });
    await writeAtomic(join(dir, `${source}.bin`), bytes);

    await this.updateMeta(audioHash, settingsHash, (existing) => ({
      cacheLayoutVersion: CACHE_LAYOUT_VERSION,
      analysisVersion: ANALYSIS_VERSION,
      containerVersion: CONTAINER_VERSION,
      audioHash,
      settingsHash,
      keyInputs: analysisKeyInputs(options.keyInputs ?? {}),
      durationSeconds: options.durationSeconds ?? existing?.durationSeconds ?? 0,
      createdAt: existing?.createdAt ?? this.now(),
      updatedAt: this.now(),
      ...(options.beatGrid === undefined
        ? existing?.beatGrid === undefined
          ? {}
          : { beatGrid: existing.beatGrid }
        : { beatGrid: options.beatGrid }),
      sources: { ...existing?.sources, [source]: { state: 'ready', bytes: bytes.byteLength } },
    }));

    // beatgrid.json also carries the onsets. They are not a track, so the container has nowhere
    // to put them — and without them a cache hit silently loses the timeline's snap targets.
    if (options.beatGrid !== undefined || options.onsetTimes !== undefined) {
      const payload = {
        ...(options.beatGrid === undefined ? {} : { beatGrid: options.beatGrid }),
        onsetTimes: options.onsetTimes ?? [],
      };
      await writeAtomic(join(dir, 'beatgrid.json'), Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8'));
    }
  }

  /**
   * Waveform peaks for the timeline (ui-spec §3). Stored beside the analysis because they are
   * derived from the same audio and invalidated by the same thing — the audio changing.
   */
  async writePeaks(audioHash: string, settingsHash: string, pyramid: PeakPyramid): Promise<void> {
    const dir = this.entryPath(audioHash, settingsHash);
    await mkdir(join(dir, 'peaks'), { recursive: true });
    await writeAtomic(join(dir, 'peaks', 'mix.peaks'), encodePeaks(pyramid));
  }

  /** Null on a miss or on a file from another format version — rebuild rather than misread. */
  async readPeaks(audioHash: string, settingsHash: string): Promise<PeakPyramid | null> {
    const bytes = await readBytesIfPresent(join(this.entryPath(audioHash, settingsHash), 'peaks', 'mix.peaks'));
    if (bytes === null) return null;
    try {
      return decodePeaks(bytes);
    } catch {
      return null;
    }
  }

  /** Onset times recorded alongside the grid; empty when the entry predates them or missed. */
  async readOnsetTimes(audioHash: string, settingsHash: string): Promise<readonly number[]> {
    const text = await readIfPresent(join(this.entryPath(audioHash, settingsHash), 'beatgrid.json'));
    if (text === null) return [];
    try {
      return (JSON.parse(text) as { onsetTimes?: readonly number[] }).onsetTimes ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Mark a source as being worked on or as having failed. Without this a long stem separation is
   * indistinguishable from one that never started, which is the difference between a progress
   * bar and a mystery.
   */
  async markSource(
    audioHash: string,
    settingsHash: string,
    source: Stem,
    state: Exclude<SourceState, 'ready'>,
    error?: string,
  ): Promise<void> {
    await mkdir(this.entryPath(audioHash, settingsHash), { recursive: true });
    await this.updateMeta(audioHash, settingsHash, (existing) => ({
      cacheLayoutVersion: CACHE_LAYOUT_VERSION,
      analysisVersion: ANALYSIS_VERSION,
      containerVersion: CONTAINER_VERSION,
      audioHash,
      settingsHash,
      keyInputs: existing?.keyInputs ?? analysisKeyInputs({}),
      durationSeconds: existing?.durationSeconds ?? 0,
      createdAt: existing?.createdAt ?? this.now(),
      updatedAt: this.now(),
      ...(existing?.beatGrid === undefined ? {} : { beatGrid: existing.beatGrid }),
      sources: {
        ...existing?.sources,
        [source]: { state, ...(error === undefined ? {} : { error }) },
      },
    }));
  }

  /** Every entry with its size — the data behind the cache panel's biggest-first list (M33). */
  async list(): Promise<readonly CacheEntrySummary[]> {
    const summaries: CacheEntrySummary[] = [];
    for (const audioHash of await readdirIfPresent(this.analysisRoot)) {
      for (const settingsHash of await readdirIfPresent(join(this.analysisRoot, audioHash))) {
        const path = join(this.analysisRoot, audioHash, settingsHash);
        const meta = await this.readMeta(audioHash, settingsHash);
        summaries.push({
          audioHash,
          settingsHash,
          path,
          bytes: await directorySize(path),
          updatedAt: meta?.updatedAt ?? '',
          sources: meta?.sources ?? {},
        });
      }
    }
    return summaries.sort((a, b) => b.bytes - a.bytes);
  }

  async totalBytes(): Promise<number> {
    return (await this.list()).reduce((sum, entry) => sum + entry.bytes, 0);
  }

  /** Delete one entry. Also removes the audio-hash directory once its last entry is gone. */
  async remove(audioHash: string, settingsHash: string): Promise<void> {
    await rm(this.entryPath(audioHash, settingsHash), { recursive: true, force: true });
    const parent = join(this.analysisRoot, audioHash);
    if ((await readdirIfPresent(parent)).length === 0) await rm(parent, { recursive: true, force: true });
  }

  /**
   * Evict least-recently-updated entries until the tree fits `maxBytes` (M33's ceiling).
   * Returns what was removed, so the caller can say so rather than silently freeing disk.
   */
  async prune(maxBytes: number): Promise<readonly CacheEntrySummary[]> {
    const entries = [...(await this.list())].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    const removed: CacheEntrySummary[] = [];
    for (const entry of entries) {
      if (total <= maxBytes) break;
      await this.remove(entry.audioHash, entry.settingsHash);
      total -= entry.bytes;
      removed.push(entry);
    }
    return removed;
  }

  async clear(): Promise<void> {
    await rm(this.analysisRoot, { recursive: true, force: true });
  }

  private async updateMeta(
    audioHash: string,
    settingsHash: string,
    build: (existing: CacheMeta | null) => CacheMeta,
  ): Promise<void> {
    // Read the raw file rather than `readMeta`, which returns null for a foreign version — here
    // that would silently drop the sibling sources recorded in an entry we are about to rewrite.
    const path = join(this.entryPath(audioHash, settingsHash), 'meta.json');
    const text = await readIfPresent(path);
    let existing: CacheMeta | null = null;
    if (text !== null) {
      try {
        existing = JSON.parse(text) as CacheMeta;
      } catch {
        existing = null;
      }
    }
    await writeAtomic(path, Buffer.from(`${JSON.stringify(build(existing), null, 2)}\n`, 'utf8'));
  }
}

/** Temp file in the same directory, then rename — the pattern `project-io.ts` uses and why. */
async function writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, bytes);
  await rename(temp, path);
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw cause;
  }
}

async function readBytesIfPresent(path: string): Promise<Uint8Array | null> {
  try {
    return await readFile(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw cause;
  }
}

async function readdirIfPresent(path: string): Promise<readonly string[]> {
  try {
    return await readdir(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw cause;
  }
}

async function directorySize(path: string): Promise<number> {
  let total = 0;
  for (const name of await readdirIfPresent(path)) {
    const child = join(path, name);
    const info = await stat(child);
    total += info.isDirectory() ? await directorySize(child) : info.size;
  }
  return total;
}
