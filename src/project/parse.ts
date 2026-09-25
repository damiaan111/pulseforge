// Reading a `.pvproj` into a typed document (data-formats §1–2).
//
// Two kinds of failure, deliberately handled differently:
//
//  - **Refusals** throw. A file that is not JSON, not an object, or written by a newer
//    schema than this build understands. Half-parsing a future format and then saving over
//    it destroys data (data-formats §2.2), so there is no partial success here.
//  - **Everything else is an issue.** A wrong type, an out-of-range number, a modulation
//    pointing at a layer that no longer exists — reported with its path, repaired with a
//    documented fallback, and never silently dropped (CLAUDE.md constraint 4).
//
// Undeclared fields are collected into each node's `extra` and written back by serialize.ts,
// so a document that has been through a newer build survives a round-trip through this one.

import {
  ANCHORS, ASPECT_BUCKETS, ASSET_KINDS, BLEND_MODES, CURRENT_SCHEMA_VERSION, DEFAULT_CURVE, FADE_CURVES, type FadeCurve,
  LYRIC_ROLES, LYRICS_SOURCES, type LyricLine, type LyricLineStyle, type Lyrics, type LyricSection, type LyricWord,
  DEFAULT_ENVELOPE, DEFAULT_LOOK_AHEAD_MS, ENVELOPE_MODES, IDENTITY_TRANSFORM,
  DECISION_STEPS, DIRECTOR_LOCKS, MODULATION_MODES, QUANTISE_MODES, RESERVED_DOCUMENT_KEYS, SCALE_REFERENCES, walkLayers,
  type AnalysisSettings, type Anchor, type AspectBucket, type AspectOverride, type AssetKind, type AssetRef,
  type AudioSettings, type BandDefinition, type CanvasSettings, type CurveSpec,
  type DecisionEntry, type DirectorLock, type DirectorRoll, type DirectorState, type DocumentBlendMode, type GeneratedMark, type EffectSpec, type EnvelopeSpec, type Extra, type Layer,
  type ModulationBinding, type Palette, type ProjectDocument, type QuantiseSpec, type Range,
  type ScaleReference, type SourceSpec, type TimeRange, type Transform,
} from './document.ts';
import { isValidId } from './ids.ts';

export type IssueProblem =
  | 'missing'
  | 'wrong-type'
  | 'invalid-value'
  | 'unknown-field'
  | 'duplicate-id'
  | 'broken-reference';

export interface DocumentIssue {
  /** Where in the document, e.g. `layers[2].effects[0].params`. */
  readonly path: string;
  readonly problem: IssueProblem;
  readonly detail: string;
}

/** The file is not a Pulseforge project, or is too damaged to interpret. */
export class ProjectFormatError extends Error {
  override readonly name = 'ProjectFormatError';
}

/** The file was written by a newer schema version than this build understands. */
export class ProjectVersionError extends Error {
  override readonly name = 'ProjectVersionError';
  readonly fileVersion: number;
  readonly supportedVersion: number;

  constructor(fileVersion: number, supportedVersion: number) {
    super(
      `This project uses schema version ${fileVersion}, but this build understands up to ${supportedVersion}. ` +
        'Update Pulseforge to open it. It has not been modified.',
    );
    this.fileVersion = fileVersion;
    this.supportedVersion = supportedVersion;
  }
}

