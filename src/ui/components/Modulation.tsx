// Wiring the music into parameters (M13, modulation-spec §10, ui-spec §4 item 5 and §6).
//
// Four pieces, all over the same bindings in the document:
//   ModulateButton     the ∿ beside every modulatable control: suggested sources first, then the
//                      recipes; one click makes a working binding and opens it
//   ModulationSection  the selected layer's bindings, in the inspector
//   BindingRow         one binding: what it drives, what drives it, a live meter of its signal,
//                      problems said out loud, and the editor when expanded
//   ModulationMatrix   every binding in the project, grouped by layer or by source, with order,
//                      bulk enable and jump-to (the "anti-spaghetti view")
//
// Every edit is an undoable command (updateModulation merges a drag into one step). The live
// numbers — rendered values and signal levels — come from the preview's last frame, throttled
// (host.ts `onModulation`), so what the meter shows is what was drawn.

import { useMemo, useRef, useState } from 'react';

import type { ParamSpec } from '../../engine/core/params.ts';
import { KNOWN_CURVES } from '../../engine/core/modulation.ts';
import { GLOBAL_OWNER, addModulation, removeModulation, sequence, updateModulation } from '../../project/commands.ts';
import type { ModulationBinding } from '../../project/document.ts';
import { newId } from '../../project/ids.ts';
import {
  LFO_SHAPES, RECIPES, SOURCE_CHOICES, STEM_CHOICES, allBindings, asMidiBinding, defaultBinding, describeSource, describeTarget,
  isImperceptible, paramSpan, planBindingPaste, suggestedSources, type SchemaLookup, type TargetInfo,
} from '../../project/modulation-authoring.ts';
import { MidiSourceFields } from './MidiControls.tsx';
import { useModules } from '../modules.ts';
import { useStudio } from '../store.ts';

/** Module schemas for describeTarget, from the modules the studio knows (built-in and drop-in). */
function useSchemas(): SchemaLookup {
  const { manifests } = useModules();
  return useMemo<SchemaLookup>(() => (id) => manifests.get(id), [manifests]);
}

// ---------------------------------------------------------------------------
// The ∿ button
// ---------------------------------------------------------------------------

export function ModulateButton(props: { ownerId: string; target: string; spec: ParamSpec }): React.JSX.Element {
  const { ownerId, target, spec } = props;
  const run = useStudio((s) => s.run);
  const setOpenBinding = useStudio((s) => s.setOpenBinding);
  // From the document (a stable object), never a selector that builds a new array: zustand would
  // see a new value on every read and re-render without end.
  const document = useStudio((s) => s.document);
  const existing = useMemo(() => allBindings(document).filter((row) => row.binding.target === target), [document, target]);
  const [open, setOpen] = useState(false);
  const suggested = suggestedSources(spec);

  function add(binding: ModulationBinding): void {
    run(addModulation(ownerId, { ...binding, order: existing.length }));
    setOpenBinding(binding.id);
    setOpen(false);
  }

  return (
    <span className="modulate">
      <button
        type="button"
        className={existing.length > 0 ? 'modulate-button bound' : 'modulate-button'}
        title={existing.length > 0 ? `${existing.length} modulation${existing.length === 1 ? '' : 's'} — click to add or edit` : 'Make this react to the music'}
        data-action="modulate"
        onClick={(event) => {
          event.preventDefault();
          setOpen(!open);
        }}
      >
        ∿{existing.length > 1 ? existing.length : ''}
      </button>
      {open && (
        <>
          <span className="popover-backdrop" onClick={() => setOpen(false)} />
          <span className="modulate-menu" role="menu">
            {existing.map((row) => (
              <button key={row.binding.id} type="button" onClick={() => { setOpenBinding(row.binding.id); setOpen(false); }}>
                Edit: {row.binding.label ?? describeSource(row.binding)}
              </button>
            ))}
            <span className="menu-heading">Add, driven by</span>
            {suggested.map((type) => {
              const choice = SOURCE_CHOICES.find((c) => c.type === type);
              return (
                <button key={type} type="button" title={choice?.hint ?? ''} data-action={`modulate-source-${type}`} onClick={() => add(defaultBinding(target, spec, { newId, sourceType: type }))}>
                  {choice?.label ?? type}
                </button>
              );
            })}
            <span className="menu-heading">Recipes</span>
            {RECIPES.map((recipe) => (
              <button key={recipe.id} type="button" title={recipe.description} data-action={`modulate-recipe-${recipe.id}`} onClick={() => add(recipe.make(target, spec, newId))}>
                {recipe.name}
              </button>
            ))}
          </span>
        </>
      )}
    </span>
  );
}

