// The audio clip (M29, PROJECT.md §8.10, ui-spec §5 "Audio"): trim in/out, lead-in/out padding,
// fades with a curve, and gain.
//
// All in seconds on screen and ticks in the document (1/48000 s, D10). Trim points are in the
// *source file's* time; lead-in and lead-out are silence on the timeline. Every edit is `setAudio`,
// which merges per field, so dragging or typing one value is one undo step. Values are clamped so
// the clip can never be inside out — a trim-out before the trim-in would render nothing and say
// nothing about why.

import { setAudio } from '../../project/commands.ts';
import { FADE_CURVES, type FadeCurve } from '../../project/document.ts';
import { secondsToTicks, ticksToSeconds } from '../../engine/core/time.ts';
import { useStudio } from '../store.ts';

const CURVE_LABELS: Readonly<Record<FadeCurve, string>> = {
  'equal-power': 'Equal',
  linear: 'Linear',
  's-curve': 'S-curve',
};

export function ClipControls(): React.JSX.Element | null {
  const audio = useStudio((s) => s.document.audio);
  const run = useStudio((s) => s.run);
  const playhead = useStudio((s) => s.timelineSeconds);
  const loaded = useStudio((s) => s.audio);
  // The document records the file's length on import; a project written elsewhere may not have it,
  // so the loaded audio's own length stands in rather than hiding the controls.
  const durationTicks = audio.durationTicks > 0 ? audio.durationTicks : secondsToTicks(loaded?.durationSeconds ?? 0);
  if (audio.path === '' || durationTicks <= 0) return null;

  const duration = ticksToSeconds(durationTicks);
  const clipIn = ticksToSeconds(audio.clipInTicks);
  const clipOut = ticksToSeconds(audio.clipOutTicks ?? durationTicks);
  const clipLength = Math.max(0, clipOut - clipIn);
  /** Where the playhead is in the source file (timeline − lead-in + trim-in). */
  const playheadInSource = playhead - ticksToSeconds(audio.leadInTicks) + clipIn;
  const ticks = (seconds: number) => Math.max(0, secondsToTicks(Math.max(0, seconds)));

  const setIn = (seconds: number, seal = true) =>
    run(setAudio({ clipInTicks: ticks(Math.min(seconds, clipOut - 0.01)) }), { seal });
  const setOut = (seconds: number, seal = true) => {
    const clamped = Math.min(duration, Math.max(clipIn + 0.01, seconds));
    // The end of the file is stored as null, "to the end", so a longer re-import is not cut short.
    run(setAudio({ clipOutTicks: clamped >= duration ? null : ticks(clamped) }), { seal });
  };

  return (
    <div className="clip-controls" data-testid="clip-controls">
      <h3>Clip</h3>
      <SecondsField label="Trim in" value={clipIn} max={clipOut} data-action="clip-in" onChange={setIn}
        extra={<button type="button" title="Trim in at the playhead" onClick={() => setIn(playheadInSource)}>⌖</button>} />
      <SecondsField label="Trim out" value={clipOut} max={duration} data-action="clip-out" onChange={setOut}
        extra={<button type="button" title="Trim out at the playhead" onClick={() => setOut(playheadInSource)}>⌖</button>} />
      <SecondsField label="Lead-in" value={ticksToSeconds(audio.leadInTicks)} max={600}
        onChange={(v, seal) => run(setAudio({ leadInTicks: ticks(v) }), { seal })} />
      <SecondsField label="Lead-out" value={ticksToSeconds(audio.leadOutTicks)} max={600}
        onChange={(v, seal) => run(setAudio({ leadOutTicks: ticks(v) }), { seal })} />
      <SecondsField label="Fade in" value={ticksToSeconds(audio.fadeInTicks)} max={clipLength} data-action="fade-in"
        onChange={(v, seal) => run(setAudio({ fadeInTicks: ticks(Math.min(v, clipLength)) }), { seal })}
        extra={<CurvePicker value={audio.fadeInCurve} onChange={(c) => run(setAudio({ fadeInCurve: c }))} />} />
      <SecondsField label="Fade out" value={ticksToSeconds(audio.fadeOutTicks)} max={clipLength} data-action="fade-out"
        onChange={(v, seal) => run(setAudio({ fadeOutTicks: ticks(Math.min(v, clipLength)) }), { seal })}
        extra={<CurvePicker value={audio.fadeOutCurve} onChange={(c) => run(setAudio({ fadeOutCurve: c }))} />} />
      <label className="field slider" title="Applied to the exported audio. The preview cannot play louder than the file, so boosts are heard only in the export.">
        <span>Gain</span>
        <input
          type="range"
          min={-24}
          max={12}
          step={0.1}
          value={toDb(audio.gain)}
          onChange={(e) => run(setAudio({ gain: fromDb(Number(e.target.value)) }), { seal: false })}
          onPointerUp={() => run(setAudio({ gain: audio.gain }))}
        />
        <output>{formatDb(audio.gain)}</output>
      </label>
    </div>
  );
}

function SecondsField(props: {
  label: string;
  value: number;
  max: number;
  extra?: React.ReactNode;
  'data-action'?: string;
  onChange: (seconds: number, seal: boolean) => void;
}): React.JSX.Element {
  const { label, value, max, extra, onChange } = props;
  return (
    <label className="field seconds">
      <span>{label}</span>
      <span className="seconds-input">
        <input
          type="number"
          min={0}
          max={Number(max.toFixed(3))}
          step={0.01}
          value={Number(value.toFixed(3))}
          data-action={props['data-action']}
          onChange={(e) => {
            const parsed = Number(e.target.value);
            if (Number.isFinite(parsed)) onChange(parsed, false);
          }}
          onBlur={() => onChange(value, true)}
        />
        <span className="dim">s</span>
        {extra}
      </span>
    </label>
  );
}

function CurvePicker(props: { value: FadeCurve; onChange: (curve: FadeCurve) => void }): React.JSX.Element {
  return (
    <select value={props.value} title="Fade shape: equal power (steady loudness), linear, or an S-curve" onChange={(e) => props.onChange(e.target.value as FadeCurve)}>
      {FADE_CURVES.map((curve) => <option key={curve} value={curve}>{CURVE_LABELS[curve]}</option>)}
    </select>
  );
}

function toDb(gain: number): number {
  return gain <= 0 ? -24 : Math.max(-24, Math.min(12, 20 * Math.log10(gain)));
}

function fromDb(db: number): number {
  return db <= -24 ? 0 : 10 ** (db / 20);
}

function formatDb(gain: number): string {
  if (gain <= 0) return '−∞ dB';
  const db = 20 * Math.log10(gain);
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
}