export interface ParseResult {
  readonly document: ProjectDocument;
  readonly issues: readonly DocumentIssue[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface NumberOptions {
  readonly min?: number;
  readonly max?: number;
  readonly integer?: boolean;
  readonly required?: boolean;
}

/**
 * A cursor over one JSON object. Every read marks its key as consumed; `rest()` then returns
 * what nothing asked for, which becomes that node's `extra`.
 */
class Node {
  private readonly seen = new Set<string>();
  private readonly raw: Record<string, unknown>;
  private readonly issues: DocumentIssue[];
  readonly path: string;

  constructor(raw: Record<string, unknown>, path: string, issues: DocumentIssue[]) {
    this.raw = raw;
    this.path = path;
    this.issues = issues;
  }

  private at(key: string): string {
    return this.path === '' ? key : `${this.path}.${key}`;
  }

  private report(key: string, problem: IssueProblem, detail: string): void {
    this.issues.push({ path: this.at(key), problem, detail });
  }

  /** Marks a key consumed without reading it — for fields handled by bespoke code. */
  take(key: string): unknown {
    this.seen.add(key);
    return this.raw[key];
  }

  private absent(key: string, fallback: unknown, required: boolean): boolean {
    const value = this.raw[key];
    if (value !== undefined && value !== null) return false;
    if (required) this.report(key, 'missing', `required; using ${JSON.stringify(fallback)}`);
    return true;
  }

  num(key: string, fallback: number, options: NumberOptions = {}): number {
    this.seen.add(key);
    if (this.absent(key, fallback, options.required === true)) return fallback;
    const value = this.raw[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      this.report(key, 'wrong-type', `expected a finite number, got ${JSON.stringify(value)}; using ${fallback}`);
      return fallback;
    }
    let out = value;
    if (options.integer === true && !Number.isInteger(out)) {
      this.report(key, 'invalid-value', `expected a whole number, got ${out}; rounding`);
      out = Math.round(out);
    }
    const { min, max } = options;
    if (min !== undefined && out < min) {
      this.report(key, 'invalid-value', `${out} is below the minimum ${min}; clamped`);
      out = min;
    }
    if (max !== undefined && out > max) {
      this.report(key, 'invalid-value', `${out} is above the maximum ${max}; clamped`);
      out = max;
    }
    return out;
  }

  /** An integer tick count (D10). Never a float — that is the drift this format exists to avoid. */
  ticks(key: string, fallback: number, options: NumberOptions = {}): number {
    return this.num(key, fallback, { ...options, integer: true, min: options.min ?? 0 });
  }

  /** A number that may be absent, meaning "not set" rather than a default. */
  nullableNum(key: string, options: NumberOptions = {}): number | null {
    this.seen.add(key);
    if (this.raw[key] === undefined || this.raw[key] === null) return null;
    return this.num(key, options.min ?? 0, options);
  }

  /** A tick count that may be null, meaning "to the end". */
  nullableTicks(key: string, options: NumberOptions = {}): number | null {
    this.seen.add(key);
    if (this.raw[key] === undefined || this.raw[key] === null) return null;
    return this.num(key, 0, { ...options, integer: true, min: options.min ?? 0 });
  }

  str(key: string, fallback: string, required = false): string {
    this.seen.add(key);
    if (this.absent(key, fallback, required)) return fallback;
    const value = this.raw[key];
    if (typeof value !== 'string') {
      this.report(key, 'wrong-type', `expected a string, got ${JSON.stringify(value)}; using ${JSON.stringify(fallback)}`);
      return fallback;
    }
    return value;
  }

  nullableStr(key: string): string | null {
    this.seen.add(key);
    const value = this.raw[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') {
      this.report(key, 'wrong-type', `expected a string or null, got ${JSON.stringify(value)}; using null`);
      return null;
    }
    return value;
  }

  bool(key: string, fallback: boolean): boolean {
    this.seen.add(key);
    if (this.absent(key, fallback, false)) return fallback;
    const value = this.raw[key];
    if (typeof value !== 'boolean') {
      this.report(key, 'wrong-type', `expected true or false, got ${JSON.stringify(value)}; using ${fallback}`);
      return fallback;
    }
    return value;
  }

  oneOf<T extends string>(key: string, options: readonly T[], fallback: T): T {
    this.seen.add(key);
    if (this.absent(key, fallback, false)) return fallback;
    const value = this.raw[key];
    if (typeof value === 'string' && (options as readonly string[]).includes(value)) return value as T;
    this.report(key, 'invalid-value', `expected one of ${options.join(' | ')}, got ${JSON.stringify(value)}; using ${fallback}`);
    return fallback;
  }

  /** An id: reported if malformed, but kept as-is — rewriting it would break every reference to it. */
  id(key: string, path: string): string {
    this.seen.add(key);
    const value = this.raw[key];
    if (typeof value === 'string' && value.length > 0) {
      if (!isValidId(value)) {
        this.report(key, 'invalid-value', `"${value}" is not a well-formed id; kept, since references point at it`);
      }
      return value;
    }
    this.report(key, 'missing', 'an id is required; references to this node cannot be resolved');
    return `missing:${path}`;
  }

  /** A nested object, or an empty one when absent — so defaults apply uniformly. */
  child(key: string): Node {
    this.seen.add(key);
    const value = this.raw[key];
    if (value === undefined || value === null) return new Node({}, this.at(key), this.issues);
    if (!isPlainObject(value)) {
      this.report(key, 'wrong-type', `expected an object, got ${JSON.stringify(value)}; using defaults`);
      return new Node({}, this.at(key), this.issues);
    }
    return new Node(value, this.at(key), this.issues);
  }

  /** A free-form record kept verbatim: module parameters, palette roles. */
  record(key: string): Record<string, unknown> {
    this.seen.add(key);
    const value = this.raw[key];
    if (value === undefined || value === null) return {};
    if (!isPlainObject(value)) {
      this.report(key, 'wrong-type', `expected an object, got ${JSON.stringify(value)}; using an empty one`);
      return {};
    }
    return { ...value };
  }

  /** Array elements as cursors. Non-object entries are reported and skipped. */
  children(key: string): Node[] {
    this.seen.add(key);
    const value = this.raw[key];
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
      this.report(key, 'wrong-type', `expected an array, got ${JSON.stringify(value)}; using an empty one`);
      return [];
    }
    const out: Node[] = [];
    value.forEach((entry, index) => {
      const at = `${this.at(key)}[${index}]`;
      if (!isPlainObject(entry)) {
        this.issues.push({ path: at, problem: 'wrong-type', detail: `expected an object, got ${JSON.stringify(entry)}; skipped` });
        return;
      }
      out.push(new Node(entry, at, this.issues));
    });
    return out;
  }

  strings(key: string): string[] {
    this.seen.add(key);
    const value = this.raw[key];
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
      this.report(key, 'wrong-type', `expected an array of strings, got ${JSON.stringify(value)}; using an empty one`);
      return [];
    }
    const out: string[] = [];
    value.forEach((entry, index) => {
      if (typeof entry !== 'string') {
        this.issues.push({ path: `${this.at(key)}[${index}]`, problem: 'wrong-type', detail: `expected a string, got ${JSON.stringify(entry)}; skipped` });
        return;
      }
      out.push(entry);
    });
    return out;
  }

