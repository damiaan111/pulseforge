// Spike-only container for handing a SourceAnalysis from Node to the Electron renderer.
// Not the AnalysisCache format (data-formats §4.2) — that arrives with the real cache.
//
// Layout: [u32 header length][UTF-8 JSON header][pad to 4][float32 spectrum][float32 bands…]

import type { AnalysisSet, AnalysisTrack, SourceAnalysis } from '../src/engine/core/analysis.ts';
import type { Stem } from '../src/engine/core/params.ts';

interface Header {
  source: Stem;
  spectrum: { rate: number; channels: number; length: number };
  bands: Array<{ name: string; rate: number; length: number }>;
  meta: Record<string, unknown>;
}

export function encodeAnalysis(source: Stem, analysis: SourceAnalysis, meta: Record<string, unknown>): Uint8Array {
  const bands = [...analysis.bands.entries()];
  const header: Header = {
    source,
    spectrum: { rate: analysis.spectrum.rate, channels: analysis.spectrum.channels, length: analysis.spectrum.data.length },
    bands: bands.map(([name, track]) => ({ name, rate: track.rate, length: track.data.length })),
    meta,
  };
  const json = new TextEncoder().encode(JSON.stringify(header));
  const headerEnd = 4 + json.length;
  const dataStart = Math.ceil(headerEnd / 4) * 4;
  const floats = analysis.spectrum.data.length + bands.reduce((n, [, t]) => n + t.data.length, 0);
  const bytes = new Uint8Array(dataStart + floats * 4);
  new DataView(bytes.buffer).setUint32(0, json.length, true);
  bytes.set(json, 4);
  let offset = dataStart;
  for (const data of [analysis.spectrum.data, ...bands.map(([, t]) => t.data)]) {
    bytes.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), offset);
    offset += data.byteLength;
  }
  return bytes;
}

export function decodeAnalysis(bytes: Uint8Array): { analysis: AnalysisSet; meta: Record<string, unknown> } {
  const copy = new Uint8Array(bytes); // own, aligned buffer
  const view = new DataView(copy.buffer);
  const jsonLength = view.getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(copy.subarray(4, 4 + jsonLength))) as Header;
  let offset = Math.ceil((4 + jsonLength) / 4) * 4;
  const take = (length: number) => {
    const data = new Float32Array(copy.buffer, offset, length);
    offset += length * 4;
    return data;
  };
  const spectrum: AnalysisTrack = { rate: header.spectrum.rate, channels: header.spectrum.channels, data: take(header.spectrum.length) };
  const bands = new Map<string, AnalysisTrack>();
  for (const band of header.bands) bands.set(band.name, { rate: band.rate, channels: 1, data: take(band.length) });
  return { analysis: { sources: new Map([[header.source, { spectrum, bands }]]) }, meta: header.meta };
}
