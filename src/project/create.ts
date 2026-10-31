// Building documents in code: a blank project, and the layer/effect/binding constructors the
// editor commands and the auto-director both go through.
//
// Everything that varies between runs — ids, timestamps, the seed — arrives through `options`
// or the injected id factory, so a test can build a byte-stable document and the auto-director
// can build a reproducible one from a project seed.

import {
  CURRENT_SCHEMA_VERSION, DEFAULT_CURVE, DEFAULT_ENVELOPE, DEFAULT_LOOK_AHEAD_MS,
  EMPTY_LYRICS, FULL_TIME_RANGE, IDENTITY_TRANSFORM,
  type AnalysisSettings, type AudioSettings, type CanvasSettings, type EffectSpec,
  type GroupLayer, type ModulationBinding, type ModuleLayer, type Palette,
  type ProjectDocument,
 DEFAULT_MASK } from './document.ts';
import { newId } from './ids.ts';
import { rational } from '../engine/core/time.ts';
import { STANDARD_BANDS } from '../analysis/spectrum.ts';

/** The default bands (PROJECT.md §8.1), used until the user edits them. */
/** The analyser's standard bands, as a document stores them (one list: spectrum.ts). */
export const DEFAULT_BANDS: AnalysisSettings['bands'] = STANDARD_BANDS.map((band) => ({
  id: band.name, label: band.label, minHz: band.minHz, maxHz: band.maxHz, gain: 1, extra: {},
}));

export const DEFAULT_CANVAS: CanvasSettings = {
  width: 1920,
  height: 1080,
  fps: rational(60),
  background: '#000000',
  extra: {},
};

export const DEFAULT_AUDIO: AudioSettings = {
  path: '',
  hash: '',
  durationTicks: 0,
  leadInTicks: 0,
  leadOutTicks: 0,
  clipInTicks: 0,
  clipOutTicks: null,
  fadeInTicks: 0,
  fadeOutTicks: 0,
  fadeInCurve: 'equal-power',
  fadeOutCurve: 'equal-power',
  gain: 1,
  stemsEnabled: false,
  extra: {},
};

export const DEFAULT_ANALYSIS_SETTINGS: AnalysisSettings = {
  fftSize: 2048,
  bands: DEFAULT_BANDS,
  onsetSensitivity: 0.5,
  bpmOverride: null,
  // D8: fast by default, `htdemucs_ft` one click away.
  stemModel: 'htdemucs',
  beatRefinement: null,
  extra: {},
};

export const DEFAULT_PALETTE: Palette = { colors: [], roles: {}, extra: {} };

export interface CreateDocumentOptions {
  readonly name?: string;
  readonly seed?: number;
  readonly appVersion?: string;
  /** ISO 8601; supplied by the caller so documents built in tests are byte-stable. */
  readonly timestamp?: string;
  readonly canvas?: Partial<CanvasSettings>;
  readonly audio?: Partial<AudioSettings>;
  readonly id?: string;
}

export function createDocument(options: CreateDocumentOptions = {}): ProjectDocument {
  const timestamp = options.timestamp ?? new Date().toISOString();
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: options.id ?? newId(),
    name: options.name ?? 'Untitled',
    createdAt: timestamp,
    modifiedAt: timestamp,
    appVersion: options.appVersion ?? '',
    seed: options.seed ?? 0,
    canvas: { ...DEFAULT_CANVAS, ...options.canvas },
    audio: { ...DEFAULT_AUDIO, ...options.audio },
    analysisSettings: DEFAULT_ANALYSIS_SETTINGS,
    palette: DEFAULT_PALETTE,
    assets: [],
    layers: [],
    globalEffects: [],
    globalModulations: [],
    lyrics: EMPTY_LYRICS,
    automation: [],
    markers: [],
    midi: null,
    director: null,
    extra: {},
  };
}

export interface CreateLayerOptions {
  readonly id?: string;
  readonly name?: string;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly paramsSchemaVersion?: number;
  readonly opacity?: number;
  readonly blend?: ModuleLayer['blend'];
  readonly transform?: Partial<ModuleLayer['transform']>;
  readonly timeRange?: Partial<ModuleLayer['timeRange']>;
}

export function createModuleLayer(module: string, options: CreateLayerOptions = {}): ModuleLayer {
  return {
    kind: 'module',
    id: options.id ?? newId(),
    name: options.name ?? '',
    module,
    enabled: true,
    locked: false,
    soloed: false,
    timeRange: { ...FULL_TIME_RANGE, ...options.timeRange },
    transform: { ...IDENTITY_TRANSFORM, ...options.transform },
    blend: options.blend ?? 'normal',
    opacity: options.opacity ?? 1,
    maskLayerId: null,
    mask: DEFAULT_MASK,
    maskSourceVisible: false,
    params: options.params ?? {},
    paramsSchemaVersion: options.paramsSchemaVersion ?? 1,
    effects: [],
    modulations: [],
    aspectOverrides: {},
    extra: {},
  };
}

export function createGroupLayer(
  children: GroupLayer['children'] = [],
  options: Omit<CreateLayerOptions, 'params' | 'paramsSchemaVersion'> = {},
): GroupLayer {
  return {
    kind: 'group',
    id: options.id ?? newId(),
    name: options.name ?? '',
    enabled: true,
    locked: false,
    soloed: false,
    collapsed: false,
    timeRange: { ...FULL_TIME_RANGE, ...options.timeRange },
    transform: { ...IDENTITY_TRANSFORM, ...options.transform },
    blend: options.blend ?? 'normal',
    opacity: options.opacity ?? 1,
    maskLayerId: null,
    mask: DEFAULT_MASK,
    maskSourceVisible: false,
    children,
    effects: [],
    modulations: [],
    aspectOverrides: {},
    extra: {},
  };
}

export function createEffect(module: string, options: { id?: string; name?: string; params?: Readonly<Record<string, unknown>> } = {}): EffectSpec {
  return {
    id: options.id ?? newId(),
    module,
    name: options.name ?? '',
    enabled: true,
    params: options.params ?? {},
    paramsSchemaVersion: 1,
    extra: {},
  };
}

export interface CreateBindingOptions {
  readonly id?: string;
  readonly sourceType?: string;
  readonly stem?: string;
  readonly band?: string;
  readonly amount?: number;
  readonly mode?: ModulationBinding['mode'];
  readonly order?: number;
}

export function createBinding(target: string, options: CreateBindingOptions = {}): ModulationBinding {
  return {
    id: options.id ?? newId(),
    enabled: true,
    label: null,
    source: {
      type: options.sourceType ?? 'band',
      stem: options.stem ?? 'mix',
      band: options.band ?? null,
      shape: 'sine',
      rateHz: 1,
      phase: 0,
      syncDivision: null,
      points: [],
      noiseScale: 1,
      octaves: 1,
      from: 0,
      to: 1,
      noteLow: 0,
      noteHigh: 127,
      channel: null,
      extra: {},
    },
    target,
    // Auto-calibration is the default because a fixed 0..1 range barely moves on real,
    // compressed material (modulation-spec §7).
    inputRange: 'auto',
    curve: DEFAULT_CURVE,
    envelope: DEFAULT_ENVELOPE,
    quantise: null,
    lookAheadMs: DEFAULT_LOOK_AHEAD_MS,
    amount: options.amount ?? 1,
    offset: 0,
    invert: false,
    mode: options.mode ?? 'add',
    order: options.order ?? 0,
    clampOutput: null,
    extra: {},
  };
}