  /**
   * Everything nothing asked for. Keys listed in `reserved` are preserved without an issue —
   * they are slots this version deliberately does not interpret; anything else is reported.
   */
  rest(reserved: readonly string[] = []): Extra {
    const extra: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(this.raw)) {
      if (this.seen.has(key)) continue;
      extra[key] = value;
      if (!reserved.includes(key)) {
        this.report(key, 'unknown-field', 'not declared by this schema version; preserved, ignored when rendering');
      }
    }
    return extra;
  }
}

// ---------------------------------------------------------------------------
// Node parsers
// ---------------------------------------------------------------------------

function rangeFrom(raw: unknown): Range | undefined {
  if (!isPlainObject(raw)) return undefined;
  const min = typeof raw['min'] === 'number' && Number.isFinite(raw['min']) ? raw['min'] : 0;
  const max = typeof raw['max'] === 'number' && Number.isFinite(raw['max']) ? raw['max'] : 1;
  return { min, max };
}

function parseTransform(node: Node): Transform {
  const t = node.child('transform');
  return {
    x: t.num('x', IDENTITY_TRANSFORM.x),
    y: t.num('y', IDENTITY_TRANSFORM.y),
    scaleX: t.num('scaleX', IDENTITY_TRANSFORM.scaleX),
    scaleY: t.num('scaleY', IDENTITY_TRANSFORM.scaleY),
    rotationDeg: t.num('rotationDeg', IDENTITY_TRANSFORM.rotationDeg),
    skewXDeg: t.num('skewXDeg', IDENTITY_TRANSFORM.skewXDeg),
    skewYDeg: t.num('skewYDeg', IDENTITY_TRANSFORM.skewYDeg),
    anchor: t.oneOf<Anchor>('anchor', ANCHORS, IDENTITY_TRANSFORM.anchor),
    scaleReference: t.oneOf<ScaleReference>('scaleReference', SCALE_REFERENCES, IDENTITY_TRANSFORM.scaleReference),
    extra: t.rest(),
  };
}

/** Only the keys actually present: an override must not freeze the properties it never touched. */
function parseTransformOverride(node: Node, issues: DocumentIssue[]): Partial<Omit<Transform, 'extra'>> {
  const raw = node.take('transform');
  if (raw === undefined || raw === null) return {};
  if (!isPlainObject(raw)) {
    issues.push({ path: `${node.path}.transform`, problem: 'wrong-type', detail: `expected an object, got ${JSON.stringify(raw)}; ignored` });
    return {};
  }
  const probe = new Node(raw, `${node.path}.transform`, issues);
  const full = {
    x: probe.num('x', IDENTITY_TRANSFORM.x),
    y: probe.num('y', IDENTITY_TRANSFORM.y),
    scaleX: probe.num('scaleX', IDENTITY_TRANSFORM.scaleX),
    scaleY: probe.num('scaleY', IDENTITY_TRANSFORM.scaleY),
    rotationDeg: probe.num('rotationDeg', IDENTITY_TRANSFORM.rotationDeg),
    skewXDeg: probe.num('skewXDeg', IDENTITY_TRANSFORM.skewXDeg),
    skewYDeg: probe.num('skewYDeg', IDENTITY_TRANSFORM.skewYDeg),
    anchor: probe.oneOf<Anchor>('anchor', ANCHORS, IDENTITY_TRANSFORM.anchor),
    scaleReference: probe.oneOf<ScaleReference>('scaleReference', SCALE_REFERENCES, IDENTITY_TRANSFORM.scaleReference),
  };
  probe.rest();
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(full)) {
    if (key in raw) out[key] = full[key as keyof typeof full];
  }
  return out as Partial<Omit<Transform, 'extra'>>;
}

