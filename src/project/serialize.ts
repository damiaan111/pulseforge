// Writing a document back to `.pvproj` JSON (data-formats §1.1).
//
// Two properties this file is responsible for:
//
//  1. **Stable key order.** The same document always serialises to the same bytes, so git
//     diffs show what actually changed rather than a reshuffle. Order comes from the literal
//     order each node is built in below; JavaScript preserves insertion order for string keys.
//  2. **Round-trip fidelity.** Every node's `extra` is written back, so fields added by a
//     newer build survive being opened and saved by this one (data-formats §2.2).
//
// `extra` is emitted *before* the declared fields so that a declared field always wins if a
// file somehow carries both, and its keys are sorted so their order is stable too.
//
// Caveat worth knowing: JavaScript orders integer-like keys ("0", "1") ahead of string keys
// regardless of insertion order. No declared field is integer-like, and a project with a
// numeric top-level key would be pathological, but a preserved `extra` key that looks like an
// integer will move to the front of its node. It round-trips correctly; only its position moves.

import type {
  AspectOverride, CurveSpec, EffectSpec, EnvelopeSpec, Extra, Layer, ModulationBinding,
  ProjectDocument, QuantiseSpec, Range, TimeRange, Transform,
} from './document.ts';

type Json = Record<string, unknown>;

/** Declared fields after the preserved ones, with `extra` keys in a stable order. */
function withExtra(extra: Extra, declared: Json): Json {
  const out: Json = {};
  for (const key of Object.keys(extra).sort()) out[key] = extra[key];
  for (const [key, value] of Object.entries(declared)) out[key] = value;
  return out;
}

function transformJson(transform: Transform): Json {
  return withExtra(transform.extra, {
    x: transform.x,
    y: transform.y,
    scaleX: transform.scaleX,
    scaleY: transform.scaleY,
    rotationDeg: transform.rotationDeg,
    skewXDeg: transform.skewXDeg,
    skewYDeg: transform.skewYDeg,
    anchor: transform.anchor,
    scaleReference: transform.scaleReference,
  });
}