/** The rendered value of a modulated parameter, when the last frame had one. */
export function useLiveValue(target: string | undefined): unknown {
  return useStudio((s) => (target === undefined ? undefined : s.liveModulation.values.get(target)));
}

// ---------------------------------------------------------------------------
// The inspector section
// ---------------------------------------------------------------------------

export function ModulationSection(props: { layerId: string; bindings: readonly ModulationBinding[] }): React.JSX.Element {
  const { layerId, bindings } = props;
  const document = useStudio((s) => s.document);
  const schemas = useSchemas();
  const setMatrixOpen = useStudio((s) => s.setMatrixOpen);
  const sorted = [...bindings].sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : a.order - b.order));
  const copied = useStudio((s) => s.copiedBindings);
  const setCopied = useStudio((s) => s.setCopiedBindings);
  const run = useStudio((s) => s.run);
  const notify = useStudio((s) => s.notify);

  function paste(): void {
    if (copied === null) return;
    const plan = planBindingPaste(document, copied.document, copied.bindings, layerId, schemas, newId);
    if (plan.bindings.length > 0) run(sequence('Paste modulation', plan.bindings.map((binding) => addModulation(layerId, binding))));
    const left = plan.skipped.length === 0 ? '' : ` Not here: ${plan.skipped.join(', ')}.`;
    notify({ text: `Pasted ${plan.bindings.length} of ${copied.bindings.length}.${left}`, kind: plan.skipped.length === 0 ? 'ok' : 'warn' });
  }

  return (
    <div className="modulation-section" data-testid="modulation-section">
      <div className="section-head">
        <h2>Modulation</h2>
        <span className="spacer" />
        {bindings.length > 0 ? <button type="button" data-action="bindings-copy" title="Copy these bindings, to paste onto another layer" onClick={() => setCopied({ document, bindings })}>Copy</button> : null}
        {copied !== null ? <button type="button" data-action="bindings-paste" title="Add the copied bindings here, for the parameters this layer has" onClick={paste}>Paste {copied.bindings.length}</button> : null}
        <button type="button" onClick={() => setMatrixOpen(true)} title="Every binding in the project">Matrix</button>
      </div>
      {sorted.length === 0 ? (
        <p className="empty">Nothing here reacts to the music yet. Use ∿ beside a control to wire it up.</p>
      ) : (
        <ul className="binding-list">
          {sorted.map((binding) => (
            <BindingRow key={binding.id} ownerId={layerId} binding={binding} info={describeTarget(document, binding.target, schemas)} />
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One binding
// ---------------------------------------------------------------------------

function BindingRow(props: {
  ownerId: string;
  binding: ModulationBinding;
  info: TargetInfo;
  /** In the matrix: jump to the layer, and offer reordering among bindings on one target. */
  onJump?: () => void;
  reorder?: { up: (() => void) | null; down: (() => void) | null };
}): React.JSX.Element {
  const { ownerId, binding, info, onJump, reorder } = props;
  const run = useStudio((s) => s.run);
  const openBinding = useStudio((s) => s.openBinding);
  const setOpenBinding = useStudio((s) => s.setOpenBinding);
  const issue = useStudio((s) => s.liveModulation.issues.find((i) => i.bindingId === binding.id));
  const open = openBinding === binding.id;
  const weak = isImperceptible(binding, info.spec);

  return (
    <li className={`binding${binding.enabled ? '' : ' disabled'}${open ? ' open' : ''}`} data-binding={binding.id}>
      <div className="binding-head">
        <input
          type="checkbox"
          checked={binding.enabled}
          title={binding.enabled ? 'On — click to switch off' : 'Off — click to switch on'}
          onChange={(e) => run(updateModulation(ownerId, binding.id, { enabled: e.target.checked }))}
        />
        <button type="button" className="binding-name" onClick={() => setOpenBinding(open ? null : binding.id)} title={info.label}>
          <span className="binding-target">{info.label}</span>
          <span className="binding-source">{binding.label === null ? '' : `${binding.label} · `}{describeSource(binding)}</span>
        </button>
        <LevelMeter bindingId={binding.id} enabled={binding.enabled} />
        {reorder !== undefined && (
          <>
            <button type="button" title="Earlier in the chain" disabled={reorder.up === null} onClick={() => reorder.up?.()}>↑</button>
            <button type="button" title="Later in the chain" disabled={reorder.down === null} onClick={() => reorder.down?.()}>↓</button>
          </>
        )}
        {onJump !== undefined && <button type="button" title="Show this layer" onClick={onJump}>→</button>}
        <button type="button" title="Remove" data-action="remove-modulation" onClick={() => { run(removeModulation(ownerId, binding.id)); if (open) setOpenBinding(null); }}>✕</button>
      </div>
      {info.problem !== null && <p className="bad binding-note">Target: {info.problem}. The binding is kept.</p>}
      {issue !== undefined && binding.enabled && <p className="warn binding-note">{issue.detail}</p>}
      {weak && binding.enabled && <p className="warn binding-note">Too weak to see: at full signal it moves the parameter by under 1% of its range.</p>}
      {open && <BindingEditor ownerId={ownerId} binding={binding} spec={info.spec} />}
    </li>
  );
}

/** How many of the last readings the sparkline shows, at the preview's throttled rate. */
const SPARK_POINTS = 48;

/** The binding's shaped signal right now (0..1), and its recent past: "is this source doing anything here?" */
function LevelMeter(props: { bindingId: string; enabled: boolean }): React.JSX.Element {
  const level = useStudio((s) => s.liveModulation.levels.get(props.bindingId));
  const shown = props.enabled && level !== undefined ? Math.min(1, Math.max(0, level)) : 0;
  // A ref: the store already re-renders this on every reading, so state would only render it twice.
  const history = useRef<number[]>([]);
  const last = useRef<unknown>(null);
  const reading = useStudio((s) => s.liveModulation);
  if (last.current !== reading) {
    last.current = reading;
    history.current = [...history.current.slice(1 - SPARK_POINTS), shown];
  }
  const points = history.current.map((value, i) => `${i},${(1 - value) * 10}`).join(' ');
  return (
    <>
    <svg className="level-spark" viewBox={`0 0 ${SPARK_POINTS - 1} 10`} preserveAspectRatio="none" aria-hidden="true">
      <polyline points={points} fill="none" />
    </svg>
    <span className="level-meter" title={level === undefined ? 'No signal (paused before the first frame, or the source is unavailable)' : `Signal ${(shown * 100).toFixed(0)}%`}>
      <span className="level-fill" style={{ width: `${(shown * 100).toFixed(1)}%` }} />
    </span>
    </>
  );
}

// ---------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------

function BindingEditor(props: { ownerId: string; binding: ModulationBinding; spec: ParamSpec | undefined }): React.JSX.Element {
  const { ownerId, binding, spec } = props;
  const run = useStudio((s) => s.run);
  const bands = useStudio((s) => s.document.analysisSettings.bands);
  const { source } = binding;
  const choice = SOURCE_CHOICES.find((c) => c.type === source.type);
  const span = spec === undefined ? 1 : Math.max(paramSpan(spec), 1e-6);
  // A multiplying binding's amount is a factor (0 = no change); an adding one is in the
  // parameter's own units, so its slider spans the parameter's range either way.
  const amountRange = binding.mode === 'multiply' ? 2 : span;

  /** One field, as an edit that merges while dragging and seals on release. */
  const patch = (value: Partial<ModulationBinding>, seal = true) => run(updateModulation(ownerId, binding.id, value), { seal });
  const setSource = (value: Partial<ModulationBinding['source']>) => patch({ source: { ...source, ...value } });

  return (
    <div className="binding-editor">
      <label className="field">
        <span>Driven by</span>
        <select
          value={source.type}
          data-action="binding-source"
          onChange={(e) => {
            if (e.target.value === 'midi') patch(asMidiBinding(binding));
            else setSource({ type: e.target.value, ...(e.target.value === 'band' && source.band === null ? { band: bands[1]?.id ?? bands[0]?.id ?? 'bass' } : {}) });
          }}
        >
          {SOURCE_CHOICES.map((c) => <option key={c.type} value={c.type}>{c.label}</option>)}
          {choice === undefined && <option value={source.type}>{source.type}</option>}
        </select>
      </label>
      {choice !== undefined && <p className="dim binding-hint">{choice.hint}</p>}
      {choice?.audio === true && (
        <label className="field">
          <span>Stem</span>
          <select value={source.stem} onChange={(e) => setSource({ stem: e.target.value })}>
            {STEM_CHOICES.map((stem) => <option key={stem} value={stem}>{stem}</option>)}
          </select>
        </label>
      )}
      {source.type === 'band' && (
        <label className="field">
          <span>Band</span>
          <select value={source.band ?? ''} onChange={(e) => setSource({ band: e.target.value })}>
            {bands.map((band) => <option key={band.id} value={band.id}>{band.label} ({formatHz(band.minHz)}–{formatHz(band.maxHz)})</option>)}
            {source.band !== null && !bands.some((b) => b.id === source.band) && <option value={source.band}>{source.band} (not in this project)</option>}
          </select>
        </label>
      )}
      {source.type === 'lfo' && (
        <>
          <label className="field">
            <span>Shape</span>
            <select value={source.shape} onChange={(e) => setSource({ shape: e.target.value })}>
              {LFO_SHAPES.map((shape) => <option key={shape} value={shape}>{shape}</option>)}
            </select>
          </label>
          <Knob label="Rate" value={source.rateHz} min={0.01} max={8} step={0.01} unit=" Hz" onChange={(v, seal) => patch({ source: { ...source, rateHz: v } }, seal)} />
        </>
      )}
      {source.type === 'midi' && <MidiSourceFields source={source} setSource={setSource} />}
      {source.type === 'noise' && (
        <Knob label="Speed" value={source.noiseScale} min={0.01} max={8} step={0.01} unit=" /s" onChange={(v, seal) => patch({ source: { ...source, noiseScale: v } }, seal)} />
      )}
      {source.type === 'ramp' && (
        <>
          <Knob label="From" value={source.from} min={0} max={1} step={0.01} onChange={(v, seal) => patch({ source: { ...source, from: v } }, seal)} />
          <Knob label="To" value={source.to} min={0} max={1} step={0.01} onChange={(v, seal) => patch({ source: { ...source, to: v } }, seal)} />
        </>
      )}

      <label className="field">
        <span>Mode</span>
        <select value={binding.mode} onChange={(e) => patch({ mode: e.target.value as ModulationBinding['mode'] })}>
          <option value="add">Add</option>
          <option value="multiply">Multiply</option>
          <option value="replace">Replace</option>
        </select>
      </label>
      <Knob
        label="Amount"
        value={binding.amount}
        min={-amountRange}
        max={amountRange}
        step={amountRange / 200}
        data-action="binding-amount"
        onChange={(v, seal) => patch({ amount: v }, seal)}
      />
      <Knob label="Offset" value={binding.offset} min={-span} max={span} step={span / 200} onChange={(v, seal) => patch({ offset: v }, seal)} />
      <label className="field">
        <span>Curve</span>
        <select value={binding.curve.type} onChange={(e) => patch({ curve: { ...binding.curve, type: e.target.value } })}>
          {KNOWN_CURVES.filter((c) => c !== 'pow').map((curve) => <option key={curve} value={curve}>{curve}</option>)}
        </select>
      </label>
      {binding.curve.type !== 'linear' && (
        <Knob label={binding.curve.type === 'threshold' ? 'Threshold' : 'Shape'} value={binding.curve.amount} min={0} max={1} step={0.01} onChange={(v, seal) => patch({ curve: { ...binding.curve, amount: v } }, seal)} />
      )}
      <Knob label="Attack" value={binding.envelope.attackMs} min={0} max={2000} step={1} unit=" ms" onChange={(v, seal) => patch({ envelope: { ...binding.envelope, attackMs: v } }, seal)} />
      <Knob label="Release" value={binding.envelope.releaseMs} min={0} max={4000} step={1} unit=" ms" onChange={(v, seal) => patch({ envelope: { ...binding.envelope, releaseMs: v } }, seal)} />
      <Knob
        label="Look-ahead"
        value={binding.lookAheadMs}
        min={-200}
        max={200}
        step={1}
        unit=" ms"
        title="Positive reacts early, compensating detection lag so hits land on the beat (D51)"
        onChange={(v, seal) => patch({ lookAheadMs: v }, seal)}
      />
      <label className="field">
        <span>Invert</span>
        <input type="checkbox" checked={binding.invert} onChange={(e) => patch({ invert: e.target.checked })} />
      </label>
      <label className="field">
        <span>Range</span>
        <select
          value={binding.inputRange === 'auto' ? 'auto' : 'fixed'}
          title="Auto calibrates to this track, so a binding feels right without hand-tuning (modulation-spec §7)"
          onChange={(e) => patch({ inputRange: e.target.value === 'auto' ? 'auto' : { min: 0, max: 1 } })}
        >
          <option value="auto">Auto (calibrated to the track)</option>
          <option value="fixed">Fixed 0–1</option>
        </select>
      </label>
      <label className="field">
        <span>Name</span>
        <input
          type="text"
          value={binding.label ?? ''}
          placeholder="optional, e.g. kick pump"
          onChange={(e) => patch({ label: e.target.value === '' ? null : e.target.value }, false)}
          onBlur={() => patch({ label: binding.label })}
        />
      </label>
    </div>
  );
}

function formatHz(hz: number): string {
  return hz >= 1000 ? `${Number((hz / 1000).toFixed(1))}k` : String(hz);
}

/** A labelled slider that merges a drag into one undo step and seals on release. */
function Knob(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  title?: string;
  'data-action'?: string;
  onChange: (value: number, seal: boolean) => void;
}): React.JSX.Element {
  const { label, value, min, max, step, unit, title, onChange } = props;
  return (
    <label className="field slider" title={title}>
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        data-action={props['data-action']}
        onChange={(e) => onChange(Number(e.target.value), false)}
        onPointerUp={() => onChange(value, true)}
        onKeyUp={() => onChange(value, true)}
      />
      <output>{Number.isInteger(value) ? value : value.toFixed(Math.abs(value) < 1 ? 3 : 2)}{unit ?? ''}</output>
    </label>
  );
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

type Grouping = 'layer' | 'source';

export function ModulationMatrix(): React.JSX.Element | null {
  const open = useStudio((s) => s.matrixOpen);
  const setOpen = useStudio((s) => s.setMatrixOpen);
  const document = useStudio((s) => s.document);
  const run = useStudio((s) => s.run);
  const select = useStudio((s) => s.select);
  const setOpenBinding = useStudio((s) => s.setOpenBinding);
  const schemas = useSchemas();
  const [grouping, setGrouping] = useState<Grouping>('layer');
  const [filter, setFilter] = useState('');
  if (!open) return null;

  const rows = allBindings(document).map((row) => ({ ...row, info: describeTarget(document, row.binding.target, schemas) }));
  const text = filter.trim().toLowerCase();
  const shown = rows.filter((row) => text === '' || `${row.info.label} ${describeSource(row.binding)} ${row.binding.label ?? ''}`.toLowerCase().includes(text));

  const groups = new Map<string, typeof shown>();
  for (const row of shown) {
    const key = grouping === 'layer' ? row.info.label.split(' › ')[0] ?? '' : describeSource(row.binding);
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  /** Swaps two bindings' order on one target, as one undo step (modulation-spec §9.2). */
  const swap = (a: (typeof rows)[number], b: (typeof rows)[number]) => () => run(sequence('Reorder modulation', [
    updateModulation(a.ownerId, a.binding.id, { order: b.binding.order }),
    updateModulation(b.ownerId, b.binding.id, { order: a.binding.order === b.binding.order ? a.binding.order + 1 : a.binding.order }),
  ]));

  const setAll = (enabled: boolean) => {
    const changes = shown.filter((row) => row.binding.enabled !== enabled);
    if (changes.length === 0) return;
    run(sequence(enabled ? 'Enable modulations' : 'Disable modulations', changes.map((row) => updateModulation(row.ownerId, row.binding.id, { enabled }))));
  };

  return (
    <aside className="queue-drawer matrix-drawer" aria-label="Modulation matrix" data-testid="modulation-matrix">
      <div className="queue-head">
        <h2>Modulation</h2>
        <span className="dim">{rows.length} binding{rows.length === 1 ? '' : 's'}</span>
        <span className="spacer" />
        <button type="button" onClick={() => setOpen(false)}>Close</button>
      </div>
      <input type="search" className="matrix-filter" placeholder="Filter by layer, parameter or source" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <div className="presets-filters">
        <button type="button" className={grouping === 'layer' ? 'active' : ''} onClick={() => setGrouping('layer')}>By layer</button>
        <button type="button" className={grouping === 'source' ? 'active' : ''} onClick={() => setGrouping('source')}>By source</button>
        <button type="button" onClick={() => setAll(true)} title="Switch on every binding shown">All on</button>
        <button type="button" onClick={() => setAll(false)} title="Switch off every binding shown">All off</button>
      </div>
      {rows.length === 0 ? (
        <p className="empty">No modulations in this project. Use ∿ beside any control in the inspector.</p>
      ) : shown.length === 0 ? (
        <p className="empty">Nothing matches.</p>
      ) : (
        [...groups.entries()].map(([name, list]) => (
          <section key={name} className="matrix-group">
            <h3>{name}</h3>
            <ul className="binding-list">
              {list.map((row) => {
                const sameTarget = rows
                  .filter((other) => other.binding.target === row.binding.target)
                  .sort((a, b) => a.binding.order - b.binding.order);
                const index = sameTarget.findIndex((other) => other.binding.id === row.binding.id);
                const before = sameTarget[index - 1];
                const after = sameTarget[index + 1];
                return (
                  <BindingRow
                    key={row.binding.id}
                    ownerId={row.ownerId}
                    binding={row.binding}
                    info={row.info}
                    onJump={() => { select(row.ownerId === GLOBAL_OWNER ? null : row.ownerId); setOpenBinding(row.binding.id); }}
                    {...(sameTarget.length > 1 ? {
                      reorder: {
                        up: before === undefined ? null : swap(row, before),
                        down: after === undefined ? null : swap(row, after),
                      },
                    } : {})}
                  />
                );
              })}
            </ul>
          </section>
        ))
      )}
    </aside>
  );
}