function parseTimeRange(node: Node): TimeRange {
  const r = node.child('timeRange');
  return {
    inTicks: r.ticks('inTicks', 0),
    outTicks: r.nullableTicks('outTicks'),
    extra: r.rest(),
  };
}

function parseEffect(node: Node): EffectSpec {
  return {
    id: node.id('id', node.path),
    module: node.str('module', '', true),
    name: node.str('name', ''),
    enabled: node.bool('enabled', true),
    params: node.record('params'),
    paramsSchemaVersion: node.num('paramsSchemaVersion', 1, { integer: true, min: 0 }),
    extra: node.rest(),
  };
}

function parseSource(node: Node): SourceSpec {
  const s = node.child('source');
  return {
    // Not restricted to a known list: a source added by a newer build must survive a
    // round-trip here rather than being reset to `band` (modulation-spec §2).
    type: s.str('type', 'band'),
    stem: s.str('stem', 'mix'),
    band: s.nullableStr('band'),
    shape: s.str('shape', 'sine'),
    rateHz: s.num('rateHz', 1, { min: 0 }),
    phase: s.num('phase', 0),
    syncDivision: s.nullableNum('syncDivision', { min: 0 }),
    points: s.children('points')
      .map((p) => ({ ticks: p.ticks('ticks', 0), value: p.num('value', 0) }))
      .sort((a, b) => a.ticks - b.ticks),
    noiseScale: s.num('noiseScale', 1, { min: 0 }),
    octaves: s.num('octaves', 1, { integer: true, min: 1, max: 8 }),
    from: s.num('from', 0),
    to: s.num('to', 1),
    extra: s.rest(),
  };
}

function parseCurve(node: Node): CurveSpec {
  const c = node.child('curve');
  return { type: c.str('type', DEFAULT_CURVE.type), amount: c.num('amount', DEFAULT_CURVE.amount), extra: c.rest() };
}

function parseEnvelope(node: Node): EnvelopeSpec {
  const e = node.child('envelope');
  return {
    attackMs: e.num('attackMs', DEFAULT_ENVELOPE.attackMs, { min: 0 }),
    releaseMs: e.num('releaseMs', DEFAULT_ENVELOPE.releaseMs, { min: 0 }),
    mode: e.oneOf('mode', ENVELOPE_MODES, DEFAULT_ENVELOPE.mode),
    extra: e.rest(),
  };
}

function parseQuantise(node: Node, issues: DocumentIssue[]): QuantiseSpec | null {
  const raw = node.take('quantise');
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) {
    issues.push({ path: `${node.path}.quantise`, problem: 'wrong-type', detail: `expected an object or null, got ${JSON.stringify(raw)}; ignored` });
    return null;
  }
  const q = new Node(raw, `${node.path}.quantise`, issues);
  return {
    division: q.num('division', 1, { min: 0 }),
    mode: q.oneOf('mode', QUANTISE_MODES, 'trigger'),
    swing: q.num('swing', 0, { min: -1, max: 1 }),
    humanise: q.num('humanise', 0, { min: 0 }),
    extra: q.rest(),
  };
}

