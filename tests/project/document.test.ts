// Project document v1: parsing, issue reporting, round-tripping and unknown-field
// preservation (data-formats §1–2).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { createDocument, createModuleLayer } from '../../src/project/create.ts';
import { aspectBucket, CURRENT_SCHEMA_VERSION, walkLayers } from '../../src/project/document.ts';
import { createTestIdFactory, createIdFactory, ID_LENGTH, isValidId } from '../../src/project/ids.ts';
import { loadDocument } from '../../src/project/load.ts';
import { parseDocument, ProjectFormatError, ProjectVersionError, type DocumentIssue } from '../../src/project/parse.ts';
import { stringifyDocument, toJson } from '../../src/project/serialize.ts';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

/** A minimal document object, as a hand-written file would look. */
function minimalRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: '0000000000P000000000000001',
    name: 'Minimal',
    canvas: { width: 1280, height: 720, fps: { num: 30, den: 1 } },
    layers: [],
    ...overrides,
  };
}

const problems = (issues: readonly DocumentIssue[], path: string): string[] =>
  issues.filter((i) => i.path === path).map((i) => i.problem);

describe('ids', () => {
  it('generates sortable, valid, unique ids', () => {
    let clock = 1_700_000_000_000;
    let counter = 0;
    const factory = createIdFactory({
      now: () => (clock += 1),
      randomBytes: (into) => {
        counter += 1;
        into.fill(counter % 256);
      },
    });
    const ids = Array.from({ length: 5 }, factory);
    expect(ids.every(isValidId)).toBe(true);
    expect(ids.every((id) => id.length === ID_LENGTH)).toBe(true);
    expect(new Set(ids).size).toBe(5);
    // Later ids sort after earlier ones — that is the whole point of the timestamp prefix.
    expect([...ids].sort()).toEqual(ids);
  });

  it('rejects ids outside the Crockford alphabet', () => {
    // I, L, O and U are deliberately absent from Crockford base32.
    expect(isValidId('0000000000I000000000000001')).toBe(false);
    expect(isValidId('short')).toBe(false);
    expect(isValidId(42)).toBe(false);
  });

  it('produces valid ids from the test factory', () => {
    const next = createTestIdFactory('K');
    const ids = [next(), next()];
    expect(ids.every(isValidId)).toBe(true);
    expect(ids[0]).toBe('0000000000K000000000000001');
  });
});

describe('parseDocument — refusals', () => {
  it('refuses a file that is not an object', () => {
    expect(() => parseDocument([])).toThrow(ProjectFormatError);
    expect(() => parseDocument('nope')).toThrow(ProjectFormatError);
  });

  it('refuses a file with no schemaVersion', () => {
    expect(() => parseDocument({ name: 'x' })).toThrow(ProjectFormatError);
  });

  it('refuses a document from a newer schema rather than half-parsing it', () => {
    const attempt = () => parseDocument(minimalRaw({ schemaVersion: CURRENT_SCHEMA_VERSION + 3 }));
    expect(attempt).toThrow(ProjectVersionError);
    // The message has to say what to do, and that nothing was touched (data-formats §2.2).
    expect(attempt).toThrow(/has not been modified/);
  });
});

