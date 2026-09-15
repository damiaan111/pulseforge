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

import { BUILTIN_MODULES } from '../../engine/engine.ts';
import type { ParamSpec } from '../../engine/core/params.ts';
import {
  addEffect, clearParamOverride, findLayer, moveEffect, removeEffect, renameLayer, setEffectEnabled,
  setEffectParam, setLayerBlend, setLayerOpacity, setLayerParam, setLayerTransform,
} from '../../project/commands.ts';
import { createEffect } from '../../project/create.ts';
import { PALETTE_ROLES, linkedRole, resolveRole, roleLink, type PaletteRole } from '../../project/palette.ts';
import { ANCHORS, BLEND_MODES, SCALE_REFERENCES, type AspectBucket, type EffectSpec } from '../../project/document.ts';
import { newId } from '../../project/ids.ts';
import { useStudio } from '../store.ts';
import { useState } from 'react';

const MANIFESTS = new Map(BUILTIN_MODULES.map((m) => [m.manifest.id, m.manifest]));

/** module-spec §3.1: show this control only when another parameter has a given value. */
function isVisible(spec: ParamSpec, values: Readonly<Record<string, unknown>>): boolean {
  const condition = spec.visibleWhen;
  if (condition === undefined) return true;
  const other = values[condition.param];
  const effective = other === undefined
    ? MANIFEST_DEFAULTS.get(condition.param)
    : other;
  return effective === condition.equals;
}

/** Defaults by key, so a condition still resolves before anything has been edited. */
const MANIFEST_DEFAULTS = new Map<string, unknown>(
  BUILTIN_MODULES.flatMap((m) => m.manifest.params.map((p) => [p.key, p.default] as const)),
);

export function Inspector(): React.JSX.Element {
  const document = useStudio((s) => s.document);
  const selectedId = useStudio((s) => s.selectedLayerId);
  const editTarget = useStudio((s) => s.editTarget);
  const run = useStudio((s) => s.run);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const layer = selectedId === null ? undefined : findLayer(document, selectedId);

  if (layer === undefined) {
    return (
      <aside className="inspector">
        <p className="empty">Select a layer to edit it.</p>
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
      <Slider
        label="Opacity"
        value={layer.opacity}
        min={0}
        max={1}
        step={0.01}
        onChange={(v) => run(setLayerOpacity(layer.id, v), { seal: false })}
        onCommit={() => run(setLayerOpacity(layer.id, layer.opacity))}
      />

      <h2>Transform{editTarget === 'base' ? '' : ` · ${editTarget}`}</h2>
      {(['x', 'y'] as const).map((axis) => (
        <Slider
          key={axis}
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
        <Slider
          key={axis}
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
      <Slider
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
          ? <p className="empty">Groups have no module parameters.</p>
          : <p className="bad">Module “{layer.module}” is not installed. Its settings are preserved.</p>
      ) : (
        [...groups.entries()].map(([group, specs]) => (
          <div key={group}>
            <h2>{group}</h2>
            {specs
              // `visibleWhen` hides a control without touching its value: toggling a mode away
              // and back must not silently reset what it held (module-spec §13).
              .filter((spec) => isVisible(spec, layer.kind === 'module' ? layer.params : {}))
              .filter((spec) => spec.advanced !== true || showAdvanced)
              .map((spec) => (
                <ParamControl
                  key={spec.key}
                  spec={spec}
                  stored={layer.kind === 'module' ? layer.params[spec.key] : undefined}
                  overrideValue={override?.params[spec.key]}
                  onChange={(value, seal) => run(setLayerParam(layer.id, spec.key, value, editTarget), { seal })}
                  onReset={editTarget === 'base' ? undefined : () => run(clearParamOverride(layer.id, spec.key, editTarget as AspectBucket))}
                />
              ))}
            {specs.some((spec) => spec.advanced === true) && (
              <button type="button" className="wide" onClick={() => setShowAdvanced(!showAdvanced)}>
                {showAdvanced ? 'Hide advanced' : 'Show advanced'}
              </button>
            )}
          </div>
        ))
      )}

      <EffectChain layerId={layer.id} effects={layer.effects} />
    </aside>
  );
}

const EFFECTS = BUILTIN_MODULES.filter((m) => m.manifest.kind === 'effect');

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
function EffectChain(props: { layerId: string; effects: readonly EffectSpec[] }): React.JSX.Element {
  const { layerId, effects } = props;
  const run = useStudio((s) => s.run);
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
      {effects.length === 0 ? <p className="empty">No effects on this layer.</p> : null}
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
                .filter((spec) => isVisible(spec, effect.params))
                // No "show advanced" here: the chain is already a disclosure, and nesting a
                // second one inside each entry hides things two clicks deep.
                .map((spec) => (
                  <ParamControl
                    key={spec.key}
                    spec={spec}
                    stored={effect.params[spec.key]}
                    overrideValue={undefined}
                    onChange={(value, seal) => run(setEffectParam(layerId, effect.id, spec.key, value), { seal })}
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

/** One generated control. The type decides the widget; nothing is special-cased per module. */
function ParamControl(props: {
  spec: ParamSpec;
  stored: unknown;
  overrideValue: unknown;
  onChange: (value: unknown, seal: boolean) => void;
  onReset?: (() => void) | undefined;
}): React.JSX.Element {
  const { spec, stored, overrideValue, onChange, onReset } = props;
  const overridden = overrideValue !== undefined;
  const raw = overridden ? overrideValue : stored;

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
          onChange={(v) => onChange(Math.round(v), false)}
          onCommit={() => onChange(typeof raw === 'number' ? raw : spec.default, true)}
        />
      );
    case 'bool':
      return (
        <label className="field">
          <span>{spec.label}{overridden ? <Badge onReset={onReset} /> : null}</span>
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
          <span>{spec.label}{overridden ? <Badge onReset={onReset} /> : null}</span>
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

function Badge(props: { onReset?: (() => void) | undefined }): React.JSX.Element {
  return (
    <button type="button" className="override-badge" title="Overridden for this aspect — click to reset to base" onClick={props.onReset}>
      override
    </button>
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
  onChange: (value: number) => void;
  /** Called on release: ends the merge run so the drag is one undo step (ui-spec §10). */
  onCommit?: () => void;
}): React.JSX.Element {
  const { label, value, min, max, step, unit, overridden, onReset, onChange, onCommit } = props;
  return (
    <label className="field slider">
      <span>
        {label}
        {overridden === true ? <Badge onReset={onReset} /> : null}
      </span>
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
      <output>{formatNumber(value)}{unit ?? ''}</output>
    </label>
  );
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(Math.abs(value) < 1 ? 3 : 2);
}