function parseBinding(node: Node, issues: DocumentIssue[]): ModulationBinding {
  const inputRangeRaw = node.take('inputRange');
  const parsedRange = rangeFrom(inputRangeRaw);
  const inputRange: Range | 'auto' = parsedRange ?? 'auto';
  if (parsedRange === undefined && inputRangeRaw !== undefined && inputRangeRaw !== null && inputRangeRaw !== 'auto') {
    issues.push({ path: `${node.path}.inputRange`, problem: 'invalid-value', detail: `expected {min,max} or "auto", got ${JSON.stringify(inputRangeRaw)}; using "auto"` });
  }

  return {
    id: node.id('id', node.path),
    enabled: node.bool('enabled', true),
    label: node.nullableStr('label'),
    source: parseSource(node),
    target: node.str('target', '', true),
    inputRange,
    curve: parseCurve(node),
    envelope: parseEnvelope(node),
    quantise: parseQuantise(node, issues),
    lookAheadMs: node.num('lookAheadMs', DEFAULT_LOOK_AHEAD_MS),
    amount: node.num('amount', 1),
    offset: node.num('offset', 0),
    invert: node.bool('invert', false),
    mode: node.oneOf('mode', MODULATION_MODES, 'add'),
    order: node.num('order', 0, { integer: true }),
    clampOutput: rangeFrom(node.take('clampOutput')) ?? null,
    // Dropped on purpose if present: transient UI state never belongs in the file
    // (modulation-spec §9.5). Listed as reserved so a stale file does not raise an issue.
    extra: node.rest(['bypass', 'solo']),
  };
}

function parseAspectOverrides(node: Node, issues: DocumentIssue[]): Partial<Record<AspectBucket, AspectOverride>> {
  const raw = node.take('aspectOverrides');
  if (raw === undefined || raw === null) return {};
  if (!isPlainObject(raw)) {
    issues.push({ path: `${node.path}.aspectOverrides`, problem: 'wrong-type', detail: `expected an object, got ${JSON.stringify(raw)}; ignored` });
    return {};
  }
  const out: Partial<Record<AspectBucket, AspectOverride>> = {};
  for (const [bucket, value] of Object.entries(raw)) {
    const at = `${node.path}.aspectOverrides.${bucket}`;
    if (!(ASPECT_BUCKETS as readonly string[]).includes(bucket)) {
      issues.push({ path: at, problem: 'invalid-value', detail: `"${bucket}" is not an aspect bucket (${ASPECT_BUCKETS.join(', ')}); ignored for rendering` });
      continue;
    }
    if (!isPlainObject(value)) {
      issues.push({ path: at, problem: 'wrong-type', detail: `expected an object, got ${JSON.stringify(value)}; ignored` });
      continue;
    }
    const o = new Node(value, at, issues);
    out[bucket as AspectBucket] = {
      transform: parseTransformOverride(o, issues),
      params: o.record('params'),
      extra: o.rest(),
    };
  }
  return out;
}

function parseLayer(node: Node, issues: DocumentIssue[]): Layer {
  const kind = node.oneOf('kind', ['module', 'group'] as const, 'module');
  const base = {
    id: node.id('id', node.path),
    name: node.str('name', ''),
    enabled: node.bool('enabled', true),
    locked: node.bool('locked', false),
    soloed: node.bool('soloed', false),
    timeRange: parseTimeRange(node),
    transform: parseTransform(node),
    blend: node.oneOf<DocumentBlendMode>('blend', BLEND_MODES, 'normal'),
    opacity: node.num('opacity', 1, { min: 0, max: 1 }),
    maskLayerId: node.nullableStr('maskLayerId'),
    effects: node.children('effects').map(parseEffect),
    modulations: node.children('modulations').map((n) => parseBinding(n, issues)),
    aspectOverrides: parseAspectOverrides(node, issues),
  };

  if (kind === 'group') {
    return {
      ...base,
      kind: 'group',
      collapsed: node.bool('collapsed', false),
      children: node.children('children').map((n) => parseLayer(n, issues)),
      extra: node.rest(),
    };
  }
  return {
    ...base,
    kind: 'module',
    module: node.str('module', '', true),
    params: node.record('params'),
    paramsSchemaVersion: node.num('paramsSchemaVersion', 1, { integer: true, min: 0 }),
    extra: node.rest(),
  };
}

function parseCanvas(node: Node): CanvasSettings {
  const c = node.child('canvas');
  const fps = c.child('fps');
  const num = fps.num('num', 60, { integer: true, min: 1, required: true });
  const den = fps.num('den', 1, { integer: true, min: 1 });
  fps.rest();
  return {
    width: c.num('width', 1920, { integer: true, min: 2, required: true }),
    height: c.num('height', 1080, { integer: true, min: 2, required: true }),
    fps: { num, den },
    background: c.str('background', '#000000'),
    extra: c.rest(),
  };
}

