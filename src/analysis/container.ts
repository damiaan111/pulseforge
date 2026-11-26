// The binary container for an analysed source (data-formats §4.2).
//
// Float32 little-endian, fixed rate, one header describing what follows. Binary because the
// numbers are the bulk of the cache: a 5-minute track at 240 Hz with ~20 tracks across 5
// sources is millions of floats — ~29 MB binary against ~150 MB of JSON that is slow to parse.
//
// Layout: [u32 header length][UTF-8 JSON header][pad to 4][float32 spectrum][bands…][features…]
//
// The header carries the versions and the cache key inputs, so a file can always say what
// produced it. Reading a file written by a different `analysisVersion` is refused rather than
// silently reinterpreted — that is exactly how a stale cache survives a bug fix.

import type { AnalysisSet, AnalysisTrack, BeatGrid, SourceAnalysis } from '../engine/core/analysis.ts';
import type { Stem } from '../engine/core/params.ts';
import { ANALYSIS_VERSION } from './spectrum.ts';

export const CONTAINER_VERSION = 1;

interface TrackHeader {
  readonly name: string;
  readonly rate: number;
  readonly channels: number;
  readonly length: number;
}

interface Header {
  readonly containerVersion: number;
  readonly analysisVersion: number;
  readonly source: Stem;
  readonly spectrum: TrackHeader;
  readonly bands: readonly TrackHeader[];
  readonly features: readonly TrackHeader[];
  readonly beatGrid?: BeatGrid;
  readonly meta: Record<string, unknown>;
}

export class AnalysisFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalysisFormatError';
  }
}

export interface EncodeOptions {
  readonly source: Stem;
  readonly beatGrid?: BeatGrid | undefined;
  readonly meta?: Record<string, unknown>;
}

export function encodeAnalysis(analysis: SourceAnalysis, options: EncodeOptions): Uint8Array {
  const bands = [...analysis.bands.entries()];
  const features = [...analysis.features.entries()];
  const describe = ([name, track]: readonly [string, AnalysisTrack]): TrackHeader =>
    ({ name, rate: track.rate, channels: track.channels, length: track.data.length });

  const header: Header = {
    containerVersion: CONTAINER_VERSION,
    analysisVersion: ANALYSIS_VERSION,
    source: options.source,
    spectrum: describe(['spectrum', analysis.spectrum]),
    bands: bands.map(describe),
    features: features.map(describe),
    ...(options.beatGrid === undefined ? {} : { beatGrid: options.beatGrid }),
    meta: options.meta ?? {},
  };

  const json = new TextEncoder().encode(JSON.stringify(header));
  // Float32Array views need 4-byte alignment, so the data section starts on a multiple of 4.
  const dataStart = Math.ceil((4 + json.length) / 4) * 4;
  const arrays = [analysis.spectrum.data, ...bands.map(([, t]) => t.data), ...features.map(([, t]) => t.data)];
  const floats = arrays.reduce((n, a) => n + a.length, 0);

  const bytes = new Uint8Array(dataStart + floats * 4);
  new DataView(bytes.buffer).setUint32(0, json.length, true);
  bytes.set(json, 4);
  let offset = dataStart;
  for (const data of arrays) {
    bytes.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), offset);
    offset += data.byteLength;
  }
  return bytes;
}

export interface DecodedAnalysis {
  readonly analysis: AnalysisSet;
  readonly meta: Record<string, unknown>;
}

export function decodeAnalysis(bytes: Uint8Array): DecodedAnalysis {
  if (bytes.length < 8) throw new AnalysisFormatError('This analysis file is too short to contain a header.');
  // Copy into an owned, aligned buffer: the input may be a view at an odd offset.
  const copy = new Uint8Array(bytes);
  const view = new DataView(copy.buffer);
  const jsonLength = view.getUint32(0, true);
  if (jsonLength === 0 || 4 + jsonLength > copy.length) {
    throw new AnalysisFormatError('This analysis file has a corrupt header length.');
  }

  let header: Header;
  try {
    header = JSON.parse(new TextDecoder().decode(copy.subarray(4, 4 + jsonLength))) as Header;
  } catch (cause) {
    throw new AnalysisFormatError(`This analysis file has an unreadable header: ${(cause as Error).message}`);
  }
  if (header.analysisVersion !== ANALYSIS_VERSION) {
    // Rebuilding is cheap and always correct; reinterpreting old numbers under new semantics
    // is neither (data-formats §4.3).
    throw new AnalysisFormatError(
      `This analysis was computed by version ${header.analysisVersion}; this build produces version ${ANALYSIS_VERSION}. Re-analyse the audio.`,
    );
  }

  let offset = Math.ceil((4 + jsonLength) / 4) * 4;
  const take = (track: TrackHeader): AnalysisTrack => {
    if (offset + track.length * 4 > copy.length) {
      throw new AnalysisFormatError(`This analysis file is truncated: "${track.name}" runs past the end.`);
    }
    const data = new Float32Array(copy.buffer, offset, track.length);
    offset += track.length * 4;
    return { rate: track.rate, channels: track.channels, data };
  };

  const spectrum = take(header.spectrum);
  const bands = new Map<string, AnalysisTrack>();
  for (const band of header.bands) bands.set(band.name, take(band));
  const features = new Map<string, AnalysisTrack>();
  for (const feature of header.features) features.set(feature.name, take(feature));

  return {
    analysis: {
      sources: new Map([[header.source, { spectrum, bands, features }]]),
      ...(header.beatGrid === undefined ? {} : { beatGrid: header.beatGrid }),
    },
    meta: header.meta,
  };
}
