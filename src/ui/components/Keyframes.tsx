// Keyframes in the inspector (S1, docs/keyframes-spec.md §5).
//
//  - The **diamond** beside every animatable control: hollow when the target is not animated, half
//    when it is but there is no key at the playhead, solid on a key. Clicking adds a key there with
//    the value shown, or removes the key that is there. ◀ ▶ jump to the previous and next key.
//  - **Auto-key**: once a target has a track, editing its control sets a key at the playhead rather
//    than the base (the base is kept, and returns if the track is removed). `useKeyframed` gives a
//    control what it needs for that: the track, the value at the playhead, and the setter.
//  - The **Keyframes section**: the selected layer's tracks, each switchable and removable, and the
//    selected key's time, value and easing — preset or a Bézier drawn in a small curve editor.
//
// A control subscribes to the playhead only when its target is animated, so playback does not
// re-render every control in the inspector sixty times a second.

import { useRef, useState } from 'react';

import { sampleTrack, type AutomationKind } from '../../engine/core/automation.ts';
import { TICKS_PER_SECOND, ticksToSeconds, secondsToTicks } from '../../engine/core/time.ts';
import {
  removeKeyframes, removeTrack, setKeyframe, setKeyframeEasing, setKeyframeTime, setTrackEnabled, trackFor,
} from '../../project/automation-commands.ts';
import { NAMED_EASINGS, type AutomationTrack, type Keyframe, type KeyframeEasing } from '../../project/document.ts';
import { newId } from '../../project/ids.ts';
import { describeTarget, type SchemaLookup } from '../../project/modulation-authoring.ts';
import { linkedRole, resolveRole } from '../../project/palette.ts';
import { useStudio } from '../store.ts';
import { previewControls } from './CanvasPane.tsx';
import { useModules } from '../modules.ts';

/** Half a frame at 60 fps: a key this close to the playhead counts as "at" it. */
const AT_TOLERANCE = TICKS_PER_SECOND / 120;

export interface Keyed {
  readonly track: AutomationTrack | undefined;
  /** The track's value at the playhead; undefined when not animated. */
  readonly value: unknown;
  /** The key at the playhead, if any. */
  readonly atKey: Keyframe | undefined;
  readonly playheadTicks: number;
  /** Auto-key: set a key at the playhead. */
  readonly setAtPlayhead: (value: Keyframe['value'], seal: boolean) => void;
}

/** Where the playhead is now, read at the moment of an edit. */
function currentPlayheadTicks(): number {
  return secondsToTicks(useStudio.getState().timelineSeconds);
}

export function useKeyframed(target: string | undefined, kind: AutomationKind): Keyed {
  const track = useStudio((s) => (target === undefined ? undefined : trackFor(s.document, target)));
  // Only an animated control follows the playhead (see the header).
  const seconds = useStudio((s) => (track === undefined ? 0 : s.timelineSeconds));
  const palette = useStudio((s) => s.document.palette);
  const run = useStudio((s) => s.run);
  const playheadTicks = secondsToTicks(seconds);
  let value: unknown;
  let atKey: Keyframe | undefined;
  if (track !== undefined) {
    // Palette links sample as their colour (the engine sees them resolved too).
    const resolved = track.keyframes.map((k) => {
      const role = linkedRole(k.value);
      return role === undefined ? k : { ...k, value: resolveRole(palette, role) ?? k.value };
    });
    value = sampleTrack(resolved, seconds, kind);
    atKey = track.keyframes.find((k) => Math.abs(k.ticks - playheadTicks) <= AT_TOLERANCE);
  }
  return {
    track,
    value,
    atKey,
    playheadTicks,
    setAtPlayhead: (next, seal) => {
      if (target === undefined) return;
      run(setKeyframe(target, atKey?.ticks ?? currentPlayheadTicks(), next, { newId }), { seal });
    },
  };
}