function parseAudio(node: Node): AudioSettings {
  const a = node.child('audio');
  return {
    path: a.str('path', ''),
    hash: a.str('hash', ''),
    durationTicks: a.ticks('durationTicks', 0),
    leadInTicks: a.ticks('leadInTicks', 0),
    leadOutTicks: a.ticks('leadOutTicks', 0),
    clipInTicks: a.ticks('clipInTicks', 0),
    clipOutTicks: a.nullableTicks('clipOutTicks'),
    fadeInTicks: a.ticks('fadeInTicks', 0),
    fadeOutTicks: a.ticks('fadeOutTicks', 0),
    fadeInCurve: a.oneOf<FadeCurve>('fadeInCurve', FADE_CURVES, 'equal-power'),
    fadeOutCurve: a.oneOf<FadeCurve>('fadeOutCurve', FADE_CURVES, 'equal-power'),
    gain: a.num('gain', 1, { min: 0 }),
    stemsEnabled: a.bool('stemsEnabled', false),
    extra: a.rest(),
  };
}

function parseAnalysisSettings(node: Node): AnalysisSettings {
  const s = node.child('analysisSettings');
  const bands: BandDefinition[] = s.children('bands').map((b) => ({
    id: b.str('id', '', true),
    label: b.str('label', ''),
    minHz: b.num('minHz', 0, { min: 0 }),
    maxHz: b.num('maxHz', 24_000, { min: 0 }),
    gain: b.num('gain', 1),
    extra: b.rest(),
  }));
  return {
    fftSize: s.num('fftSize', 2048, { integer: true, min: 256 }),
    bands,
    onsetSensitivity: s.num('onsetSensitivity', 0.5, { min: 0, max: 1 }),
    bpmOverride: s.nullableNum('bpmOverride', { min: 1 }),
    stemModel: s.str('stemModel', 'htdemucs'),
    extra: s.rest(),
  };
}

function parsePalette(node: Node, issues: DocumentIssue[]): Palette {
  const p = node.child('palette');
  const colors = p.strings('colors');
  const rolesRaw = p.record('roles');
  const roles: Record<string, number> = {};
  for (const [role, value] of Object.entries(rolesRaw)) {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      issues.push({ path: `${p.path}.roles.${role}`, problem: 'wrong-type', detail: `expected a colour index, got ${JSON.stringify(value)}; ignored` });
      continue;
    }
    if (value < 0 || value >= colors.length) {
      issues.push({ path: `${p.path}.roles.${role}`, problem: 'broken-reference', detail: `index ${value} is outside the ${colors.length}-colour palette; the role will fall back to the module default` });
    }
    roles[role] = value;
  }
  return { colors, roles, extra: p.rest() };
}

function parseAsset(node: Node, issues: DocumentIssue[]): AssetRef {
  const kind = node.str('kind', 'image');
  if (!(ASSET_KINDS as readonly string[]).includes(kind)) {
    issues.push({ path: `${node.path}.kind`, problem: 'invalid-value', detail: `unknown asset kind "${kind}"; kept, and not usable by this version` });
  }
  const path = node.str('path', '');
  if (path === '') issues.push({ path: `${node.path}.path`, problem: 'missing', detail: 'an asset needs a file path; layers using it will report it missing' });
  return {
    id: node.id('id', node.path),
    kind: kind as AssetKind,
    path,
    hash: node.str('hash', ''),
    size: node.num('size', 0, { integer: true, min: 0 }),
    name: node.str('name', ''),
    extra: node.rest(),
  };
}

/**
 * Lyrics (lyrics-spec §1). Times are whole ticks or null (untimed); a line whose end is before its
 * start is reported and its end moved to the start, never swapped — swapping would invent a timing
 * nobody set. Line breaks inside a line are joined: a line is one line, wrapping is the layer's job.
 */
/**
 * The director's record (auto-director-spec §8–§9). Nothing in it affects a render — the project
 * it made is ordinary layers — so a damaged record is repaired with defaults and reported, never
 * a reason to refuse the file.
 */
function parseDirector(node: Node): DirectorState {
  const roll = (n: Node): DirectorRoll => {
    const seeds = n.child('seeds');
    return {
      seed: n.num('seed', 0, { integer: true }),
      templateId: n.str('templateId', ''),
      seeds: {
        palette: seeds.num('palette', 0, { integer: true }),
        layout: seeds.num('layout', 0, { integer: true }),
        motion: seeds.num('motion', 0, { integer: true }),
      },
      locks: n.strings('locks').filter((lock): lock is DirectorLock => (DIRECTOR_LOCKS as readonly string[]).includes(lock)),
      palette: n.strings('palette'),
      summary: n.str('summary', ''),
      extra: n.rest(),
    };
  };
  return {
    current: roll(node.child('current')),
    history: node.children('history').map(roll),
    log: node.children('log').map((n): DecisionEntry => ({
      step: n.oneOf('step', DECISION_STEPS, 'populate'),
      text: n.str('text', ''),
      data: n.record('data'),
    })),
    generated: node.children('generated').map((n): GeneratedMark => ({
      id: n.str('id', ''),
      kind: n.oneOf('kind', ['layer', 'effect', 'binding'] as const, 'layer'),
      slot: n.str('slot', ''),
      fingerprint: n.str('fingerprint', ''),
    })),
    extra: node.rest(),
  };
}

