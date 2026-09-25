// The lyrics editor (ui-spec §5 "Lyrics", lyrics-spec §2, §5, §9).
//
// Two parts:
//  - **The left-rail section**: what there is (lines, timed, problems), a way in, and — when the
//    project has lyrics but nothing shows them — the one click that adds a lyrics layer.
//  - **The drawer** on the right edge, beside the canvas rather than over it (tapping needs both):
//    · Text — paste or type. Every edit re-derives the lines, keeping every timing that can be kept
//      (lyrics-commands.ts); typing merges into one undo step. `[Chorus]` and `(x2)` become markers.
//    · Lines — times you can type, role, lock, per-line actions, the selected line's words.
//    · Checklist — lyrics-spec §9, run continuously; a click selects the lines and moves the playhead.
//    · Tap to sync — the session's settings and the button that starts it (TapOverlay does the tapping).
//
// Nothing here edits the document directly: every change is a command (M8).

import { useEffect, useMemo, useRef, useState } from 'react';

import { lyricTokens } from '../../engine/core/lyrics.ts';
import { sourceToTimelineSeconds, TICKS_PER_SECOND } from '../../engine/core/time.ts';
import { LYRICS_EXPORT_FORMATS, type LyricsExportFormat } from '../../lyrics/formats.ts';
import { splitLongLine } from '../../lyrics/prepare.ts';
import { beginTapSession, type TapMode } from '../../lyrics/tap.ts';
import { formatLyricTime, parseLyricTime } from '../../lyrics/timecode.ts';
import { validateLyrics, type LyricsCheck } from '../../lyrics/validate.ts';
import { detectVocalSegments, type VocalSegment } from '../../lyrics/vocal-segments.ts';
import { addLayer } from '../../project/commands.ts';
import { createModuleLayer } from '../../project/create.ts';
import { LYRIC_ROLES, walkLayers, type LyricLine, type LyricRole, type ProjectDocument } from '../../project/document.ts';
import { newId } from '../../project/ids.ts';
import {
  clearLineTimes, lyricsToText, materialiseWords, mergeWithNext, setLineTimes, setLinesLocked, setLinesRole,
  setLyricsLanguage, setLyricsText, setWordTimes, splitLine,
} from '../../project/lyrics-commands.ts';
import type { AnalysisSet } from '../../engine/core/analysis.ts';
import { history, useStudio } from '../store.ts';
import { previewControls } from './CanvasPane.tsx';

const ROLE_LABELS: Readonly<Record<LyricRole, string>> = { lead: 'Lead', backing: 'Backing', adlib: 'Ad-lib', 'instrumental-note': 'Note' };
const EXPORT_LABELS: Readonly<Record<LyricsExportFormat, string>> = {
  lrc: 'LRC (lines)', elrc: 'LRC with word timings', srt: 'SRT subtitles', vtt: 'WebVTT (with words)', ass: 'ASS karaoke (\\k)',
};
const MAX_LINE_CHARS = 42;

const seconds = (ticks: number) => ticks / TICKS_PER_SECOND;

export function hasLyricsLayer(document: ProjectDocument): boolean {
  return [...walkLayers(document.layers)].some(({ layer }) => layer.kind === 'module' && layer.module === 'core.text.lyrics');
}

/** A new lyrics layer, near the bottom third where lyrics usually sit, on top of the stack. */
function addLyricsLayer(): ReturnType<typeof addLayer> & { readonly layerId: string } {
  const layer = createModuleLayer('core.text.lyrics', { id: newId(), name: 'Lyrics', transform: { y: 0.78 } });
  return Object.assign(addLayer(layer), { layerId: layer.id });
}