describe('parseDocument — repairs are reported, never silent', () => {
  it('reports a missing required field and falls back', () => {
    const { document, issues } = parseDocument(minimalRaw({ canvas: { height: 720 } }));
    expect(document.canvas.width).toBe(1920);
    expect(problems(issues, 'canvas.width')).toEqual(['missing']);
  });

  it('clamps an out-of-range opacity and says so', () => {
    const raw = minimalRaw({
      layers: [{ id: '0000000000K000000000000001', kind: 'module', module: 'core.visualizer.bars', opacity: 3 }],
    });
    const { document, issues } = parseDocument(raw);
    expect(document.layers[0]?.opacity).toBe(1);
    expect(problems(issues, 'layers[0].opacity')).toEqual(['invalid-value']);
  });

  it('rounds a fractional tick count rather than storing a float', () => {
    const { document, issues } = parseDocument(minimalRaw({ audio: { leadInTicks: 1200.7 } }));
    expect(document.audio.leadInTicks).toBe(1201);
    expect(problems(issues, 'audio.leadInTicks')).toEqual(['invalid-value']);
  });

  it('falls back on an unknown enum value', () => {
    const raw = minimalRaw({
      layers: [{ id: '0000000000K000000000000001', kind: 'module', module: 'm', blend: 'divide' }],
    });
    const { document, issues } = parseDocument(raw);
    expect(document.layers[0]?.blend).toBe('normal');
    expect(problems(issues, 'layers[0].blend')).toEqual(['invalid-value']);
  });

  it('keeps a malformed id, because references point at it', () => {
    const raw = minimalRaw({ layers: [{ id: 'legacy-id', kind: 'module', module: 'm' }] });
    const { document, issues } = parseDocument(raw);
    expect(document.layers[0]?.id).toBe('legacy-id');
    expect(problems(issues, 'layers[0].id')).toEqual(['invalid-value']);
  });

  it('reports duplicate ids instead of letting references go ambiguous', () => {
    const raw = minimalRaw({
      layers: [
        { id: '0000000000K000000000000001', kind: 'module', module: 'm' },
        { id: '0000000000K000000000000001', kind: 'module', module: 'm' },
      ],
    });
    const { issues } = parseDocument(raw);
    expect(issues.some((i) => i.problem === 'duplicate-id')).toBe(true);
  });

  it('keeps a modulation whose target layer is gone, and reports it', () => {
    const raw = minimalRaw({
      layers: [{
        id: '0000000000K000000000000001',
        kind: 'module',
        module: 'm',
        modulations: [{
          id: '0000000000M000000000000001',
          target: 'layers.0000000000K000000000000009.params.glow',
        }],
      }],
    });
    const { document, issues } = parseDocument(raw);
    // Preserved (CLAUDE.md constraint 4) — a binding that vanishes is an hour of chasing.
    expect(document.layers[0]?.modulations).toHaveLength(1);
    expect(issues.some((i) => i.problem === 'broken-reference' && i.detail.includes('kept and inactive'))).toBe(true);
  });

  it('reports a mask pointing at a layer that does not exist', () => {
    const raw = minimalRaw({
      layers: [{ id: '0000000000K000000000000001', kind: 'module', module: 'm', maskLayerId: '0000000000K000000000000002' }],
    });
    const { issues } = parseDocument(raw);
    expect(problems(issues, 'layers[0].maskLayerId')).toEqual(['broken-reference']);
  });

  it('reports a palette role pointing outside the palette', () => {
    const raw = minimalRaw({ palette: { colors: ['#ffffff'], roles: { glow: 4 } } });
    const { document, issues } = parseDocument(raw);
    expect(document.palette.roles['glow']).toBe(4);
    expect(problems(issues, 'palette.roles.glow')).toEqual(['broken-reference']);
  });

  it('drops transient UI state from a stale file without complaining about it', () => {
    const raw = minimalRaw({
      layers: [{
        id: '0000000000K000000000000001',
        kind: 'module',
        module: 'm',
        modulations: [{ id: '0000000000M000000000000001', target: 'layers.0000000000K000000000000001.params.x', bypass: true, solo: true }],
      }],
    });
    const { issues } = parseDocument(raw);
    expect(issues.filter((i) => i.problem === 'unknown-field')).toHaveLength(0);
  });
});