function parseLyrics(node: Node, issues: DocumentIssue[]): Lyrics {
  const lines = node.children('lines').map((n): LyricLine => {
    const rawText = n.str('text', '');
    const text = rawText.replace(/\s*[\r\n]+\s*/g, ' ');
    if (text !== rawText) issues.push({ path: `${n.path}.text`, problem: 'invalid-value', detail: 'a lyric line cannot contain line breaks; joined with spaces' });
    const startTicks = n.nullableTicks('startTicks');
    let endTicks = n.nullableTicks('endTicks');
    if (startTicks !== null && endTicks !== null && endTicks < startTicks) {
      issues.push({ path: `${n.path}.endTicks`, problem: 'invalid-value', detail: `ends (${endTicks}) before it starts (${startTicks}); end moved to the start` });
      endTicks = startTicks;
    }
    const words = n.children('words').map((w): LyricWord => {
      const start = w.ticks('startTicks', 0);
      let end = w.ticks('endTicks', start);
      if (end < start) {
        issues.push({ path: `${w.path}.endTicks`, problem: 'invalid-value', detail: `ends (${end}) before it starts (${start}); end moved to the start` });
        end = start;
      }
      return {
        id: w.id('id', w.path),
        text: w.str('text', ''),
        startTicks: start,
        endTicks: end,
        confidence: w.nullableNum('confidence', { min: 0, max: 1 }),
        extra: w.rest(),
      };
    });
    const styleRaw = n.take('style');
    let style: LyricLineStyle | null = null;
    if (styleRaw !== undefined && styleRaw !== null) {
      if (!isPlainObject(styleRaw)) issues.push({ path: `${n.path}.style`, problem: 'wrong-type', detail: 'expected an object or null; the line uses the layer style' });
      const s = new Node(isPlainObject(styleRaw) ? styleRaw : {}, `${n.path}.style`, issues);
      style = {
        scale: s.nullableNum('scale', { min: 0.05, max: 10 }),
        opacity: s.nullableNum('opacity', { min: 0, max: 1 }),
        offsetX: s.nullableNum('offsetX', { min: -100 }),
        offsetY: s.nullableNum('offsetY', { min: -100 }),
        color: s.nullableStr('color'),
        extra: s.rest(),
      };
    }
    return {
      id: n.id('id', n.path),
      text,
      startTicks,
      endTicks,
      words,
      role: n.oneOf('role', LYRIC_ROLES, 'lead'),
      style,
      confidence: n.nullableNum('confidence', { min: 0, max: 1 }),
      locked: n.bool('locked', false),
      extra: n.rest(),
    };
  });
  const sections = node.children('sections').map((n): LyricSection => ({
    id: n.id('id', n.path),
    label: n.str('label', ''),
    beforeLineId: n.nullableStr('beforeLineId'),
    extra: n.rest(),
  }));
  return {
    language: node.str('language', 'en'),
    source: node.oneOf('source', LYRICS_SOURCES, 'manual'),
    lines,
    sections,
    extra: node.rest(),
  };
}

// ---------------------------------------------------------------------------
// Cross-references
// ---------------------------------------------------------------------------

/** A modulation target path: `layers.<id>.params.<key>` or `…effects.<id>.params.<key>` (module-spec §4). */
function targetLayerId(target: string): string | undefined {
  const parts = target.split('.');
  return parts[0] === 'layers' ? parts[1] : undefined;
}

/**
 * Ids must be unique and references must resolve. Both are reported, never repaired by
 * deletion: a binding whose target vanished is the user's work, and silently removing it
 * is exactly the bug module-spec §4 warns about.
 */