/** Singing on the vocal stem, in timeline seconds — for the checklist (lyrics-spec §9). */
export function useVocalSegments(analysis: AnalysisSet | null, document: ProjectDocument): readonly VocalSegment[] | undefined {
  const rms = analysis?.sources.get('vocals')?.features.get('rms');
  const { leadInTicks, clipInTicks } = document.audio;
  return useMemo(() => {
    if (rms === undefined) return undefined;
    const placement = { leadInTicks, clipInTicks };
    return detectVocalSegments(rms.data, rms.rate).map((s) => ({ start: sourceToTimelineSeconds(s.start, placement), end: sourceToTimelineSeconds(s.end, placement) }));
  }, [rms, leadInTicks, clipInTicks]);
}

function useChecks(): readonly LyricsCheck[] {
  const document = useStudio((s) => s.document);
  const analysis = useStudio((s) => s.analysis);
  const vocalSegments = useVocalSegments(analysis, document);
  return useMemo(() => validateLyrics(document.lyrics, vocalSegments === undefined ? {} : { vocalSegments }), [document.lyrics, vocalSegments]);
}

// ---------------------------------------------------------------------------
// Left rail
// ---------------------------------------------------------------------------

export function LyricsSection(): React.JSX.Element {
  const document = useStudio((s) => s.document);
  const run = useStudio((s) => s.run);
  const select = useStudio((s) => s.select);
  const setLyricsOpen = useStudio((s) => s.setLyricsOpen);
  const importLyricsFile = useStudio((s) => s.importLyricsFile);
  const checks = useChecks();
  const { lines } = document.lyrics;
  const timed = lines.filter((l) => l.startTicks !== null && l.endTicks !== null).length;
  const problems = checks.filter((c) => c.severity !== 'info').length;

  return (
    <section className="lyrics-section" data-testid="lyrics-section">
      <div className="section-head">
        <h2>Lyrics</h2>
        <button type="button" data-action="lyrics-open" onClick={() => setLyricsOpen(true)}>{lines.length === 0 ? 'Add…' : 'Edit…'}</button>
      </div>
      {lines.length === 0 ? (
        <p className="empty">
          No lyrics yet. Paste them, or import an .lrc / .srt file.{' '}
          <button type="button" className="link" onClick={() => void importLyricsFile()}>Import…</button>
        </p>
      ) : (
        <p className="dim" data-testid="lyrics-summary">
          {lines.length} line{lines.length === 1 ? '' : 's'} · {timed} timed
          {problems > 0 && <> · <button type="button" className="link warn" onClick={() => setLyricsOpen(true, 'checks')}>{problems} to check</button></>}
        </p>
      )}
      {lines.length > 0 && !hasLyricsLayer(document) && (
        <button
          type="button"
          className="wide"
          data-action="add-lyrics-layer"
          title="Nothing shows the lyrics yet: add a lyrics layer to see them on the canvas"
          onClick={() => {
            const command = addLyricsLayer();
            run(command);
            select(command.layerId);
          }}
        >
          Show lyrics on the canvas
        </button>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Drawer
// ---------------------------------------------------------------------------

export function LyricsDrawer(): React.JSX.Element | null {
  const open = useStudio((s) => s.lyricsOpen);
  const tab = useStudio((s) => s.lyricsTab);
  const setOpen = useStudio((s) => s.setLyricsOpen);
  const document = useStudio((s) => s.document);
  const run = useStudio((s) => s.run);
  const importLyricsFile = useStudio((s) => s.importLyricsFile);
  const exportLyrics = useStudio((s) => s.exportLyrics);
  const checks = useChecks();
  if (!open) return null;
  const { lyrics } = document;
  const timed = lyrics.lines.filter((l) => l.startTicks !== null && l.endTicks !== null).length;
  const flagged = checks.filter((c) => c.severity !== 'info').length;

  const splitLong = () => {
    const long = lyrics.lines.filter((l) => l.text.length > MAX_LINE_CHARS);
    if (long.length === 0) return;
    // Through the text: split lines are new lines (untimed), everything else keeps its timing.
    const text = lyricsToText({ ...lyrics, lines: lyrics.lines.flatMap((l) => (l.text.length > MAX_LINE_CHARS && l.startTicks === null
      ? splitLongLine(l.text, MAX_LINE_CHARS).map((t) => ({ ...l, text: t }))
      : [l])) });
    run(setLyricsText(text));
  };
  const longUntimed = lyrics.lines.filter((l) => l.text.length > MAX_LINE_CHARS && l.startTicks === null).length;

  return (
    <aside className="queue-drawer lyrics-drawer" aria-label="Lyrics" data-testid="lyrics-drawer">
      <div className="queue-head">
        <h2>Lyrics</h2>
        <span className="dim">{lyrics.lines.length} lines · {timed} timed</span>
        <span className="spacer" />
        <button type="button" onClick={() => setOpen(false)} title="Close (Esc)">✕</button>
      </div>
      <div className="lyrics-toolbar">
        <button type="button" data-action="lyrics-import" onClick={() => void importLyricsFile()} title=".lrc, .srt, .vtt, .ttml replace the lines with timed ones; .txt is read like a paste">Import…</button>
        <select
          value=""
          aria-label="Export"
          data-action="lyrics-export"
          onChange={(event) => {
            const format = event.target.value as LyricsExportFormat;
            if (format !== ('' as LyricsExportFormat)) void exportLyrics(format);
          }}
        >
          <option value="">Export…</option>
          {LYRICS_EXPORT_FORMATS.map((f) => <option key={f} value={f}>{EXPORT_LABELS[f]}</option>)}
        </select>
        <label className="inline" title="The language of the lyrics — alignment uses it to pick its model">
          Language
          <input
            type="text"
            className="short"
            value={lyrics.language}
            maxLength={12}
            onChange={(event) => {
              const value = event.target.value.trim();
              if (value !== '') run(setLyricsLanguage(value));
            }}
          />
        </label>
        {longUntimed > 0 && (
          <button type="button" onClick={splitLong} title={`Split the ${longUntimed} untimed lines longer than ${MAX_LINE_CHARS} characters at their natural breaks`}>
            Split long lines ({longUntimed})
          </button>
        )}
      </div>
      <div className="presets-filters lyrics-tabs">
        <TabButton tab="text" label="Text" />
        <TabButton tab="lines" label={`Lines (${lyrics.lines.length})`} />
        <TabButton tab="checks" label={flagged > 0 ? `Checklist (${flagged})` : 'Checklist'} />
      </div>
      {tab === 'text' && <TextTab />}
      {tab === 'lines' && <LinesTab />}
      {tab === 'checks' && <ChecksTab checks={checks} />}
      <TapControls />
    </aside>
  );
}

function TabButton(props: { tab: 'text' | 'lines' | 'checks'; label: string }): React.JSX.Element {
  const tab = useStudio((s) => s.lyricsTab);
  const setOpen = useStudio((s) => s.setLyricsOpen);
  return (
    <button type="button" className={tab === props.tab ? 'active' : ''} data-action={`lyrics-tab-${props.tab}`} onClick={() => setOpen(true, props.tab)}>
      {props.label}
    </button>
  );
}

/**
 * The text, as typed. The field owns its text while it has focus — re-deriving it from the document
 * on every keystroke would move the caret and eat blank lines — and takes the document's text again
 * when focus leaves or an undo changes the lyrics underneath it.
 */
function TextTab(): React.JSX.Element {
  const lyrics = useStudio((s) => s.document.lyrics);
  const run = useStudio((s) => s.run);
  const [text, setText] = useState(() => lyricsToText(lyrics));
  const focused = useRef(false);
  const pending = useRef<number | null>(null);

  useEffect(() => {
    if (!focused.current) setText(lyricsToText(lyrics));
  }, [lyrics]);
  useEffect(() => () => {
    if (pending.current !== null) window.clearTimeout(pending.current);
  }, []);

  const commit = (value: string) => {
    if (pending.current !== null) window.clearTimeout(pending.current);
    pending.current = null;
    run(setLyricsText(value), { seal: false });
  };

  return (
    <div className="lyrics-text">
      <textarea
        className="lyrics-textarea"
        data-testid="lyrics-textarea"
        spellCheck={false}
        placeholder={'Paste or type the lyrics, one sung line per line.\n\n[Chorus] or (Verse 2) on a line of its own becomes a marker, not a line.\n(x2) at the end of a line becomes a ×2 marker.\nA line in round brackets is a backing line.'}
        value={text}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
          commit(text);
          history.seal();
        }}
        onChange={(event) => {
          const value = event.target.value;
          setText(value);
          // A short pause before re-deriving the lines, so a burst of typing is one pass.
          if (pending.current !== null) window.clearTimeout(pending.current);
          pending.current = window.setTimeout(() => commit(value), 250);
        }}
      />
      <p className="dim">Editing text keeps the timing of every line whose text is unchanged, and of edited lines where it can.</p>
    </div>
  );
}

function TimeField(props: { ticks: number | null; label: string; onCommit: (ticks: number | null) => void }): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? formatLyricTime(props.ticks);
  const parsed = draft === null ? props.ticks : parseLyricTime(draft);
  return (
    <input
      type="text"
      className={`time-field${parsed === null && draft !== null && draft.trim() !== '' ? ' invalid' : ''}`}
      aria-label={props.label}
      placeholder="–:––.––"
      value={shown}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== null) {
          const value = parseLyricTime(draft);
          if (value !== null) props.onCommit(value === undefined ? null : value);
        }
        setDraft(null);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
        if (event.key === 'Escape') setDraft(null);
      }}
    />
  );
}