/** Overrides keep only the properties that were set, in the same order as a full transform. */
function transformOverrideJson(partial: AspectOverride['transform']): Json {
  const order = ['x', 'y', 'scaleX', 'scaleY', 'rotationDeg', 'skewXDeg', 'skewYDeg', 'anchor', 'scaleReference'] as const;
  const out: Json = {};
  for (const key of order) {
    const value = partial[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function timeRangeJson(range: TimeRange): Json {
  return withExtra(range.extra, { inTicks: range.inTicks, outTicks: range.outTicks });
}

function rangeJson(range: Range): Json {
  return { min: range.min, max: range.max };
}

function effectJson(effect: EffectSpec): Json {
  return withExtra(effect.extra, {
    id: effect.id,
    module: effect.module,
    name: effect.name,
    enabled: effect.enabled,
    paramsSchemaVersion: effect.paramsSchemaVersion,
    params: effect.params,
  });
}

function curveJson(curve: CurveSpec): Json {
  return withExtra(curve.extra, { type: curve.type, amount: curve.amount });
}

function envelopeJson(envelope: EnvelopeSpec): Json {
  return withExtra(envelope.extra, { attackMs: envelope.attackMs, releaseMs: envelope.releaseMs, mode: envelope.mode });
}

function quantiseJson(quantise: QuantiseSpec): Json {
  return withExtra(quantise.extra, {
    division: quantise.division,
    mode: quantise.mode,
    swing: quantise.swing,
    humanise: quantise.humanise,
  });
}

function bindingJson(binding: ModulationBinding): Json {
  return withExtra(binding.extra, {
    id: binding.id,
    enabled: binding.enabled,
    label: binding.label,
    target: binding.target,
    source: withExtra(binding.source.extra, {
      type: binding.source.type,
      stem: binding.source.stem,
      band: binding.source.band,
      shape: binding.source.shape,
      rateHz: binding.source.rateHz,
      phase: binding.source.phase,
      syncDivision: binding.source.syncDivision,
      noiseScale: binding.source.noiseScale,
      octaves: binding.source.octaves,
      from: binding.source.from,
      to: binding.source.to,
    }),
    inputRange: binding.inputRange === 'auto' ? 'auto' : rangeJson(binding.inputRange),
    curve: curveJson(binding.curve),
    envelope: envelopeJson(binding.envelope),
    quantise: binding.quantise === null ? null : quantiseJson(binding.quantise),
    lookAheadMs: binding.lookAheadMs,
    amount: binding.amount,
    offset: binding.offset,
    invert: binding.invert,
    mode: binding.mode,
    order: binding.order,
    clampOutput: binding.clampOutput === null ? null : rangeJson(binding.clampOutput),
  });
}

function aspectOverridesJson(overrides: Layer['aspectOverrides']): Json {
  const out: Json = {};
  for (const bucket of Object.keys(overrides).sort()) {
    const override = overrides[bucket as keyof typeof overrides];
    if (override === undefined) continue;
    out[bucket] = withExtra(override.extra, {
      transform: transformOverrideJson(override.transform),
      params: override.params,
    });
  }
  return out;
}

function layerJson(layer: Layer): Json {
  const common: Json = {
    id: layer.id,
    kind: layer.kind,
    name: layer.name,
    enabled: layer.enabled,
    locked: layer.locked,
    soloed: layer.soloed,
    timeRange: timeRangeJson(layer.timeRange),
    transform: transformJson(layer.transform),
    blend: layer.blend,
    opacity: layer.opacity,
    maskLayerId: layer.maskLayerId,
  };
  const tail: Json = {
    effects: layer.effects.map(effectJson),
    modulations: layer.modulations.map(bindingJson),
    aspectOverrides: aspectOverridesJson(layer.aspectOverrides),
  };
  if (layer.kind === 'group') {
    return withExtra(layer.extra, { ...common, collapsed: layer.collapsed, ...tail, children: layer.children.map(layerJson) });
  }
  return withExtra(layer.extra, {
    ...common,
    module: layer.module,
    paramsSchemaVersion: layer.paramsSchemaVersion,
    params: layer.params,
    ...tail,
  });
}

export function toJson(document: ProjectDocument): Json {
  const { canvas, audio, analysisSettings: analysis, palette } = document;
  return withExtra(document.extra, {
    schemaVersion: document.schemaVersion,
    id: document.id,
    name: document.name,
    createdAt: document.createdAt,
    modifiedAt: document.modifiedAt,
    appVersion: document.appVersion,
    seed: document.seed,
    canvas: withExtra(canvas.extra, {
      width: canvas.width,
      height: canvas.height,
      fps: { num: canvas.fps.num, den: canvas.fps.den },
      background: canvas.background,
    }),
    audio: withExtra(audio.extra, {
      path: audio.path,
      hash: audio.hash,
      durationTicks: audio.durationTicks,
      leadInTicks: audio.leadInTicks,
      leadOutTicks: audio.leadOutTicks,
      clipInTicks: audio.clipInTicks,
      clipOutTicks: audio.clipOutTicks,
      fadeInTicks: audio.fadeInTicks,
      fadeOutTicks: audio.fadeOutTicks,
      fadeInCurve: audio.fadeInCurve,
      fadeOutCurve: audio.fadeOutCurve,
      gain: audio.gain,
      stemsEnabled: audio.stemsEnabled,
    }),
    analysisSettings: withExtra(analysis.extra, {
      fftSize: analysis.fftSize,
      onsetSensitivity: analysis.onsetSensitivity,
      bpmOverride: analysis.bpmOverride,
      stemModel: analysis.stemModel,
      bands: analysis.bands.map((band) =>
        withExtra(band.extra, { id: band.id, label: band.label, minHz: band.minHz, maxHz: band.maxHz, gain: band.gain }),
      ),
    }),
    palette: withExtra(palette.extra, { colors: palette.colors, roles: palette.roles }),
    layers: document.layers.map(layerJson),
    globalEffects: document.globalEffects.map(effectJson),
    globalModulations: document.globalModulations.map(bindingJson),
    // Only written when there is something to write, so every project saved before assets existed
    // round-trips to the same bytes.
    ...(document.assets.length > 0
      ? {
        assets: document.assets.map((asset) =>
          withExtra(asset.extra, { id: asset.id, kind: asset.kind, name: asset.name, path: asset.path, hash: asset.hash, size: asset.size }),
        ),
      }
      : {}),
  });
}

/** The bytes written to disk: UTF-8, two-space indent, trailing newline. */
export function stringifyDocument(document: ProjectDocument): string {
  return `${JSON.stringify(toJson(document), null, 2)}\n`;
}