function checkReferences(document: ProjectDocument, issues: DocumentIssue[]): void {
  const layerIds = new Set<string>();
  const seenIds = new Map<string, string>();

  const claim = (id: string, path: string): void => {
    const first = seenIds.get(id);
    if (first !== undefined) {
      issues.push({ path, problem: 'duplicate-id', detail: `id "${id}" is already used by ${first}; references to it are ambiguous` });
      return;
    }
    seenIds.set(id, path);
  };

  let index = 0;
  for (const { layer } of walkLayers(document.layers)) {
    const path = `layers[${index}]`;
    index += 1;
    claim(layer.id, path);
    layerIds.add(layer.id);
    for (const effect of layer.effects) claim(effect.id, `${path}.effects.${effect.id}`);
    for (const binding of layer.modulations) claim(binding.id, `${path}.modulations.${binding.id}`);
  }
  for (const effect of document.globalEffects) claim(effect.id, `globalEffects.${effect.id}`);
  for (const asset of document.assets) claim(asset.id, `assets.${asset.id}`);
  for (const binding of document.globalModulations) claim(binding.id, `globalModulations.${binding.id}`);
  document.lyrics.lines.forEach((line, i) => {
    claim(line.id, `lyrics.lines[${i}]`);
    line.words.forEach((word, j) => claim(word.id, `lyrics.lines[${i}].words[${j}]`));
  });
  const lineIds = new Set(document.lyrics.lines.map((line) => line.id));
  document.lyrics.sections.forEach((section, i) => {
    claim(section.id, `lyrics.sections[${i}]`);
    if (section.beforeLineId !== null && !lineIds.has(section.beforeLineId)) {
      issues.push({ path: `lyrics.sections[${i}].beforeLineId`, problem: 'broken-reference', detail: `no lyric line with id "${section.beforeLineId}"; the marker is kept and shown at the end` });
    }
  });

  index = 0;
  for (const { layer } of walkLayers(document.layers)) {
    const path = `layers[${index}]`;
    index += 1;
    if (layer.maskLayerId !== null && !layerIds.has(layer.maskLayerId)) {
      issues.push({ path: `${path}.maskLayerId`, problem: 'broken-reference', detail: `no layer with id "${layer.maskLayerId}"; the layer renders unmasked` });
    }
  }

  const allBindings = [
    ...[...walkLayers(document.layers)].flatMap(({ layer }) => layer.modulations.map((b) => ({ b, where: `layers.${layer.id}` }))),
    ...document.globalModulations.map((b) => ({ b, where: 'globalModulations' })),
  ];
  for (const { b, where } of allBindings) {
    if (b.target === '') continue; // already reported as missing
    const id = targetLayerId(b.target);
    if (id !== undefined && !layerIds.has(id)) {
      issues.push({ path: `${where}.modulations.${b.id}.target`, problem: 'broken-reference', detail: `"${b.target}" points at layer "${id}", which is not in this project; the binding is kept and inactive` });
    }
  }
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Parses an already-migrated document object. Callers loading a file should use
 * `loadDocument` in load.ts, which runs the migration chain first.
 */
export function parseDocument(raw: unknown): ParseResult {
  if (!isPlainObject(raw)) {
    throw new ProjectFormatError(`A project must be a JSON object, but this file contains ${Array.isArray(raw) ? 'an array' : typeof raw}.`);
  }
  const version = raw['schemaVersion'];
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw new ProjectFormatError('This file has no integer "schemaVersion" field, so it is not a Pulseforge project.');
  }
  if (version > CURRENT_SCHEMA_VERSION) throw new ProjectVersionError(version, CURRENT_SCHEMA_VERSION);

  const issues: DocumentIssue[] = [];
  const root = new Node(raw, '', issues);
  root.take('schemaVersion');

  const document: ProjectDocument = {
    schemaVersion: version,
    id: root.id('id', 'project'),
    name: root.str('name', 'Untitled'),
    createdAt: root.str('createdAt', ''),
    modifiedAt: root.str('modifiedAt', ''),
    appVersion: root.str('appVersion', ''),
    seed: root.num('seed', 0, { integer: true }),
    canvas: parseCanvas(root),
    audio: parseAudio(root),
    analysisSettings: parseAnalysisSettings(root),
    palette: parsePalette(root, issues),
    layers: root.children('layers').map((n) => parseLayer(n, issues)),
    globalEffects: root.children('globalEffects').map(parseEffect),
    globalModulations: root.children('globalModulations').map((n) => parseBinding(n, issues)),
    assets: root.children('assets').map((n) => parseAsset(n, issues)),
    lyrics: parseLyrics(root.child('lyrics'), issues),
    director: root.take('director') === undefined || root.take('director') === null ? null : parseDirector(root.child('director')),
    extra: root.rest(RESERVED_DOCUMENT_KEYS),
  };

  checkReferences(document, issues);
  return { document, issues };
}
