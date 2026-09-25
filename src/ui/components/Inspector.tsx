// The inspector (ui-spec §4, module-spec §13).
//
// **Nothing here is hand-written per module.** Controls are generated from the parameter
// declarations a module ships, which is the whole reason adding the fortieth effect costs one
// file and no UI code (module-spec §0). A control that needed bespoke markup would be a bug in
// the schema, not a missing component.
//
// Two things the spec insists on and that are easy to omit:
//  - **Which aspect an edit lands in must be unmissable** (D44). Edits go to the active target,
//    and an overridden parameter shows a badge with reset-to-base.
//  - **Grouping and ordering come from the declaration**, so a module author controls the panel.

import type { ParamSpec } from '../../engine/core/params.ts';
import {
  GLOBAL_OWNER, addAsset, addEffect, clearParamOverride, findAssetByHash, findLayer, moveEffect, removeEffect, renameLayer,
  sequence, setEffectEnabled, setEffectParam, setLayerBlend, setLayerOpacity, setLayerParam, setLayerTimeRange, setLayerTransform,
} from '../../project/commands.ts';
import { secondsToTicks, ticksToSeconds } from '../../engine/core/time.ts';
import type { Command } from '../../project/history.ts';
import { createEffect } from '../../project/create.ts';
import { PALETTE_ROLES, linkedRole, resolveRole, roleLink, type PaletteRole } from '../../project/palette.ts';
import { ANCHORS, BLEND_MODES, SCALE_REFERENCES, type AspectBucket, type EffectSpec, type TimeRange } from '../../project/document.ts';
import { newId } from '../../project/ids.ts';
import { useStudio } from '../store.ts';
import { useModules } from '../modules.ts';
import { useState } from 'react';
import { OPACITY_SPEC, effectParamTarget, isModulatable, layerOpacityTarget, layerParamTarget } from '../../project/modulation-authoring.ts';
import { ModulateButton, ModulationSection, useLiveValue } from './Modulation.tsx';
import { KeyframeButton, KeyframesSection, useKeyframed } from './Keyframes.tsx';
import type { Keyframe } from '../../project/document.ts';


/**
 * module-spec §3.1: show this control only when another parameter has a given value. Conditions
 * chain — `angle` depends on `gradient`, which depends on `mode` — so a control whose condition
 * parameter is itself hidden is hidden too.
 *
 * Defaults come from **this module's own** declaration. They were once looked up in one map keyed
 * by parameter name across every module, so another module's `mode` default decided whether the
 * background's gradient controls appeared.
 */
function isVisible(spec: ParamSpec, values: Readonly<Record<string, unknown>>, params: readonly ParamSpec[], depth = 0): boolean {
  const condition = spec.visibleWhen;
  if (condition === undefined) return true;
  const other = params.find((p) => p.key === condition.param);
  if (other !== undefined && depth < 8 && !isVisible(other, values, params, depth + 1)) return false;
  const stored = values[condition.param];
  const effective = stored === undefined ? other?.default : stored;
  return effective === condition.equals;
}