function LinesTab(): React.JSX.Element {
  const lyrics = useStudio((s) => s.document.lyrics);
  const selection = useStudio((s) => s.lyricsSelection);
  const setSelection = useStudio((s) => s.setLyricsSelection);
  const run = useStudio((s) => s.run);
  const markers = useMemo(() => {
    const map = new Map<string | null, string[]>();
    for (const s of lyrics.sections) map.set(s.beforeLineId, [...(map.get(s.beforeLineId) ?? []), s.label]);
    return map;
  }, [lyrics.sections]);
  const lastClicked = useRef<string | null>(null);

  if (lyrics.lines.length === 0) return <p className="empty">No lines yet — paste the lyrics in the Text tab.</p>;

  const click = (line: LyricLine, event: React.MouseEvent) => {
    const ids = lyrics.lines.map((l) => l.id);
    if (event.shiftKey && lastClicked.current !== null) {
      const a = ids.indexOf(lastClicked.current);
      const b = ids.indexOf(line.id);
      setSelection(ids.slice(Math.min(a, b), Math.max(a, b) + 1));
    } else if (event.ctrlKey || event.metaKey) {
      setSelection(selection.includes(line.id) ? selection.filter((id) => id !== line.id) : [...selection, line.id]);
    } else {
      setSelection([line.id]);
    }
    lastClicked.current = line.id;
    if (line.startTicks !== null) previewControls.seek(seconds(line.startTicks));
  };

  const chosen = lyrics.lines.filter((l) => selection.includes(l.id));
  const single = chosen.length === 1 ? chosen[0] : undefined;

  return (
    <div className="lyrics-lines">
      {chosen.length > 0 && (
        <div className="lyrics-bulk">
          <span className="dim">{chosen.length} selected</span>
          <select
            value=""
            aria-label="Role"
            onChange={(event) => {
              const role = event.target.value as LyricRole;
              if ((LYRIC_ROLES as readonly string[]).includes(role)) run(setLinesRole(chosen.map((l) => l.id), role));
            }}
          >
            <option value="">Role…</option>
            {LYRIC_ROLES.map((role) => <option key={role} value={role}>{ROLE_LABELS[role]}</option>)}
          </select>
          <button type="button" onClick={() => run(setLinesLocked(chosen.map((l) => l.id), !chosen.every((l) => l.locked)))}>
            {chosen.every((l) => l.locked) ? 'Unlock' : 'Lock'}
          </button>
          <button type="button" onClick={() => run(clearLineTimes(chosen.map((l) => l.id)))}>Clear times</button>
        </div>
      )}
      <ol className="lyric-lines" data-testid="lyric-lines">
        {lyrics.lines.map((line, index) => (
          <li key={line.id} className="lyric-line-wrap">
            {(markers.get(line.id) ?? []).map((label, i) => <div key={i} className="lyric-marker">{label}</div>)}
            <div
              className={`lyric-line${selection.includes(line.id) ? ' selected' : ''}${line.locked ? ' locked' : ''}`}
              data-line={line.id}
              data-timed={line.startTicks !== null && line.endTicks !== null ? 'yes' : 'no'}
              onClick={(event) => click(line, event)}
            >
              <span className="lyric-index dim">{index + 1}</span>
              <span className={`lyric-text role-${line.role}`} title={line.text}>{line.text}</span>
              <span onClick={(event) => event.stopPropagation()} className="lyric-times">
                <TimeField ticks={line.startTicks} label="Start" onCommit={(t) => run(setLineTimes(line.id, t, t === null ? null : line.endTicks ?? t + TICKS_PER_SECOND * 2))} />
                <TimeField ticks={line.endTicks} label="End" onCommit={(t) => run(setLineTimes(line.id, line.startTicks ?? (t === null ? null : Math.max(0, t - TICKS_PER_SECOND * 2)), t))} />
              </span>
              <button
                type="button"
                className={`lock${line.locked ? ' on' : ''}`}
                title={line.locked ? 'Locked: re-alignment will not touch it. Click to unlock.' : 'Lock when checked: re-alignment will never change it'}
                onClick={(event) => {
                  event.stopPropagation();
                  run(setLinesLocked([line.id], !line.locked));
                }}
              >
                {line.locked ? '🔒' : '🔓'}
              </button>
            </div>
          </li>
        ))}
        {(markers.get(null) ?? []).map((label, i) => <li key={`end-${i}`} className="lyric-marker">{label}</li>)}
      </ol>
      {single !== undefined && <LineDetail line={single} last={lyrics.lines[lyrics.lines.length - 1]?.id === single.id} />}
    </div>
  );
}

