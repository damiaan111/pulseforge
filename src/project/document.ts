// The `.pvproj` document, schema version 1 (PROJECT.md §7, data-formats §1).
//
// Shape rules this file encodes, all of which exist to keep the format alive for years:
//  - Times are integer ticks of 1/48000 s (D10); fps is a rational (export-spec §2).
//  - Every addressable thing carries an opaque, never-reused id (data-formats §1.4).
//  - Every node carries an `extra` bag of fields this version did not declare. They are
//    preserved and written back untouched, so a document saved by a newer build and opened
//    by an older one loses nothing (data-formats §2.2, CLAUDE.md constraint 4).
//  - Nothing here is a class and nothing mutates: edits go through commands in a later step,
//    and the engine only ever sees the snapshot produced by `toRenderProject`.
//
// Slots specified for later phases (lyrics, automation, export presets, the asset library)
// are listed in RESERVED_DOCUMENT_KEYS rather than typed here. They round-trip verbatim and
// are not reported as unknown, because their absence from this version is deliberate, not a
// mistake in the file.

import { ANCHORS, SCALE_REFERENCES, type Anchor, type ScaleReference } from '../engine/core/layout.ts';
import type { Rational } from '../engine/core/time.ts';

export const CURRENT_SCHEMA_VERSION = 1;

/** The lowest version this build can still read and migrate forward. */
export const OLDEST_SUPPORTED_SCHEMA_VERSION = 1;

/**
 * Document-level fields specified elsewhere and not yet interpreted by this version.
 * Carried through saves untouched; see the file header.
 */
export const RESERVED_DOCUMENT_KEYS: readonly string[] = [
  'lyrics', // lyrics-spec, P6
  'automation', // PROJECT.md S1, keyframe tracks
  'exportPresets', // export-spec §12, P5
  'assets', // M40 managed asset library, P4
];

/** Undeclared fields preserved verbatim from the file (data-formats §2.2). */
export type Extra = Readonly<Record<string, unknown>>;

// ---------------------------------------------------------------------------
// Canvas, audio, analysis, palette
// ---------------------------------------------------------------------------

/**
 * Aspect buckets a layer can carry overrides for (PROJECT.md §8.11).
 * `custom` catches every canvas that is not one of the named shapes.
 */
export const ASPECT_BUCKETS = ['16:9', '9:16', '1:1', '4:5', 'custom'] as const;
export type AspectBucket = (typeof ASPECT_BUCKETS)[number];

export interface CanvasSettings {
  readonly width: number;
  readonly height: number;
  readonly fps: Rational;
  /** sRGB hex, opaque. */
  readonly background: string;
  readonly extra: Extra;
}

/**
 * The audio clip and its placement on the timeline (PROJECT.md §8.10).
 * Timeline time is the master coordinate; every analysis read maps through `leadInTicks`
 * and `clipInTicks` via `timelineToSourceSeconds`.
 */
export interface AudioSettings {
  /** Relative to the project file when possible, absolute otherwise (data-formats §1.2). */
  readonly path: string;
  /** sha256 of the decoded PCM, so a re-encode of the same audio still matches. */
  readonly hash: string;
  readonly durationTicks: number;
  /** Silence before the audio starts on the timeline. */
  readonly leadInTicks: number;
  /** Silence after it ends. Part of the rendered duration. */
  readonly leadOutTicks: number;
  /** Trim into the source file. */
  readonly clipInTicks: number;
  /** End of the trim, or null for "to the end of the file". */
  readonly clipOutTicks: number | null;
  readonly fadeInTicks: number;
  readonly fadeOutTicks: number;
  /** Linear gain applied to the exported audio. */
  readonly gain: number;
  readonly stemsEnabled: boolean;
  readonly extra: Extra;
}

export interface BandDefinition {
  readonly id: string;
  readonly label: string;
  readonly minHz: number;
  readonly maxHz: number;
  readonly gain: number;
  readonly extra: Extra;
}

export interface AnalysisSettings {
  readonly fftSize: number;
  readonly bands: readonly BandDefinition[];
  readonly onsetSensitivity: number;
  /** Overrides detected tempo when the grid is wrong; null to use detection. */
  readonly bpmOverride: number | null;
  readonly stemModel: string;
  readonly extra: Extra;
}

/**
 * The project palette (M17). Roles map a name a module asks for — "primary", "glow" — to an
 * index into `colors`, so recolouring the whole project is one edit.
 */
