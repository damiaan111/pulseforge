// The analysis container (src/analysis/container.ts, data-formats §4.2).

import { describe, expect, it } from 'vitest';

import { analyzeMix } from '../../src/analysis/analyze.ts';
import { AnalysisFormatError, decodeAnalysis, encodeAnalysis } from '../../src/analysis/container.ts';
import { ANALYSIS_SAMPLE_RATE, ANALYSIS_VERSION } from '../../src/analysis/spectrum.ts';
import type { SourceAnalysis } from '../../src/engine/core/analysis.ts';

function analysed(): { source: SourceAnalysis; beatGrid: ReturnType<typeof analyzeMix>['beatGrid'] } {
  const pcm = new Float32Array(ANALYSIS_SAMPLE_RATE);
  for (let i = 0; i < pcm.length; i += 1) pcm[i] = Math.sin((2 * Math.PI * 220 * i) / ANALYSIS_SAMPLE_RATE);
  const { analysis, beatGrid } = analyzeMix(pcm);
  return { source: analysis.sources.get('mix') as SourceAnalysis, beatGrid };
}

describe('encode / decode', () => {
  it('round-trips the spectrum, bands and every feature', () => {
    const { source } = analysed();
    const { analysis } = decodeAnalysis(encodeAnalysis(source, { source: 'mix' }));
    const back = analysis.sources.get('mix');

    expect(back?.spectrum.channels).toBe(source.spectrum.channels);
    expect([...(back?.spectrum.data ?? [])]).toEqual([...source.spectrum.data]);
    expect([...(back?.bands.keys() ?? [])]).toEqual([...source.bands.keys()]);
    expect([...(back?.features.keys() ?? [])]).toEqual([...source.features.keys()]);
    for (const [name, track] of source.features) {
      expect([...(back?.features.get(name)?.data ?? [])]).toEqual([...track.data]);
    }
  });

  it('round-trips the beat grid and the metadata', () => {
    const { source, beatGrid } = analysed();
    const bytes = encodeAnalysis(source, { source: 'drums', beatGrid, meta: { pcmSha256: 'abc' } });
    const decoded = decodeAnalysis(bytes);
    expect(decoded.analysis.beatGrid).toEqual(beatGrid);
    expect(decoded.analysis.sources.has('drums')).toBe(true);
    expect(decoded.meta['pcmSha256']).toBe('abc');
  });

  it('omits the grid when there was none, rather than inventing one', () => {
    const { source } = analysed();
    expect(decodeAnalysis(encodeAnalysis(source, { source: 'mix' })).analysis.beatGrid).toBeUndefined();
  });

  it('survives being handed a view at an awkward offset', () => {
    const { source } = analysed();
    const bytes = encodeAnalysis(source, { source: 'mix' });
    // Float32Array views need 4-byte alignment; the decoder must copy rather than assume.
    const padded = new Uint8Array(bytes.length + 3);
    padded.set(bytes, 3);
    const view = padded.subarray(3);
    expect(() => decodeAnalysis(view)).not.toThrow();
  });
});

describe('refusals', () => {
  it('refuses an analysis from a different version rather than reinterpreting it', () => {
    const { source } = analysed();
    const bytes = encodeAnalysis(source, { source: 'mix' });
    // Rewrite the version in the header. Reinterpreting old numbers under new semantics is
    // exactly how a stale cache survives a bug fix (data-formats §4.3).
    const text = new TextDecoder().decode(bytes.subarray(4, 4 + new DataView(bytes.buffer).getUint32(0, true)));
    const tampered = text.replace(`"analysisVersion":${ANALYSIS_VERSION}`, `"analysisVersion":${ANALYSIS_VERSION - 1}`);
    expect(tampered).not.toBe(text);
    const json = new TextEncoder().encode(tampered);
    const rebuilt = new Uint8Array(bytes);
    rebuilt.set(json, 4);

    expect(() => decodeAnalysis(rebuilt)).toThrow(AnalysisFormatError);
    expect(() => decodeAnalysis(rebuilt)).toThrow(/Re-analyse the audio/);
  });

  it('refuses a file that is too short or truncated', () => {
    expect(() => decodeAnalysis(new Uint8Array(4))).toThrow(/too short/);
    const { source } = analysed();
    const bytes = encodeAnalysis(source, { source: 'mix' });
    expect(() => decodeAnalysis(bytes.subarray(0, bytes.length - 400))).toThrow(/truncated/);
  });

  it('refuses a corrupt header length and an unreadable header', () => {
    const { source } = analysed();
    const bytes = encodeAnalysis(source, { source: 'mix' });

    const badLength = new Uint8Array(bytes);
    new DataView(badLength.buffer).setUint32(0, 0xfffffff, true);
    expect(() => decodeAnalysis(badLength)).toThrow(/corrupt header length/);

    const badJson = new Uint8Array(bytes);
    badJson[4] = '['.charCodeAt(0); // the header no longer opens an object
    expect(() => decodeAnalysis(badJson)).toThrow(AnalysisFormatError);
  });

  // Note on what is *not* checked: the container has no checksum, so bit-rot inside the float
  // data, or inside a header key name, can go undetected. That is a deliberate omission rather
  // than an oversight — the whole cache is rebuildable by definition (PROJECT.md M33), so the
  // cost of a corrupt file is time, never data. The project file, which is not rebuildable,
  // gets the careful treatment instead (data-formats §1.1).
});