describe('unknown fields are preserved, not stripped', () => {
  it('reports and round-trips fields a newer build wrote', () => {
    const raw = minimalRaw({
      futureTopLevel: { a: 1 },
      canvas: { width: 1280, height: 720, fps: { num: 30, den: 1 }, futureCanvasField: 'x' },
      layers: [{ id: '0000000000K000000000000001', kind: 'module', module: 'm', futureLayerField: [1, 2] }],
    });
    const { document, issues } = parseDocument(raw);

    expect(problems(issues, 'futureTopLevel')).toEqual(['unknown-field']);
    expect(problems(issues, 'canvas.futureCanvasField')).toEqual(['unknown-field']);
    expect(problems(issues, 'layers[0].futureLayerField')).toEqual(['unknown-field']);

    const written = toJson(document);
    expect(written['futureTopLevel']).toEqual({ a: 1 });
    expect((written['canvas'] as Record<string, unknown>)['futureCanvasField']).toBe('x');
    const layer = (written['layers'] as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(layer['futureLayerField']).toEqual([1, 2]);
  });

  it('carries reserved later-phase slots through without reporting them', () => {
    const raw = minimalRaw({ lyrics: { lines: [] }, automation: [], exportPresets: [{ name: 'YouTube 4K' }], assets: [] });
    const { document, issues } = parseDocument(raw);
    expect(issues.filter((i) => i.problem === 'unknown-field')).toHaveLength(0);
    expect(toJson(document)['exportPresets']).toEqual([{ name: 'YouTube 4K' }]);
  });
});

describe('round-trip', () => {
  it('parses, serialises and re-parses the full fixture to an identical document', () => {
    const first = loadDocument(fixture('v1-full.pvproj'));
    expect(first.issues).toEqual([]);
    expect(first.migratedFrom).toBeNull();

    const text = stringifyDocument(first.document);
    const second = loadDocument(text);
    expect(second.issues).toEqual([]);
    expect(second.document).toEqual(first.document);
    // Serialisation is stable: the same document always produces the same bytes, so a git
    // diff shows the edit rather than a reshuffle (data-formats §1.1).
    expect(stringifyDocument(second.document)).toBe(text);
  });

  it('reads the structure of the fixture as written', () => {
    const { document } = loadDocument(fixture('v1-full.pvproj'));
    const layers = [...walkLayers(document.layers)].map(({ layer }) => layer.id);
    expect(layers).toEqual([
      '0000000000K000000000000001',
      '0000000000G000000000000001',
      '0000000000K000000000000002',
    ]);
    const group = document.layers[1];
    expect(group?.kind).toBe('group');
    expect(document.layers[0]?.aspectOverrides['9:16']?.transform).toEqual({ y: 0.62 });
    expect(document.audio.clipOutTicks).toBe(11_472_000);
  });

  it('round-trips a document built in code', () => {
    const base = createDocument({ id: '0000000000P000000000000001', timestamp: '2026-09-14T00:00:00.000Z', seed: 7 });
    const document = { ...base, layers: [createModuleLayer('core.visualizer.bars', { id: '0000000000K000000000000001' })] };
    const { document: reloaded, issues } = loadDocument(stringifyDocument(document));
    expect(issues).toEqual([]);
    expect(reloaded).toEqual(document);
  });

  it('ends the file with a newline', () => {
    expect(stringifyDocument(createDocument({ timestamp: '2026-09-14T00:00:00.000Z' }))).toMatch(/}\n$/);
  });
});

describe('aspectBucket', () => {
  it('classifies the shapes that carry overrides', () => {
    expect(aspectBucket(1920, 1080)).toBe('16:9');
    expect(aspectBucket(1280, 720)).toBe('16:9');
    expect(aspectBucket(1080, 1920)).toBe('9:16');
    expect(aspectBucket(1080, 1080)).toBe('1:1');
    expect(aspectBucket(1080, 1350)).toBe('4:5');
    expect(aspectBucket(2000, 1000)).toBe('custom');
  });
});

describe('curve points round-trip', () => {
  it('saves only a curve’s points, sorted, and reads them back', async () => {
    const { createBinding } = await import('../../src/project/create.ts');
    const plain = createBinding('layers.K1.params.glow', { id: 'B1' });
    const curve = { ...plain, id: 'B2', source: { ...plain.source, type: 'curve', points: [{ ticks: 96_000, value: 1 }, { ticks: 0, value: 0.5 }] } };
    const doc = { ...createDocument({ timestamp: '2026-09-25T00:00:00.000Z' }), globalModulations: [plain, curve] };
    const json = JSON.parse(stringifyDocument(doc));
    expect('points' in json.globalModulations[0].source).toBe(false);
    const back = parseDocument(json).document;
    expect(back.globalModulations[1]!.source.points).toEqual([{ ticks: 0, value: 0.5 }, { ticks: 96_000, value: 1 }]);
    expect(back.globalModulations[0]!.source.points).toEqual([]);
  });
});