export interface Palette {
  /** sRGB hex strings. */
  readonly colors: readonly string[];
  readonly roles: Readonly<Record<string, number>>;
  readonly extra: Extra;
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

export type LayerKind = 'module' | 'group';

export const BLEND_MODES = ['normal', 'add', 'screen', 'multiply', 'overlay'] as const;
export type DocumentBlendMode = (typeof BLEND_MODES)[number];

// Anchors and scale references are defined by the engine's layout module, which is what
// consumes them; re-exported here so document code has one import site and the two can
// never drift apart.
export { ANCHORS, SCALE_REFERENCES };
export type { Anchor, ScaleReference };

/**
 * Position and size as fractions of the canvas, never pixels, so scaling to any resolution
 * or aspect is correct by construction. `x`/`y` place the layer's `anchor` point, measured
 * from the top-left in 0..1 of canvas width/height.
 */
export interface Transform {
  readonly x: number;
  readonly y: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly rotationDeg: number;
  readonly skewXDeg: number;
  readonly skewYDeg: number;
  readonly anchor: Anchor;
  readonly scaleReference: ScaleReference;
  readonly extra: Extra;
}

export const IDENTITY_TRANSFORM: Transform = {
  x: 0.5,
  y: 0.5,
  scaleX: 1,
  scaleY: 1,
  rotationDeg: 0,
  skewXDeg: 0,
  skewYDeg: 0,
  anchor: 'center',
  scaleReference: 'min',
  extra: {},
};

/** When a layer is on screen. `outTicks: null` means "to the end of the timeline". */
export interface TimeRange {
  readonly inTicks: number;
  readonly outTicks: number | null;
  readonly extra: Extra;
}

export const FULL_TIME_RANGE: TimeRange = { inTicks: 0, outTicks: null, extra: {} };

export interface EffectSpec {
  readonly id: string;
  readonly module: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly params: Readonly<Record<string, unknown>>;
  readonly paramsSchemaVersion: number;
  readonly extra: Extra;
}

/**
 * Per-aspect overrides (PROJECT.md §8.11). Only the properties actually edited while that
 * aspect was active are stored; everything else inherits the base. `transform` is a partial
 * so "I moved the logo in vertical" does not freeze its scale at the value it had that day.
 */
export interface AspectOverride {
  readonly transform: Partial<Omit<Transform, 'extra'>>;
  readonly params: Readonly<Record<string, unknown>>;
  readonly extra: Extra;
}

export interface BaseLayer {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly locked: boolean;
  readonly soloed: boolean;
  readonly timeRange: TimeRange;
  readonly transform: Transform;
  readonly blend: DocumentBlendMode;
  readonly opacity: number;
  /** Another layer used as this one's mask (S7); null when unmasked. */
  readonly maskLayerId: string | null;
  readonly effects: readonly EffectSpec[];
  readonly modulations: readonly ModulationBinding[];
  readonly aspectOverrides: Readonly<Partial<Record<AspectBucket, AspectOverride>>>;
  readonly extra: Extra;
}

/** A layer that draws: the module id is what the registry looks up. */
export interface ModuleLayer extends BaseLayer {
  readonly kind: 'module';
  readonly module: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly paramsSchemaVersion: number;
}

/** A group (M38): its children composite into one texture, then its own transform, opacity, blend and effects apply. */
export interface GroupLayer extends BaseLayer {
  readonly kind: 'group';
  readonly collapsed: boolean;
  /** Bottom → top, like the top-level list. */
  readonly children: readonly Layer[];
}

export type Layer = ModuleLayer | GroupLayer;

// ---------------------------------------------------------------------------
// Modulation (modulation-spec §1)
// ---------------------------------------------------------------------------

export const MODULATION_MODES = ['add', 'multiply', 'replace'] as const;
export type ModulationMode = (typeof MODULATION_MODES)[number];

export const ENVELOPE_MODES = ['peak', 'linear'] as const;
export type EnvelopeMode = (typeof ENVELOPE_MODES)[number];

export const QUANTISE_MODES = ['trigger', 'hold'] as const;
export type QuantiseMode = (typeof QUANTISE_MODES)[number];

/**
 * What drives a binding. `type` selects the family; the remaining fields are the union of
 * what the families need, each optional and ignored by the families that do not use it.
 * Kept flat rather than a discriminated union of payloads so that a source the UI does not
 * yet know about still round-trips through `extra` without losing its settings.
 */
export interface SourceSpec {
  readonly type: string;
  /** mix | drums | bass | vocals | other (+ guitar | piano on the 6-stem model). */
  readonly stem: string;
  /** `band`: which analysed band. Null uses the module's or the binding's default. */
  readonly band: string | null;
  /** `lfo`: sine | triangle | saw | square | noise | sample-hold. */
  readonly shape: string;
  readonly rateHz: number;
  readonly phase: number;
  /** `lfo`: beats per cycle, locking the rate to the grid instead of to `rateHz`. */
  readonly syncDivision: number | null;
  /** `noise`: cycles per second of the underlying value noise, and how many octaves. */
  readonly noiseScale: number;
  readonly octaves: number;
  /** `ramp`: the value at the start and at the end of the track. */
  readonly from: number;
  readonly to: number;
  readonly extra: Extra;
}

export interface CurveSpec {
  readonly type: string;
  readonly amount: number;
  readonly extra: Extra;
}

export interface EnvelopeSpec {
  readonly attackMs: number;
  readonly releaseMs: number;
  readonly mode: EnvelopeMode;
  readonly extra: Extra;
}

export interface QuantiseSpec {
  /** Beats per step: 0.25 = 1/16 at 4/4, 4 = one bar. */
  readonly division: number;
  readonly mode: QuantiseMode;
  readonly swing: number;
  readonly humanise: number;
  readonly extra: Extra;
}

export interface Range {
  readonly min: number;
  readonly max: number;
}

export interface ModulationBinding {
  readonly id: string;
  readonly enabled: boolean;
  readonly label: string | null;
  readonly source: SourceSpec;
  /** A parameter path: `layers.<id>.params.<key>` (module-spec §4). */
  readonly target: string;
  /** Explicit percentile calibration bounds, or 'auto' (modulation-spec §7). */
  readonly inputRange: Range | 'auto';
  readonly curve: CurveSpec;
  readonly envelope: EnvelopeSpec;
  readonly quantise: QuantiseSpec | null;
  /**
   * Sampling offset: positive looks ahead and compensates detection lag so hits land on the
   * beat; negative delays the reaction. See the note on `ModulationBinding.lookAheadMs` in
   * `src/engine/core/modulation.ts` about D23's opposite sign convention.
   */
  readonly lookAheadMs: number;
  readonly amount: number;
  readonly offset: number;
  readonly invert: boolean;
  readonly mode: ModulationMode;
  /** Evaluation order among the bindings on one target (modulation-spec §9.2). */
  readonly order: number;
  readonly clampOutput: Range | null;
  readonly extra: Extra;
}

/**
 * `bypass` and `solo` are deliberately absent: they are transient UI state and must not be
 * saved, or a preset arrives with half its modulations silently disabled (modulation-spec §9.5).
 */

export const DEFAULT_ENVELOPE: EnvelopeSpec = { attackMs: 5, releaseMs: 120, mode: 'peak', extra: {} };
export const DEFAULT_CURVE: CurveSpec = { type: 'linear', amount: 0, extra: {} };
/**
 * D23: 30 ms of lag compensation, so hits land on the beat rather than behind it. D23 writes
 * this as "−30 ms"; with modulation-spec §4's `source(t + lookAhead)` the sign has to be
 * positive to produce the behaviour D23 describes. See `ModulationBinding.lookAheadMs`.
 */
export const DEFAULT_LOOK_AHEAD_MS = 30;

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

export interface ProjectDocument {
  readonly schemaVersion: number;
  readonly id: string;
  readonly name: string;
  /** ISO 8601. Provenance only — never used in rendering. */
  readonly createdAt: string;
  readonly modifiedAt: string;
  /** Recorded, not enforced (data-formats §2.1). */
  readonly appVersion: string;
  /** Master PRNG seed; "Surprise me" rerolls it. */
  readonly seed: number;
  readonly canvas: CanvasSettings;
  readonly audio: AudioSettings;
  readonly analysisSettings: AnalysisSettings;
  readonly palette: Palette;
  /** Bottom → top. */
  readonly layers: readonly Layer[];
  readonly globalEffects: readonly EffectSpec[];
  readonly globalModulations: readonly ModulationBinding[];
  readonly extra: Extra;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Depth-first, bottom → top, groups before their children. */
export function* walkLayers(
  layers: readonly Layer[],
  parents: readonly GroupLayer[] = [],
): Generator<{ layer: Layer; parents: readonly GroupLayer[] }> {
  for (const layer of layers) {
    yield { layer, parents };
    if (layer.kind === 'group') yield* walkLayers(layer.children, [...parents, layer]);
  }
}

/** The bucket a canvas falls into, for per-aspect overrides (PROJECT.md §8.11). */
export function aspectBucket(width: number, height: number): AspectBucket {
  if (width <= 0 || height <= 0) return 'custom';
  const ratio = width / height;
  // Tolerance covers 1920×1080 vs 1280×720 rounding, not genuinely different shapes.
  const near = (target: number) => Math.abs(ratio - target) < 0.01;
  if (near(16 / 9)) return '16:9';
  if (near(9 / 16)) return '9:16';
  if (near(1)) return '1:1';
  if (near(4 / 5)) return '4:5';
  return 'custom';
}