/** The selected line: its words (explicit or interpolated, editable), split and merge. */
function LineDetail(props: { line: LyricLine; last: boolean }): React.JSX.Element {
  const { line } = props;
  const run = useStudio((s) => s.run);
  const tokens = lyricTokens(line.text);
  const words = line.startTicks === null ? [] : materialiseWords(line);
  const explicit = line.words.length === tokens.length && tokens.length > 0;
  return (
    <div className="lyric-detail">
      <div className="lyric-detail-head">
        <strong>Words</strong>
        <span className="dim">{line.startTicks === null ? 'time the line first' : explicit ? 'timed word by word' : 'interpolated by length'}</span>
        <span className="spacer" />
        {!props.last && <button type="button" onClick={() => run(mergeWithNext(line.id))} title="Join with the next line">Merge ↓</button>}
      </div>
      <div className="lyric-words">
        {tokens.map((token, i) => {
          const word = words[i];
          const confidence = line.words[i]?.confidence ?? null;
          return (
            <span key={`${i}-${token.text}`} className={`lyric-word${confidence !== null && confidence < 0.5 ? ' low' : ''}`} title={confidence === null ? undefined : `Alignment confidence ${(confidence * 100).toFixed(0)}%`}>
              {i > 0 && (
                <button type="button" className="split" title={`Split the line before “${token.text}”`} onClick={() => run(splitLine(line.id, i))}>⏎</button>
              )}
              <span className="word-text">{token.text}</span>
              {word !== undefined && (
                <TimeField ticks={word.startTicks} label={`Start of ${token.text}`} onCommit={(t) => {
                  if (t !== null) run(setWordTimes(line.id, i, t, Math.max(t, word.endTicks)));
                }} />
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function ChecksTab(props: { checks: readonly LyricsCheck[] }): React.JSX.Element {
  const setSelection = useStudio((s) => s.setLyricsSelection);
  const setOpen = useStudio((s) => s.setLyricsOpen);
  const analysis = useStudio((s) => s.analysis);
  const hasVocals = analysis?.sources.has('vocals') === true;
  return (
    <div className="lyrics-checks" data-testid="lyrics-checks">
      {!hasVocals && (
        <p className="dim">
          Separate stems (Audio panel) to also check lines against where the singing actually is.
        </p>
      )}
      {props.checks.length === 0 ? (
        <p className="ok">Nothing to check.</p>
      ) : (
        <ul className="check-list">
          {props.checks.map((check, i) => (
            <li key={i} className={`check ${check.severity}`} data-check={check.kind}>
              <button
                type="button"
                className="link"
                onClick={() => {
                  if (check.lineIds.length > 0) {
                    setSelection(check.lineIds);
                    setOpen(true, 'lines');
                  }
                  if (check.atTicks !== null) previewControls.seek(seconds(check.atTicks));
                }}
              >
                {check.severity === 'error' ? '✖' : check.severity === 'warning' ? '⚠' : 'ℹ'} {check.message}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tap to sync — settings and start (the tapping itself is TapOverlay)
// ---------------------------------------------------------------------------

const MODES: readonly { value: TapMode; label: string; hint: string }[] = [
  { value: 'starts', label: 'Line starts', hint: 'Tap T as each line begins; hold T through a line to mark its end too.' },
  { value: 'ends', label: 'Line ends', hint: 'Tap T as each timed line ends.' },
  { value: 'words', label: 'Words of the selected line', hint: 'Tap T on each word of the selected line, and once more where it ends.' },
];

function TapControls(): React.JSX.Element {
  const lyrics = useStudio((s) => s.document.lyrics);
  const selection = useStudio((s) => s.lyricsSelection);
  const analysis = useStudio((s) => s.analysis);
  const settings = useStudio((s) => s.settings);
  const tap = useStudio((s) => s.tap);
  const setTap = useStudio((s) => s.setTap);
  const notify = useStudio((s) => s.notify);
  const [mode, setMode] = useState<TapMode>('starts');
  const [rate, setRate] = useState(1);
  const [calibrating, setCalibrating] = useState(false);
  const hasVocalOnsets = analysis?.sources.get('vocals')?.features.has('onset') === true;
  const [snapOnsets, setSnapOnsets] = useState(true);
  const [snapBeats, setSnapBeats] = useState(false);
  const latency = settings?.tapLatencyMs ?? null;

  const start = () => {
    const ordered = lyrics.lines.map((l) => l.id);
    const range = mode === 'words'
      ? selection.slice(0, 1)
      : selection.length > 1 ? ordered.filter((id) => selection.includes(id))
        : selection.length === 1 ? ordered.slice(ordered.indexOf(selection[0] as string)) : ordered;
    try {
      const session = beginTapSession(lyrics, mode, range.length > 0 ? range : undefined);
      setTap({ session, rate, snapOnsets: snapOnsets && hasVocalOnsets, snapBeats: snapBeats && !(snapOnsets && hasVocalOnsets), taps: 0 });
      // Start a little before the first line to tap, if the line before it has a time to go by.
      const first = lyrics.lines.findIndex((l) => l.id === session.lineIds[0]);
      const before = mode === 'words' ? lyrics.lines[first] : lyrics.lines.slice(0, Math.max(0, first)).reverse().find((l) => l.startTicks !== null);
      if (before?.startTicks != null) previewControls.seek(Math.max(0, seconds(before.startTicks) - (mode === 'words' ? 1 : 0)));
      previewControls.setRate(rate);
      previewControls.play();
    } catch (error) {
      notify({ text: error instanceof Error ? error.message : String(error), kind: 'warn' });
    }
  };

  return (
    <div className="tap-controls" data-testid="tap-controls">
      <h3>Tap to sync</h3>
      <div className="tap-row">
        <select value={mode} onChange={(event) => setMode(event.target.value as TapMode)} aria-label="What to tap">
          {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
        <select value={rate} onChange={(event) => setRate(Number(event.target.value))} aria-label="Playback speed" title="Slower playback does not change timing accuracy: taps are recorded in song time">
          <option value={1}>1×</option>
          <option value={0.75}>0.75×</option>
          <option value={0.5}>0.5×</option>
        </select>
      </div>
      <p className="dim">{MODES.find((m) => m.value === mode)?.hint}{mode !== 'words' && selection.length > 0 ? ' Starts from the selected line (select several to re-tap just those).' : ''}</p>
      <label className="check-row" title={hasVocalOnsets ? 'A tap lands on the nearest vocal onset within 0.1 s — usually more accurate than the tap itself' : 'Needs the vocal stem: separate stems in the Audio panel'}>
        <input type="checkbox" checked={snapOnsets && hasVocalOnsets} disabled={!hasVocalOnsets} onChange={(event) => setSnapOnsets(event.target.checked)} />
        Snap to vocal onsets{!hasVocalOnsets && <span className="dim"> (needs stems)</span>}
      </label>
      <label className="check-row" title="Vocals rarely sit exactly on the grid; forcing them there usually sounds worse">
        <input type="checkbox" checked={snapBeats && !(snapOnsets && hasVocalOnsets)} disabled={snapOnsets && hasVocalOnsets} onChange={(event) => setSnapBeats(event.target.checked)} />
        Snap to the beat grid
      </label>
      <div className="tap-row">
        <span className={latency === null ? 'warn' : 'dim'} data-testid="tap-latency">
          {latency === null ? 'Tap latency not calibrated — taps land late' : `Tap latency ${latency.toFixed(0)} ms`}
        </span>
        <button type="button" data-action="tap-calibrate" onClick={() => setCalibrating(true)}>Calibrate…</button>
      </div>
      <button type="button" className="primary wide" data-action="tap-start" disabled={tap !== null || lyrics.lines.length === 0} onClick={start}>
        {tap !== null ? 'Tapping…' : 'Start tapping'}
      </button>
      {calibrating && <CalibrateDialog onClose={() => setCalibrating(false)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Latency calibration (lyrics-spec §3, D33)
// ---------------------------------------------------------------------------

const CLICKS = 16;
const CLICK_SPACING = 0.6;
const WARM_UP = 4;

/**
 * Tap along to a click track; the mean offset is this person's latency. Measured against when the
 * clicks were actually **heard** (`getOutputTimestamp` maps the audio clock to the page clock, so
 * output latency is not counted as the person's). The first taps are ignored — people need a few to
 * lock on — and taps more than 250 ms from a click are strays.
 */
export function CalibrateDialog(props: { onClose: () => void }): React.JSX.Element {
  const updateSettings = useStudio((s) => s.updateSettings);
  const [state, setState] = useState<'ready' | 'running' | 'done'>('ready');
  const [result, setResult] = useState<{ mean: number; spread: number; used: number } | null>(null);
  const [count, setCount] = useState(0);
  const run = useRef<{ context: AudioContext; clicks: number[]; taps: number[] } | null>(null);

  useEffect(() => () => {
    void run.current?.context.close();
  }, []);

  const finish = () => {
    const current = run.current;
    if (current === null) return;
    const offsets: number[] = [];
    for (const tap of current.taps) {
      const nearest = current.clicks.reduce((best, c) => (Math.abs(c - tap) < Math.abs(best - tap) ? c : best), Infinity);
      const index = current.clicks.indexOf(nearest);
      if (index >= WARM_UP && Math.abs(tap - nearest) < 0.25) offsets.push(tap - nearest);
    }
    void current.context.close();
    run.current = null;
    if (offsets.length < 4) {
      setResult(null);
      setState('done');
      return;
    }
    const mean = offsets.reduce((a, b) => a + b, 0) / offsets.length;
    const spread = Math.sqrt(offsets.reduce((a, b) => a + (b - mean) ** 2, 0) / offsets.length);
    setResult({ mean: mean * 1000, spread: spread * 1000, used: offsets.length });
    setState('done');
  };

  const begin = () => {
    const context = new AudioContext();
    const start = context.currentTime + 0.5;
    const clicks: number[] = [];
    for (let i = 0; i < CLICKS; i += 1) {
      const at = start + i * CLICK_SPACING;
      clicks.push(at);
      const osc = context.createOscillator();
      const gain = context.createGain();
      osc.frequency.value = i % 4 === 0 ? 1320 : 880;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.6, at + 0.002);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.06);
      osc.connect(gain).connect(context.destination);
      osc.start(at);
      osc.stop(at + 0.08);
    }
    run.current = { context, clicks, taps: [] };
    setCount(0);
    setState('running');
    window.setTimeout(finish, (0.5 + CLICKS * CLICK_SPACING + 0.4) * 1000);
  };

  useEffect(() => {
    if (state !== 'running') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat || (event.key.toLowerCase() !== 't' && event.key !== ' ')) return;
      event.preventDefault();
      event.stopPropagation();
      const current = run.current;
      if (current === null) return;
      // The key press in audio-clock time, as heard: map the event's page time through the output
      // timestamp, which relates the two clocks at the moment sound leaves the device.
      const stamp = current.context.getOutputTimestamp();
      const contextTime = (stamp.contextTime ?? current.context.currentTime) + (event.timeStamp - (stamp.performanceTime ?? performance.now())) / 1000;
      current.taps.push(contextTime);
      setCount(current.taps.length);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [state]);

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal calibrate-dialog" role="dialog" aria-label="Calibrate tap latency" onClick={(event) => event.stopPropagation()}>
        <h2>Calibrate tap latency</h2>
        {state === 'ready' && (
          <>
            <p>You will hear {CLICKS} clicks. Tap <kbd>T</kbd> on each one, as you would tap a line. It takes about ten seconds.</p>
            <p className="dim">Everyone taps a little late — usually 80–150 ms — and consistently. Measuring it once makes every tap land where you meant it.</p>
          </>
        )}
        {state === 'running' && <p>Tap <kbd>T</kbd> on each click… {count} taps</p>}
        {state === 'done' && (result === null
          ? <p className="warn">Too few taps landed near a click to measure. Try again, tapping on every click.</p>
          : (
            <>
              <p>You tap <strong>{result.mean.toFixed(0)} ms</strong> {result.mean >= 0 ? 'late' : 'early'} (±{result.spread.toFixed(0)} ms over {result.used} taps).</p>
              {result.spread > 60 && <p className="warn">The taps were uneven; a second try usually gives a steadier number.</p>}
            </>
          ))}
        <div className="modal-actions">
          <button type="button" onClick={props.onClose}>{state === 'done' && result !== null ? 'Discard' : 'Close'}</button>
          {state !== 'running' && <button type="button" onClick={begin}>{state === 'ready' ? 'Start' : 'Again'}</button>}
          {state === 'done' && result !== null && (
            <button type="button" className="primary" onClick={() => {
              void updateSettings({ tapLatencyMs: Math.round(result.mean) });
              props.onClose();
            }}>Use {result.mean.toFixed(0)} ms</button>
          )}
        </div>
      </div>
    </div>
  );
}