/** The diamond, with ◀ ▶ when animated. `current` is the value shown, which a new key takes. */
export function KeyframeButton(props: { target: string; keyed: Keyed; current: Keyframe['value'] }): React.JSX.Element {
  const { target, keyed, current } = props;
  const run = useStudio((s) => s.run);
  const setSelection = useStudio((s) => s.setKeySelection);
  const state = keyed.track === undefined ? 'none' : keyed.atKey === undefined ? 'animated' : 'on-key';
  const toggle = () => {
    if (keyed.atKey !== undefined) run(removeKeyframes([keyed.atKey.id]));
    else {
      // The real playhead: an un-animated control does not follow it (see the header), so its
      // own playheadTicks is 0 — the first key once landed at 0 s instead of where the user was.
      run(setKeyframe(target, currentPlayheadTicks(), current, { newId }));
      setSelection([]);
    }
  };
  const jump = (direction: 1 | -1) => {
    const keys = keyed.track?.keyframes ?? [];
    const next = direction > 0
      ? keys.find((k) => k.ticks > keyed.playheadTicks + AT_TOLERANCE)
      : [...keys].reverse().find((k) => k.ticks < keyed.playheadTicks - AT_TOLERANCE);
    if (next !== undefined) {
      previewControls.seek(ticksToSeconds(next.ticks));
      setSelection([next.id]);
    }
  };
  return (
    <span className="keyframe-controls">
      {state !== 'none' && <button type="button" className="key-nav" title="Previous keyframe" onClick={() => jump(-1)}>◀</button>}
      <button
        type="button"
        className={`key-diamond ${state}`}
        data-action="keyframe"
        data-key-state={state}
        title={state === 'none' ? 'Animate: add a keyframe at the playhead' : state === 'animated' ? 'Add a keyframe at the playhead (editing the value also does)' : 'Remove the keyframe at the playhead'}
        onClick={toggle}
      >
        ◆
      </button>
      {state !== 'none' && <button type="button" className="key-nav" title="Next keyframe" onClick={() => jump(1)}>▶</button>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// The section
// ---------------------------------------------------------------------------

function useSchemas(): SchemaLookup {
  const { manifests } = useModules();
  return (id) => manifests.get(id);
}

const EASING_LABEL: Record<(typeof NAMED_EASINGS)[number], string> = {
  linear: 'Linear',
  hold: 'Hold (step)',
  easeIn: 'Ease in',
  easeOut: 'Ease out',
  easeInOut: 'Ease in and out',
};

/** The selected layer's tracks (or the whole frame's, for `global`), and the selected key's editor. */
export function KeyframesSection(props: { ownerId: string }): React.JSX.Element | null {
  const prefix = props.ownerId === 'global' ? 'global.' : `layers.${props.ownerId}.`;
  // Select the stable list and filter here: a selector returning a new array every call would make
  // the store notify forever (it did — "maximum update depth", the studio went blank).
  const automation = useStudio((s) => s.document.automation);
  const tracks = automation.filter((t) => t.target.startsWith(prefix));
  const document = useStudio((s) => s.document);
  const selection = useStudio((s) => s.keySelection);
  const setSelection = useStudio((s) => s.setKeySelection);
  const run = useStudio((s) => s.run);
  const schemas = useSchemas();
  if (tracks.length === 0) return null;
  const selectedKey = tracks.flatMap((t) => t.keyframes.map((k) => ({ t, k }))).find(({ k }) => selection.includes(k.id));

  return (
    <div className="keyframes-section" data-testid="keyframes-section">
      <h2>Keyframes</h2>
      <ul className="track-list">
        {tracks.map((track) => {
          const info = describeTarget(document, track.target, schemas);
          return (
            <li key={track.id} className={track.enabled ? '' : 'disabled'}>
              <input type="checkbox" checked={track.enabled} title={track.enabled ? 'On — click to show the base value instead' : 'Off'} onChange={(e) => run(setTrackEnabled(track.id, e.target.checked))} />
              <span className="track-name" title={track.target}>{info.label.split(' › ').slice(1).join(' › ') || info.label}</span>
              <span className="key-chips">
                {track.keyframes.map((k) => (
                  <button
                    key={k.id}
                    type="button"
                    className={`key-chip${selection.includes(k.id) ? ' selected' : ''}`}
                    title={`${ticksToSeconds(k.ticks).toFixed(2)} s: ${String(k.value)}`}
                    onClick={(e) => {
                      setSelection(e.shiftKey ? [...selection, k.id] : [k.id]);
                      previewControls.seek(ticksToSeconds(k.ticks));
                    }}
                  >
                    ◆
                  </button>
                ))}
              </span>
              <button type="button" title="Remove every keyframe of this parameter (its base value shows again)" onClick={() => run(removeTrack(track.id))}>✕</button>
            </li>
          );
        })}
      </ul>
      {selectedKey !== undefined && <KeyEditor keyframe={selectedKey.k} track={selectedKey.t} />}
      {info(selectedKey === undefined)}
    </div>
  );
}

function info(noSelection: boolean): React.JSX.Element | null {
  return noSelection ? <p className="dim note">Pick a ◆ to edit its time and easing. Editing an animated control sets a key at the playhead.</p> : null;
}

function KeyEditor(props: { keyframe: Keyframe; track: AutomationTrack }): React.JSX.Element {
  const { keyframe, track } = props;
  const run = useStudio((s) => s.run);
  const setSelection = useStudio((s) => s.setKeySelection);
  const isLast = track.keyframes[track.keyframes.length - 1]?.id === keyframe.id;
  const preset = typeof keyframe.easing === 'string' ? keyframe.easing : 'custom';
  const cubic = typeof keyframe.easing === 'string'
    ? (({ easeIn: [0.42, 0, 1, 1], easeOut: [0, 0, 0.58, 1], easeInOut: [0.42, 0, 0.58, 1] } as Record<string, [number, number, number, number]>)[keyframe.easing] ?? [0.25, 0.25, 0.75, 0.75])
    : [...keyframe.easing.cubic] as [number, number, number, number];
  return (
    <div className="key-editor" data-testid="key-editor">
      <label className="field">
        <span>Time</span>
        <span className="with-unit">
        <input
          type="number"
          step={0.01}
          min={0}
          defaultValue={ticksToSeconds(keyframe.ticks).toFixed(3)}
          key={keyframe.ticks}
          onBlur={(e) => {
            const s = Number(e.target.value);
            if (Number.isFinite(s)) run(setKeyframeTime(keyframe.id, secondsToTicks(Math.max(0, s))));
          }}
        />
        <span className="dim">s</span>
        </span>
      </label>
      <div className="field"><span>Value</span><span>{String(keyframe.value)}</span></div>
      <label className="field">
        <span>Easing</span>
        <select value={preset} data-action="key-easing" onChange={(e) => run(setKeyframeEasing([keyframe.id], e.target.value === 'custom' ? { cubic } : e.target.value as KeyframeEasing))}>
          {NAMED_EASINGS.map((n) => <option key={n} value={n}>{EASING_LABEL[n]}</option>)}
          <option value="custom">Custom curve</option>
        </select>
      </label>
      {isLast && <p className="dim note">The last key's easing has nothing to lead into: it applies once a key is added after it.</p>}
      {preset !== 'hold' && preset !== 'linear' && (
        <CurveEditor value={cubic} onChange={(next, seal) => run(setKeyframeEasing([keyframe.id], { cubic: next }), { seal })} />
      )}
      <button type="button" onClick={() => { run(removeKeyframes([keyframe.id])); setSelection([]); }}>Delete keyframe</button>
    </div>
  );
}

/** Two draggable handles on a unit square; y may overshoot (−0.5..1.5 shown). */
function CurveEditor(props: { value: readonly [number, number, number, number]; onChange: (next: [number, number, number, number], seal: boolean) => void }): React.JSX.Element {
  const [x1, y1, x2, y2] = props.value;
  const svg = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState<1 | 2 | null>(null);
  const W = 160;
  const H = 160;
  const pad = 20;
  const px = (x: number) => pad + x * (W - 2 * pad);
  const py = (y: number) => H - pad - ((y + 0.5) / 2) * (H - 2 * pad);
  const toUnit = (clientX: number, clientY: number): [number, number] => {
    const box = svg.current?.getBoundingClientRect();
    if (box === undefined) return [0, 0];
    const sx = ((clientX - box.left) / box.width) * W;
    const sy = ((clientY - box.top) / box.height) * H;
    const x = Math.min(1, Math.max(0, (sx - pad) / (W - 2 * pad)));
    const y = Math.min(1.5, Math.max(-0.5, ((H - pad - sy) / (H - 2 * pad)) * 2 - 0.5));
    return [Number(x.toFixed(3)), Number(y.toFixed(3))];
  };
  const move = (e: React.PointerEvent, seal: boolean) => {
    if (dragging === null) return;
    const [x, y] = toUnit(e.clientX, e.clientY);
    props.onChange(dragging === 1 ? [x, y, x2, y2] : [x1, y1, x, y], seal);
  };
  return (
    <svg
      ref={svg}
      className="curve-editor"
      viewBox={`0 0 ${W} ${H}`}
      width={W}
      height={H}
      data-testid="curve-editor"
      onPointerMove={(e) => move(e, false)}
      onPointerUp={(e) => { move(e, true); setDragging(null); }}
      onPointerLeave={() => setDragging(null)}
    >
      <rect x={px(0)} y={py(1)} width={px(1) - px(0)} height={py(0) - py(1)} className="curve-box" />
      <line x1={px(0)} y1={py(0)} x2={px(x1)} y2={py(y1)} className="curve-arm" />
      <line x1={px(1)} y1={py(1)} x2={px(x2)} y2={py(y2)} className="curve-arm" />
      <path d={`M ${px(0)} ${py(0)} C ${px(x1)} ${py(y1)}, ${px(x2)} ${py(y2)}, ${px(1)} ${py(1)}`} className="curve-line" />
      {([[1, x1, y1], [2, x2, y2]] as const).map(([n, x, y]) => (
        <circle
          key={n}
          cx={px(x)}
          cy={py(y)}
          r={6}
          className="curve-handle"
          onPointerDown={(e) => { (e.target as Element).setPointerCapture(e.pointerId); setDragging(n); }}
        />
      ))}
    </svg>
  );
}