export function Inspector(): React.JSX.Element {
  const document = useStudio((s) => s.document);
  const selectedId = useStudio((s) => s.selectedLayerId);
  const editTarget = useStudio((s) => s.editTarget);
  const run = useStudio((s) => s.run);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const { manifests: MANIFESTS } = useModules();

  const layer = selectedId === null ? undefined : findLayer(document, selectedId);
  // Before any early return: a hook's position must not depend on whether a layer is selected.
  const liveOpacity = useLiveValue(selectedId === null ? undefined : layerOpacityTarget(selectedId));

  if (layer === undefined) {
    // With no layer selected, the inspector edits what applies to the whole frame: the global
    // effect chain (compositor-spec — graded, bloomed, grained after every layer is composited),
    // which is where the auto-director puts its POST slot. It is edited like any layer's chain.
    return (
      <aside className="inspector" data-testid="global-inspector">
        <p className="empty">Select a layer to edit it. Below: effects on the whole frame.</p>
        <EffectChain layerId={GLOBAL_OWNER} effects={document.globalEffects} hasDepth={false} />
        <ModulationSection layerId={GLOBAL_OWNER} bindings={document.globalModulations} />
        <KeyframesSection ownerId={GLOBAL_OWNER} />
      </aside>
    );
  }

  const manifest = layer.kind === 'module' ? MANIFESTS.get(layer.module) : undefined;
  const override = editTarget === 'base' ? undefined : layer.aspectOverrides[editTarget as AspectBucket];
  const groups = new Map<string, ParamSpec[]>();
  for (const spec of manifest?.params ?? []) {
    const list = groups.get(spec.group) ?? [];
    list.push(spec);
    groups.set(spec.group, list);
  }

  return (
    <aside className="inspector">
      {layer.locked && (
        <p className="warn locked-note">This layer is locked, so its settings cannot be edited. Unlock it with <strong>L</strong> in the layer list.</p>
      )}
      {/* A disabled fieldset disables every control inside it: lock means nothing here moves. */}
      <fieldset className="inspector-fields" disabled={layer.locked}>
      <h2>Layer</h2>
      <label className="field">
        <span>Name</span>
        <input
          type="text"
          value={layer.name}
          onChange={(e) => run(renameLayer(layer.id, e.target.value), { seal: false })}
          onBlur={() => run(renameLayer(layer.id, layer.name))}
        />
      </label>
      <label className="field">
        <span>Blend</span>
        <select value={layer.blend} onChange={(e) => run(setLayerBlend(layer.id, e.target.value as typeof layer.blend))}>
          {BLEND_MODES.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
        </select>
      </label>
      <KeyedSlider
        target={layerOpacityTarget(layer.id)}
        label="Opacity"
        value={layer.opacity}
        min={0}
        max={1}
        step={0.01}
        modulate={<ModulateButton ownerId={layer.id} target={layerOpacityTarget(layer.id)} spec={OPACITY_SPEC} />}
        live={typeof liveOpacity === 'number' ? liveOpacity : undefined}
        onChange={(v) => run(setLayerOpacity(layer.id, v), { seal: false })}
        onCommit={() => run(setLayerOpacity(layer.id, layer.opacity))}
      />

      <h2>Transform{editTarget === 'base' ? '' : ` · ${editTarget}`}</h2>
      {(['x', 'y'] as const).map((axis) => (
        <KeyedSlider
          key={axis}
          target={`layers.${layer.id}.transform.${axis}`}
          label={axis.toUpperCase()}
          value={(override?.transform[axis] ?? layer.transform[axis])}
          min={-0.5}
          max={1.5}
          step={0.001}
          overridden={override?.transform[axis] !== undefined}
          onReset={() => editTarget !== 'base' && run(setLayerTransform(layer.id, {}, editTarget))}
          onChange={(v) => run(setLayerTransform(layer.id, { [axis]: v }, editTarget), { seal: false })}
          onCommit={() => run(setLayerTransform(layer.id, {}, editTarget))}
        />
      ))}
      {(['scaleX', 'scaleY'] as const).map((axis) => (
        <KeyedSlider
          key={axis}
          target={`layers.${layer.id}.transform.${axis}`}
          label={axis === 'scaleX' ? 'Scale X' : 'Scale Y'}
          value={(override?.transform[axis] ?? layer.transform[axis])}
          min={0}
          max={3}
          step={0.01}
          overridden={override?.transform[axis] !== undefined}
          onChange={(v) => run(setLayerTransform(layer.id, { [axis]: v }, editTarget), { seal: false })}
          onCommit={() => run(setLayerTransform(layer.id, {}, editTarget))}
        />
      ))}
      <KeyedSlider
        target={`layers.${layer.id}.transform.rotationDeg`}
        label="Rotation"
        value={override?.transform.rotationDeg ?? layer.transform.rotationDeg}
        min={-180}
        max={180}
        step={0.5}
        unit="°"
        overridden={override?.transform.rotationDeg !== undefined}
        onChange={(v) => run(setLayerTransform(layer.id, { rotationDeg: v }, editTarget), { seal: false })}
        onCommit={() => run(setLayerTransform(layer.id, {}, editTarget))}
      />
      <label className="field">
        <span>Anchor</span>
        <select
          value={layer.transform.anchor}
          onChange={(e) => run(setLayerTransform(layer.id, { anchor: e.target.value as typeof layer.transform.anchor }, editTarget))}
        >
          {ANCHORS.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </label>
      <label className="field">
        <span>Scale ref</span>
        <select
          value={layer.transform.scaleReference}
          onChange={(e) => run(setLayerTransform(layer.id, { scaleReference: e.target.value as typeof layer.transform.scaleReference }, editTarget))}
        >
          {SCALE_REFERENCES.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </label>

      {manifest === undefined ? (
        layer.kind === 'group'
          ? (
            <p className="empty">
              A group has no parameters of its own. Its children are composited first, then this
              group’s transform, opacity, blend and effects apply to the result.
            </p>
          )
          : <p className="bad">Module “{layer.module}” is not installed. Its settings are preserved.</p>
      ) : (
        [...groups.entries()].map(([group, specs]) => {
          // `visibleWhen` hides a control without touching its value: toggling a mode away and
          // back must not silently reset what it held (module-spec §13). Conditions read the
          // override-merged values, because that is what the render for this aspect uses.
          const values = layer.kind === 'module' ? { ...layer.params, ...override?.params } : {};
          const visible = specs.filter((spec) => isVisible(spec, values, manifest.params));
          const shown = visible.filter((spec) => spec.advanced !== true || showAdvanced);
          // A group with nothing to show gets no heading — "Image" over nothing, in gradient mode.
          if (visible.length === 0) return null;
          return (
          <div key={group} className="param-group" data-group={group}>
            <h2>{group}</h2>
            {shown
              .map((spec) => (
                <ParamControl
                  key={spec.key}
                  spec={spec}
                  stored={layer.kind === 'module' ? layer.params[spec.key] : undefined}
                  overrideValue={override?.params[spec.key]}
                  onChange={(value, seal) => run(setLayerParam(layer.id, spec.key, value, editTarget), { seal })}
                  assign={(value) => setLayerParam(layer.id, spec.key, value, editTarget)}
                  modulation={{ ownerId: layer.id, target: layerParamTarget(layer.id, spec.key) }}
                  onReset={editTarget === 'base' ? undefined : () => run(clearParamOverride(layer.id, spec.key, editTarget as AspectBucket))}
                />
              ))}
            {visible.some((spec) => spec.advanced === true) && (
              <button type="button" className="wide" onClick={() => setShowAdvanced(!showAdvanced)}>
                {showAdvanced ? 'Hide advanced' : 'Show advanced'}
              </button>
            )}
          </div>
          );
        })
      )}

      <EffectChain layerId={layer.id} effects={layer.effects} hasDepth={manifest?.kind === 'scene3d'} />
      <LayerTiming layerId={layer.id} range={layer.timeRange} />
      <ModulationSection layerId={layer.id} bindings={layer.modulations} />
      <KeyframesSection ownerId={layer.id} />
      </fieldset>
    </aside>
  );
}


/**
 * The effect chain for the selected layer (module-spec §8, ui-spec §4).
 *
 * **Order is meaningful and therefore visible.** Bloom then vignette darkens the glow at the
 * edges; vignette then bloom makes the darkened edges glow. There is no "correct" order to
 * infer, so the chain is a list the user reorders, not a set of checkboxes.
 *
 * Bypass is separate from remove for the same reason it is in every other tool: comparing with
 * and without is how an effect gets dialled in, and deleting loses the settings.
 */
function EffectChain(props: { layerId: string; effects: readonly EffectSpec[]; hasDepth: boolean }): React.JSX.Element {
  const { layerId, effects, hasDepth } = props;
  const run = useStudio((s) => s.run);
  const { all, manifests: MANIFESTS } = useModules();
  // Depth effects are offered only where there is depth — 3D scene layers (D18). The engine
  // refuses them elsewhere too; not offering them keeps that from being a surprise.
  const EFFECTS = all.filter((m) => m.manifest.kind === 'effect' && (hasDepth || m.manifest.capabilities.needsDepth !== true));
  const [openId, setOpenId] = useState<string | null>(null);
  const [picking, setPicking] = useState('');

  function add(moduleId: string): void {
    if (moduleId === '') return;
    const effect = createEffect(moduleId, { id: newId() });
    run(addEffect(layerId, effect));
    setOpenId(effect.id);
    setPicking('');
  }

  return (
    <>
      <h2>Effects</h2>
      {effects.length === 0 ? <p className="empty">{layerId === GLOBAL_OWNER ? 'No effects on the whole frame.' : 'No effects on this layer.'}</p> : null}
      {effects.map((effect, index) => {
        const manifest = MANIFESTS.get(effect.module);
        const open = openId === effect.id;
        return (
          <div key={effect.id} className={effect.enabled ? 'effect' : 'effect bypassed'}>
            <div className="effect-head">
              <button type="button" className="effect-name" onClick={() => setOpenId(open ? null : effect.id)}>
                {open ? '▾' : '▸'} {manifest?.name ?? effect.module}
              </button>
              <button
                type="button"
                title={effect.enabled ? 'Bypass' : 'Enable'}
                data-action="toggle-effect"
                onClick={() => run(setEffectEnabled(layerId, effect.id, !effect.enabled))}
              >
                {effect.enabled ? '◉' : '○'}
              </button>
              <button type="button" title="Move earlier" disabled={index === 0} onClick={() => run(moveEffect(layerId, effect.id, index - 1))}>↑</button>
              <button type="button" title="Move later" disabled={index === effects.length - 1} onClick={() => run(moveEffect(layerId, effect.id, index + 1))}>↓</button>
              <button type="button" title="Remove" data-action="remove-effect" onClick={() => run(removeEffect(layerId, effect.id))}>✕</button>
            </div>
            {manifest === undefined ? (
              <p className="bad">Module “{effect.module}” is not installed. Its settings are preserved.</p>
            ) : open ? (
              manifest.params
                .filter((spec) => isVisible(spec, effect.params, manifest.params))
                // No "show advanced" here: the chain is already a disclosure, and nesting a
                // second one inside each entry hides things two clicks deep.
                .map((spec) => (
                  <ParamControl
                    key={spec.key}
                    spec={spec}
                    stored={effect.params[spec.key]}
                    overrideValue={undefined}
                    onChange={(value, seal) => run(setEffectParam(layerId, effect.id, spec.key, value), { seal })}
                    assign={(value) => setEffectParam(layerId, effect.id, spec.key, value)}
                    modulation={{ ownerId: layerId, target: effectParamTarget(layerId, effect.id, spec.key) }}
                  />
                ))
            ) : null}
          </div>
        );
      })}
      <label className="field">
        <span>Add</span>
        <select value={picking} onChange={(e) => add(e.target.value)} data-action="add-effect">
          <option value="">Add an effect…</option>
          {EFFECTS.map((m) => <option key={m.manifest.id} value={m.manifest.id}>{m.manifest.name}</option>)}
        </select>
      </label>
    </>
  );
}

/**
 * When the layer is on screen (M9 "per-layer time range", PROJECT.md §8.10): in and out on the
 * timeline, in seconds, with "at the playhead" buttons — the quickest way to line an entrance up
 * with a moment you have just heard. Out may be "to the end". A layer outside its range draws
 * nothing, and its entry/exit animations run against these points.
 */
function LayerTiming(props: { layerId: string; range: TimeRange }): React.JSX.Element {
  const { layerId, range } = props;
  const run = useStudio((s) => s.run);
  const playhead = useStudio((s) => s.timelineSeconds);
  const inSeconds = ticksToSeconds(range.inTicks);
  const outSeconds = range.outTicks === null ? null : ticksToSeconds(range.outTicks);
  const set = (inS: number, outS: number | null, seal = true) => {
    const inTicks = secondsToTicks(Math.max(0, inS));
    // An out point at or before the in point would hide the layer entirely and say nothing; keep
    // at least one tick of range.
    const outTicks = outS === null ? null : Math.max(inTicks + 1, secondsToTicks(Math.max(0, outS)));
    run(setLayerTimeRange(layerId, inTicks, outTicks), { seal });
  };

  return (
    <>
      <h2>Timing</h2>
      <label className="field seconds">
        <span>In</span>
        <span className="seconds-input">
          <input
            type="number"
            min={0}
            step={0.01}
            value={Number(inSeconds.toFixed(3))}
            data-action="layer-in"
            onChange={(e) => Number.isFinite(Number(e.target.value)) && set(Number(e.target.value), outSeconds, false)}
            onBlur={() => set(inSeconds, outSeconds)}
          />
          <span className="dim">s</span>
          <button type="button" title="In at the playhead" onClick={() => set(playhead, outSeconds)}>⌖</button>
        </span>
      </label>
      <label className="field seconds">
        <span>Out</span>
        <span className="seconds-input">
          {outSeconds === null ? (
            <span className="dim">end of the video</span>
          ) : (
            <input
              type="number"
              min={0}
              step={0.01}
              value={Number(outSeconds.toFixed(3))}
              data-action="layer-out"
              onChange={(e) => Number.isFinite(Number(e.target.value)) && set(inSeconds, Number(e.target.value), false)}
              onBlur={() => set(inSeconds, outSeconds)}
            />
          )}
          <button type="button" title="Out at the playhead" onClick={() => set(inSeconds, Math.max(playhead, inSeconds))}>⌖</button>
          {outSeconds !== null && <button type="button" title="Run to the end of the video" onClick={() => set(inSeconds, null)}>∞</button>}
        </span>
      </label>
    </>
  );
}

/** Types a keyframe can hold (keyframes-spec §4); text and assets are not animated from the inspector. */
const KEYABLE = new Set(['float', 'int', 'bool', 'enum', 'color']);

/** One generated control. The type decides the widget; nothing is special-cased per module. */
function ParamControl(props: {
  spec: ParamSpec;
  stored: unknown;
  overrideValue: unknown;
  onChange: (value: unknown, seal: boolean) => void;
  onReset?: (() => void) | undefined;
  /** The command that sets this parameter, so an asset import and its use are one undo step. */
  assign?: ((value: unknown) => Command) | undefined;
  /** Where a binding on this parameter lives and points (M13); absent where modulation does not apply. */
  modulation?: { readonly ownerId: string; readonly target: string } | undefined;
}): React.JSX.Element {
  const { spec, stored, overrideValue, onReset, assign, modulation } = props;
  const overridden = overrideValue !== undefined;
  const canModulate = modulation !== undefined && isModulatable(spec);
  const live = useLiveValue(canModulate ? modulation.target : undefined);
  // Keyframes (S1): the same path as modulation. An animated control shows the keyed value at the
  // playhead, and editing it sets a key there (auto-key) instead of the base.
  const keyTarget = modulation !== undefined && spec.animatable !== false && KEYABLE.has(spec.type) ? modulation.target : undefined;
  const keyed = useKeyframed(keyTarget, spec.type === 'float' || spec.type === 'int' ? 'number' : spec.type === 'color' ? 'color' : 'discrete');
  const raw = keyed.track !== undefined && keyed.value !== undefined ? keyed.value : overridden ? overrideValue : stored;
  const onChange = (value: unknown, seal: boolean) => (keyed.track !== undefined
    ? keyed.setAtPlayhead(value as Keyframe['value'], seal)
    : props.onChange(value, seal));
  const keyButton = keyTarget === undefined ? null : <KeyframeButton target={keyTarget} keyed={keyed} current={(raw ?? spec.default) as Keyframe['value']} />;
  const modulate = canModulate || keyButton !== null
    ? <>{canModulate ? <ModulateButton ownerId={modulation.ownerId} target={modulation.target} spec={spec} /> : null}{keyButton}</>
    : null;

  switch (spec.type) {
    case 'float':
      return (
        <Slider
          label={spec.label}
          value={typeof raw === 'number' ? raw : spec.default}
          min={spec.softMin ?? spec.min}
          max={spec.softMax ?? spec.max}
          step={(spec.max - spec.min) / 200}
          unit={spec.unit ?? ''}
          overridden={overridden}
          onReset={onReset}
          extra={modulate}
          live={typeof live === 'number' ? live : undefined}
          onChange={(v) => onChange(v, false)}
          onCommit={() => onChange(typeof raw === 'number' ? raw : spec.default, true)}
        />
      );
    case 'int':
      return (
        <Slider
          label={spec.label}
          value={typeof raw === 'number' ? raw : spec.default}
          min={spec.min}
          max={spec.max}
          step={1}
          overridden={overridden}
          onReset={onReset}
          extra={modulate}
          live={typeof live === 'number' ? live : undefined}
          onChange={(v) => onChange(Math.round(v), false)}
          onCommit={() => onChange(typeof raw === 'number' ? raw : spec.default, true)}
        />
      );
    case 'bool':
      return (
        <label className="field">
          <span>{spec.label}{overridden ? <Badge onReset={onReset} /> : null}{modulate}</span>
          <input
            type="checkbox"
            checked={typeof raw === 'boolean' ? raw : spec.default}
            onChange={(e) => onChange(e.target.checked, true)}
          />
        </label>
      );
    case 'enum':
      return (
        <label className="field">
          <span>{spec.label}{overridden ? <Badge onReset={onReset} /> : null}{modulate}</span>
          <select value={typeof raw === 'string' ? raw : spec.default} onChange={(e) => onChange(e.target.value, true)}>
            {spec.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
      );
    case 'color':
      return (
        <ColorControl
          label={spec.label}
          value={typeof raw === 'string' ? raw : spec.default}
          badge={overridden ? <Badge onReset={onReset} /> : null}
          onChange={(value) => onChange(value, true)}
        />
      );
    case 'asset':
      return (
        <AssetControl
          label={spec.label}
          accept={spec.accept}
          assetId={typeof raw === 'string' ? raw : spec.default}
          badge={overridden ? <Badge onReset={onReset} /> : null}
          {...(assign === undefined ? {} : { assign })}
        />
      );
    case 'string':
      return (
        <TextControl
          label={spec.label}
          value={typeof raw === 'string' ? raw : spec.default}
          multiline={spec.multiline === true}
          badge={overridden ? <Badge onReset={onReset} /> : null}
          onChange={(value, seal) => onChange(value, seal)}
        />
      );
    case 'select:stem':
      return (
        <label className="field">
          <span>{spec.label}{overridden ? <Badge onReset={onReset} /> : null}</span>
          <select value={typeof raw === 'string' ? raw : spec.default} onChange={(e) => onChange(e.target.value, true)}>
            {['mix', 'drums', 'bass', 'vocals', 'other'].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
      );
  }
}

/**
 * A colour, either a literal or a link to a palette role (M17, compositor-spec §9).
 *
 * The link is stored *as the value* — `@primary` — rather than in a parallel structure, so a
 * preset or a copied layer carries the link with it and adopts whatever palette it lands in.
 * When a role is chosen the swatch shows what that role currently resolves to and is read-only:
 * editing it here would silently unlink, and "I changed the colour and it went back" is a worse
 * outcome than a disabled control.
 */
function ColorControl(props: {
  label: string;
  value: string;
  badge: React.ReactNode;
  onChange: (value: string) => void;
}): React.JSX.Element {
  const { label, value, badge, onChange } = props;
  const palette = useStudio((s) => s.document.palette);
  const role = linkedRole(value);
  const resolved = role === undefined ? value : resolveRole(palette, role);

  return (
    <label className="field colour">
      <span>{label}{badge}</span>
      <input
        type="color"
        value={(resolved ?? '#000000').slice(0, 7)}
        disabled={role !== undefined}
        title={role === undefined ? value : `Linked to the ${role} role`}
        onChange={(e) => onChange(e.target.value)}
      />
      <select
        value={role ?? ''}
        title="Link this colour to a palette role"
        onChange={(e) => onChange(e.target.value === '' ? (resolved ?? value) : roleLink(e.target.value as PaletteRole))}
      >
        <option value="">literal</option>
        {PALETTE_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
      </select>
    </label>
  );
}

/**
 * An asset reference (M14 background image). The value is an asset **id**; the file, its hash
 * and its name live in `document.assets`, so two layers using one image share one entry and one
 * GPU texture. Importing a file the project already holds reuses that asset rather than adding a
 * duplicate. A reference that cannot be shown says why — missing file, unreadable, unknown id.
 */
function AssetControl(props: {
  label: string;
  accept: 'image' | 'font' | 'video';
  assetId: string;
  badge: React.ReactNode;
  assign?: (value: unknown) => Command;
}): React.JSX.Element {
  const { label, accept, assetId, badge, assign } = props;
  const assets = useStudio((s) => s.document.assets);
  const statuses = useStudio((s) => s.assetStatus);
  const importImage = useStudio((s) => s.importImage);
  const importFont = useStudio((s) => s.importFont);
  const importVideo = useStudio((s) => s.importVideo);
  const run = useStudio((s) => s.run);
  const asset = assetId === '' ? undefined : assets.find((a) => a.id === assetId);
  const status = asset === undefined ? undefined : statuses[asset.id];
  const problem = status === undefined || status.state === 'ok' || status.state === 'loading' ? undefined : status.detail;
  const relink = useStudio((s) => s.relink);

  async function choose(): Promise<void> {
    if (assign === undefined) return;
    const imported = accept === 'font' ? await importFont() : accept === 'video' ? await importVideo() : await importImage();
    if (imported === null) return;
    const existing = findAssetByHash(useStudio.getState().document, imported.hash);
    run(existing === undefined
      ? sequence(`Use ${accept} ${imported.name}`, [addAsset(imported), assign(imported.id)])
      : assign(existing.id));
  }

  return (
    <div className="field asset">
      <span>{label}{badge}</span>
      <div className="asset-pick">
        <span className="asset-name" title={asset?.path ?? ''}>
          {assetId === '' ? (accept === 'font' ? 'Inter (bundled)' : 'none') : asset === undefined ? 'unknown asset' : asset.name}
        </span>
        <button type="button" data-action={`choose-${accept}`} disabled={assign === undefined} onClick={() => void choose()}>
          Choose…
        </button>
        {assetId !== '' && assign !== undefined && (
          <button type="button" title="Clear" onClick={() => run(assign(''))}>✕</button>
        )}
      </div>
      {asset === undefined && assetId !== '' ? <p className="bad">This layer refers to an asset the project does not contain.</p> : null}
      {problem === undefined || asset === undefined ? null : (
        <p className={status?.state === 'changed' ? 'warn' : 'bad'}>
          {problem}{' '}
          <button type="button" onClick={() => void relink(asset.id)}>Relink…</button>
        </p>
      )}
    </div>
  );
}

/**
 * Free text (a title, a credit). Every keystroke reaches the engine so the preview follows as you
 * type, but only as an unsealed edit: the run collapses into one undo step, sealed on blur.
 */
function TextControl(props: {
  label: string;
  value: string;
  multiline: boolean;
  badge: React.ReactNode;
  onChange: (value: string, seal: boolean) => void;
}): React.JSX.Element {
  const { label, value, multiline, badge, onChange } = props;
  return (
    <label className={multiline ? 'field text multiline' : 'field text'}>
      <span>{label}{badge}</span>
      {multiline ? (
        <textarea
          rows={3}
          value={value}
          data-action="text-value"
          onChange={(e) => onChange(e.target.value, false)}
          onBlur={() => onChange(value, true)}
        />
      ) : (
        <input
          type="text"
          value={value}
          data-action="text-value"
          onChange={(e) => onChange(e.target.value, false)}
          onBlur={() => onChange(value, true)}
        />
      )}
    </label>
  );
}

function Badge(props: { onReset?: (() => void) | undefined }): React.JSX.Element {
  return (
    <button type="button" className="override-badge" title="Overridden for this aspect — click to reset to base" onClick={props.onReset}>
      override
    </button>
  );
}

/**
 * A layer-property slider (opacity, transform) that can be keyframed: the diamond beside it, the
 * keyed value at the playhead shown, and auto-key when animated (keyframes-spec §5).
 */
function KeyedSlider(props: Omit<Parameters<typeof Slider>[0], 'extra'> & { target: string; modulate?: React.ReactNode }): React.JSX.Element {
  const { target, modulate, ...slider } = props;
  const keyed = useKeyframed(target, 'number');
  const animated = keyed.track !== undefined && typeof keyed.value === 'number';
  const value = animated ? (keyed.value as number) : slider.value;
  return (
    <Slider
      {...slider}
      value={value}
      extra={<>{modulate}<KeyframeButton target={target} keyed={keyed} current={value} /></>}
      onChange={(v) => (animated ? keyed.setAtPlayhead(v, false) : slider.onChange(v))}
      onCommit={() => (animated ? keyed.setAtPlayhead(value, true) : slider.onCommit?.())}
    />
  );
}

function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  overridden?: boolean;
  onReset?: (() => void) | undefined;
  /** Beside the label: the modulation button (M13). */
  extra?: React.ReactNode;
  /**
   * The value the last frame actually rendered with, when modulation moved it (modulation-spec
   * §10 "live overlay"): the handle stays the base value, a marker shows where it is now.
   */
  live?: number | undefined;
  onChange: (value: number) => void;
  /** Called on release: ends the merge run so the drag is one undo step (ui-spec §10). */
  onCommit?: () => void;
}): React.JSX.Element {
  const { label, value, min, max, step, unit, overridden, onReset, extra, live, onChange, onCommit } = props;
  const livePosition = live === undefined || !(max > min) ? undefined : Math.min(1, Math.max(0, (live - min) / (max - min)));
  return (
    <label className={`field slider${live === undefined ? '' : ' modulated'}${extra === undefined || extra === null ? '' : ' has-mod'}`}>
      <span>
        {label}
        {overridden === true ? <Badge onReset={onReset} /> : null}
      </span>
      <span className="range-wrap">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          onPointerUp={onCommit}
          onKeyUp={onCommit}
        />
        {livePosition !== undefined && <span className="live-marker" style={{ left: `${(livePosition * 100).toFixed(2)}%` }} />}
      </span>
      <output title={live === undefined ? undefined : `Set to ${formatNumber(value)}, rendering at ${formatNumber(live)}`}>
        {formatNumber(live ?? value)}{unit ?? ''}
      </output>
      {/* Its own column, so it never crowds the label. */}
      {extra}
    </label>
  );
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(Math.abs(value) < 1 ? 3 : 2);
}
