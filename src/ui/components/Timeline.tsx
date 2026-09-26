// The timeline (ui-spec §3): waveform, beat grid, sections, the lyrics lane, layer blocks and the
// playhead.
//
// Canvas-drawn, not DOM. A DOM timeline dies at thousands of beat ticks and waveform samples,
// and this one draws a peak pyramid built for exactly this purpose — `peaksForRange` picks the
// mip level for the visible span, so zooming out costs no more than zooming in.
//
// **Zoom and pan** (ui-spec §3): the wheel zooms around the pointer, Shift+wheel pans, F fits. The
// view follows the playhead while playing. Dragging on the waveform scrubs, and since the preview
// renders the frame at every seek, scrubbing shows the karaoke fill live (lyrics-spec §5).
//
// **The lyrics lane** (lyrics-spec §5, M19) sits under the waveform, with the **vocal stem's level
// drawn behind the line blocks** — the feature that makes correction fast, because you can see
// where the singing starts. Lines are blocks: click to select (Shift, Ctrl to extend), drag to move
// (Alt ripples everything after), drag an edge to resize, and on a selected line drag the boundary
// between two words. Edges snap to vocal onsets, other lines, the playhead and — when asked — the
// beat grid; Shift while dragging turns snapping off. Each drag is one undo step (timeline-edit.ts).
//
// **Keyframes** (S1, keyframes-spec §5): each animated parameter gets a row under its layer (the
// whole frame's after the layers), its keys drawn as diamonds. Click selects a key (Shift adds),
// drag moves the selection — snapping to beats and the playhead, not with Shift — Alt-drag copies,
// Delete removes. A drag is computed from the document as it was when it started, so passing over
// another key never destroys it mid-drag, and the whole drag is one undo step.
//
// **Markers** (S9, ui-spec §3) have a lane under the waveform: a flag and a name each, and a faint
// line down through every lane. M adds one at the playhead, a double-click in the lane adds one
// there; click a flag to jump to it, drag it to move it, double-click or right-click it to rename,
// recolour or delete it, Delete removes the selected one. [ and ] jump to the previous and next
// marker (or section boundary). Every drag on the timeline — keys, lyric edges, markers — snaps to
// the beat grid, section boundaries, markers and the playhead; Shift turns snapping off.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { peaksForRange } from '../../analysis/peaks.ts';
import { lyricTokens, wordSpans } from '../../engine/core/lyrics.ts';
import { sourceToTimelineSeconds, TICKS_PER_SECOND, ticksToSeconds } from '../../engine/core/time.ts';
import { onsetPeaks } from '../../lyrics/tap.ts';
import { detectVocalSegments } from '../../lyrics/vocal-segments.ts';
import { dragEdgeTicks, planLyricDrag, snapDelta, snapTargets, type LyricDrag } from '../../lyrics/timeline-edit.ts';
import { MARKER_COLORS, walkLayers, type AutomationTrack, type Layer, type LyricLine, type Lyrics, type Marker, type ProjectDocument } from '../../project/document.ts';
import { addMarker, markerTicks, moveMarker, nearestTarget, removeMarkers, renameMarker, setMarkerColor } from '../../project/markers.ts';
import { moveKeyframes, removeKeyframes, setKeyframe } from '../../project/automation-commands.ts';
import { newId } from '../../project/ids.ts';
import { setLineTimings } from '../../project/lyrics-commands.ts';
import { timelineDurationTicks } from '../../project/snapshot.ts';
import { history, useStudio } from '../store.ts';
import { clampView, fitView, follow, panBy, zoomAt, type TimelineView } from '../timeline-view.ts';
import { previewControls } from './CanvasPane.tsx';
import { jumpToStop } from '../marker-nav.ts';

const ROW_HEIGHT = 18;
const WAVE_HEIGHT = 56;
const LYRIC_HEIGHT = 30;
/** The markers lane, between the waveform and the lyrics. */
const MARKER_HEIGHT = 16;
const MARKER_TOP = WAVE_HEIGHT + 2;
/** Where the lanes under the markers start. */
const LANES_TOP = WAVE_HEIGHT + 4 + MARKER_HEIGHT;
const PADDING = 8;
/** The timeline grows with the layer count up to a cap, so the canvas keeps most of the window. */
const MIN_HEIGHT = 132;
const MAX_HEIGHT = 280;
/** How close, in pixels, a pointer must be to grab an edge — and a drag to snap. */
const EDGE_PX = 5;
const SNAP_PX = 8;

type Timed = LyricLine & { readonly startTicks: number; readonly endTicks: number };
const isTimed = (line: LyricLine): line is Timed => line.startTicks !== null && line.endTicks !== null;

interface Geometry {
  readonly width: number;
  readonly view: TimelineView;
}

const xOf = (g: Geometry, seconds: number) => PADDING + ((seconds - g.view.start) / g.view.span) * (g.width - PADDING * 2);
const secondsAt = (g: Geometry, x: number) => g.view.start + ((x - PADDING) / Math.max(1, g.width - PADDING * 2)) * g.view.span;

/** What is under the pointer in the lyrics lane. */
type LyricHit =
  | { readonly kind: 'start' | 'end' | 'move'; readonly line: Timed }
  | { readonly kind: 'word'; readonly line: Timed; readonly wordIndex: number };

function hitLyric(lyrics: Lyrics, g: Geometry, x: number, selection: readonly string[]): LyricHit | null {
  // A selected line wins over whatever overlaps it, so a line under another stays reachable:
  // select it in the list (or by clicking where it shows), then drag it.
  const timed = [...lyrics.lines.filter((l) => isTimed(l) && !selection.includes(l.id)), ...lyrics.lines.filter((l) => isTimed(l) && selection.includes(l.id))].filter(isTimed);
  // Topmost first: later lines are drawn over earlier ones.
  for (let i = timed.length - 1; i >= 0; i -= 1) {
    const line = timed[i] as Timed;
    const left = xOf(g, ticksToSeconds(line.startTicks));
    const right = xOf(g, ticksToSeconds(line.endTicks));
    if (x < left - EDGE_PX || x > right + EDGE_PX) continue;
    if (Math.abs(x - left) <= EDGE_PX) return { kind: 'start', line };
    if (Math.abs(x - right) <= EDGE_PX) return { kind: 'end', line };
    if (selection.length === 1 && selection[0] === line.id) {
      const spans = wordSpans({ id: line.id, text: line.text, startTicks: line.startTicks, endTicks: line.endTicks, role: line.role, words: line.words, style: null });
      for (let w = 1; w < spans.length; w += 1) {
        const bx = xOf(g, (spans[w] as { start: number }).start);
        const gap = xOf(g, (spans[w] as { start: number }).start) - xOf(g, (spans[w - 1] as { start: number }).start);
        if (gap > EDGE_PX * 2 && Math.abs(x - bx) <= EDGE_PX - 1) return { kind: 'word', line, wordIndex: w };
      }
    }
    if (x >= left && x <= right) return { kind: 'move', line };
  }
  return null;
}

interface DragState {
  readonly drag: LyricDrag;
  readonly start: Lyrics;
  readonly originX: number;
  readonly mergeKey: string;
  moved: boolean;
}

let dragCount = 0;

export function Timeline(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const document = useStudio((s) => s.document);
  const peaks = useStudio((s) => s.peaks);
  const analysis = useStudio((s) => s.analysis);
  const sections = useStudio((s) => s.sections);
  // The canvas reads the theme's tokens when it draws, so a theme change must draw it again.
  const theme = useStudio((s) => s.settings?.theme);
  const timelineSeconds = useStudio((s) => s.timelineSeconds);
  const transport = useStudio((s) => s.transport);
  const selectedLayerId = useStudio((s) => s.selectedLayerId);
  const select = useStudio((s) => s.select);
  const lyricsSelection = useStudio((s) => s.lyricsSelection);
  const setLyricsSelection = useStudio((s) => s.setLyricsSelection);
  const setLyricsOpen = useStudio((s) => s.setLyricsOpen);
  const lyricSnap = useStudio((s) => s.lyricSnap);
  const run = useStudio((s) => s.run);
  const keySelection = useStudio((s) => s.keySelection);
  const setKeySelection = useStudio((s) => s.setKeySelection);
  const markerSelection = useStudio((s) => s.markerSelection);
  const setMarkerSelection = useStudio((s) => s.setMarkerSelection);
  /** The marker editor (name, colour, delete), open over the lane at a flag. */
  const [editing, setEditing] = useState<{ readonly id: string; readonly left: number } | null>(null);
  /** Where each flag and its label were drawn, for the hit test. */
  const flagHits = useRef<{ readonly id: string; readonly left: number; readonly right: number }[]>([]);

  const duration = Math.max(0.001, ticksToSeconds(timelineDurationTicks(document)));
  const { leadInTicks, clipInTicks } = document.audio;
  const leadIn = ticksToSeconds(leadInTicks);
  const placement = useMemo(() => ({ leadInTicks, clipInTicks }), [leadInTicks, clipInTicks]);
  const clipStart = ticksToSeconds(document.audio.clipInTicks);
  const clipEnd = ticksToSeconds(document.audio.clipOutTicks ?? document.audio.durationTicks);
  const hasLyricsLane = document.lyrics.lines.length > 0;

  const [view, setView] = useState<TimelineView>(() => fitView(duration));
  const viewRef = useRef(view);
  viewRef.current = view;
  // A longer or shorter timeline keeps the view inside it; a fitted view stays fitted.
  const lastDuration = useRef(duration);
  useEffect(() => {
    if (lastDuration.current === duration) return;
    const wasFitted = viewRef.current.start === 0 && Math.abs(viewRef.current.span - Math.max(1, lastDuration.current)) < 1e-6;
    lastDuration.current = duration;
    setView(wasFitted ? fitView(duration) : clampView(viewRef.current, duration));
  }, [duration]);
  useEffect(() => {
    if (transport === 'playing') setView((v) => follow(v, timelineSeconds, duration));
  }, [transport, timelineSeconds, duration]);

  // The vocal stem's level, drawn **relative to this track** — Demucs leaves a bed of bleed in the
  // stem, and on the analysis' dB scale that reads high everywhere — plus where singing was
  // detected (the same segments the checklist uses).
  const vocalRms = analysis?.sources.get('vocals')?.features.get('rms');
  const vocal = useMemo(() => {
    if (vocalRms === undefined) return null;
    const sorted = Float32Array.from(vocalRms.data).sort();
    const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))] ?? 0;
    const floor = at(0.2);
    const loud = Math.max(floor + 1e-3, at(0.98));
    const segments = detectVocalSegments(vocalRms.data, vocalRms.rate).map((seg) => ({
      start: sourceToTimelineSeconds(seg.start, placement),
      end: sourceToTimelineSeconds(seg.end, placement),
    }));
    return { track: vocalRms, floor, loud, segments };
  }, [vocalRms, placement]);
  const vocalOnset = analysis?.sources.get('vocals')?.features.get('onset');
  const onsetTicks = useMemo(
    () => (vocalOnset === undefined ? [] : onsetPeaks(vocalOnset).map((s) => Math.round(sourceToTimelineSeconds(s, placement) * TICKS_PER_SECOND))),
    [vocalOnset, placement],
  );

  // What a drag snaps to (ui-spec §3): the beat grid, section boundaries, markers and the playhead.
  const beatTicks = useMemo(
    () => (analysis?.beatGrid?.beats ?? []).map((b) => Math.round(sourceToTimelineSeconds(b, placement) * TICKS_PER_SECOND)),
    [analysis, placement],
  );
  const sectionTicks = useMemo(
    () => sections.flatMap((sec) => [sec.startSeconds, sec.endSeconds]).map((sec) => Math.round(sourceToTimelineSeconds(sec, placement) * TICKS_PER_SECOND)),
    [sections, placement],
  );
  const snapTargetsFor = useCallback(
    (exceptMarkers: ReadonlySet<string> = new Set()) => [
      ...beatTicks, ...sectionTicks, ...markerTicks(document, exceptMarkers), Math.round(timelineSeconds * TICKS_PER_SECOND),
    ],
    [beatTicks, sectionTicks, document, timelineSeconds],
  );

  const geometry = useCallback((): Geometry | null => {
    const canvas = canvasRef.current;
    if (canvas === null) return null;
    return { width: canvas.getBoundingClientRect().width, view: viewRef.current };
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;

    const style = getComputedStyle(canvas);
    const colour = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
    const line = colour('--line', '#2a2a33');
    const dim = colour('--text-dim', '#9a9aa6');
    const text = colour('--text', '#e6e6ea');
    const accent = colour('--accent', '#8ea4d2');
    const control = colour('--control', '#8b8b98');
    const raised = colour('--panel-raised', '#1e1e25');
    const warn = colour('--warn', '#ffb020');

    const g: Geometry = { width: rect.width, view };
    const x = (seconds: number) => xOf(g, seconds);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    const inner = rect.width - PADDING * 2;

    // Sections first, as backdrop bands.
    for (const [index, section] of sections.entries()) {
      ctx.fillStyle = index % 2 === 0 ? colour('--band-a', 'rgba(255,255,255,0.03)') : colour('--band-b', 'rgba(255,255,255,0.06)');
      const left = x(sourceToTimelineSeconds(section.startSeconds, placement));
      ctx.fillRect(left, 0, x(sourceToTimelineSeconds(section.endSeconds, placement)) - left, rect.height);
    }

    // Beat grid. Downbeats emphasised; skipped entirely when they would be closer than 3 px,
    // because a solid grey wash tells you nothing.
    const grid = analysis?.beatGrid;
    if (grid !== undefined && grid.beats.length > 1) {
      const spacing = x(grid.beats[1] as number) - x(grid.beats[0] as number);
      if (spacing > 3) {
        for (const [index, beat] of grid.beats.entries()) {
          const bx = x(sourceToTimelineSeconds(beat, placement));
          if (bx < 0 || bx > rect.width) continue;
          ctx.strokeStyle = index % 4 === 0 ? dim : line;
          ctx.beginPath();
          ctx.moveTo(bx, 0);
          ctx.lineTo(bx, WAVE_HEIGHT);
          ctx.stroke();
        }
      }
    }

    // Waveform from the peak pyramid — the clip only, where it sits on the timeline (trim and
    // lead-in applied: before, the whole file was drawn from the lead-in, ignoring the trim).
    if (peaks !== null) {
      const audibleFrom = Math.max(view.start, leadIn);
      const audibleTo = Math.min(view.start + view.span, leadIn + Math.max(0, clipEnd - clipStart));
      if (audibleTo > audibleFrom) {
        const left = x(audibleFrom);
        const columns = Math.max(1, Math.floor(x(audibleTo) - left));
        const window = peaksForRange(peaks, audibleFrom - leadIn + clipStart, audibleTo - leadIn + clipStart, columns);
        const mid = WAVE_HEIGHT / 2;
        // Neutral: the waveform is information, and a coloured one competes with the canvas (ui-spec §12).
        ctx.fillStyle = control;
        ctx.globalAlpha = 0.75;
        for (let i = 0; i < columns; i += 1) {
          const top = mid - (window.max[i] ?? 0) * mid;
          const bottom = mid - (window.min[i] ?? 0) * mid;
          ctx.fillRect(left + i, top, 1, Math.max(1, bottom - top));
        }
        ctx.globalAlpha = 1;
      }
    } else {
      ctx.strokeStyle = line;
      ctx.beginPath();
      ctx.moveTo(PADDING, WAVE_HEIGHT / 2);
      ctx.lineTo(rect.width - PADDING, WAVE_HEIGHT / 2);
      ctx.stroke();
    }

    // The markers lane: a flag and a name per marker; the lines through every lane come last.
    ctx.fillStyle = colour('--lane', 'rgba(255,255,255,0.025)');
    ctx.fillRect(PADDING, MARKER_TOP, inner, MARKER_HEIGHT);
    ctx.font = '10px "Segoe UI", system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const hits: { id: string; left: number; right: number }[] = [];
    const markers = document.markers;
    if (markers.length === 0) {
      ctx.fillStyle = dim;
      ctx.globalAlpha = 0.6;
      ctx.fillText('Markers — M adds one at the playhead', PADDING + 4, MARKER_TOP + MARKER_HEIGHT / 2 + 0.5);
      ctx.globalAlpha = 1;
    }
    for (const [i, marker] of markers.entries()) {
      const mx = x(ticksToSeconds(marker.ticks));
      if (mx < PADDING - 60 || mx > rect.width - PADDING) continue;
      const next = markers[i + 1];
      const room = next === undefined ? rect.width - PADDING - mx : x(ticksToSeconds(next.ticks)) - mx;
      const selected = markerSelection === marker.id;
      ctx.fillStyle = marker.color ?? accent;
      ctx.beginPath();
      ctx.moveTo(mx, MARKER_TOP + 1);
      ctx.lineTo(mx + 7, MARKER_TOP + 5);
      ctx.lineTo(mx, MARKER_TOP + 9);
      ctx.closePath();
      ctx.fill();
      ctx.fillRect(mx - 0.5, MARKER_TOP + 1, 1.5, MARKER_HEIGHT - 2);
      const label = marker.name === '' ? '(unnamed)' : marker.name;
      const labelWidth = Math.min(ctx.measureText(label).width, Math.max(0, room - 14));
      if (labelWidth > 8) {
        ctx.fillStyle = selected ? text : dim;
        ctx.fillText(label, mx + 9, MARKER_TOP + MARKER_HEIGHT / 2 + 0.5, labelWidth);
      }
      if (selected) {
        ctx.strokeStyle = marker.color ?? accent;
        ctx.strokeRect(mx - 3.5, MARKER_TOP + 0.5, Math.max(12, labelWidth + 14), MARKER_HEIGHT - 1);
      }
      hits.push({ id: marker.id, left: mx - 5, right: mx + Math.max(9, labelWidth + 11) });
    }
    flagHits.current = hits;
    ctx.textBaseline = 'alphabetic';

    let top = LANES_TOP;
    if (hasLyricsLane) {
      const laneTop = top;
      ctx.fillStyle = colour('--lane', 'rgba(255,255,255,0.025)');
      ctx.fillRect(PADDING, laneTop, inner, LYRIC_HEIGHT);
      // The vocal stem's level behind the blocks: where the singing is.
      if (vocal !== null) {
        const vocalPeak = vocal.track;
        ctx.fillStyle = accent;
        ctx.globalAlpha = 0.28;
        const columns = Math.max(1, Math.floor(inner));
        for (let c = 0; c < columns; c += 1) {
          const t0 = secondsAt(g, PADDING + c);
          const t1 = secondsAt(g, PADDING + c + 1);
          if (t1 < leadIn || t0 > leadIn + clipEnd - clipStart) continue;
          const s0 = Math.max(0, Math.floor((t0 - leadIn + clipStart) * vocalPeak.rate));
          const s1 = Math.max(s0 + 1, Math.ceil((t1 - leadIn + clipStart) * vocalPeak.rate));
          let level = 0;
          for (let s = s0; s < s1 && s < vocalPeak.data.length; s += 1) level = Math.max(level, vocalPeak.data[s] ?? 0);
          const h = Math.min(1, Math.max(0, (level - vocal.floor) / (vocal.loud - vocal.floor))) * (LYRIC_HEIGHT - 2);
          ctx.fillRect(PADDING + c, laneTop + (LYRIC_HEIGHT - h) / 2, 1, h);
        }
        ctx.globalAlpha = 0.8;
        for (const seg of vocal.segments) {
          const left = Math.max(PADDING, x(seg.start));
          const right = Math.min(rect.width - PADDING, x(seg.end));
          if (right > left) ctx.fillRect(left, laneTop + LYRIC_HEIGHT - 2, right - left, 2);
        }
        ctx.globalAlpha = 1;
      }
      ctx.font = '11px "Segoe UI", system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      // Selected lines last: on top, as the hit test treats them.
      const drawn = document.lyrics.lines.filter(isTimed).sort((a, b) => Number(lyricsSelection.includes(a.id)) - Number(lyricsSelection.includes(b.id)));
      for (const lyric of drawn) {
        const left = x(ticksToSeconds(lyric.startTicks));
        const right = x(ticksToSeconds(lyric.endTicks));
        if (right < 0 || left > rect.width) continue;
        const selected = lyricsSelection.includes(lyric.id);
        const blockTop = laneTop + (lyric.role === 'lead' ? 3 : lyric.role === 'instrumental-note' ? 3 : 8);
        const blockHeight = lyric.role === 'lead' || lyric.role === 'instrumental-note' ? LYRIC_HEIGHT - 6 : LYRIC_HEIGHT - 11;
        // Translucent, so the vocal level stays readable through the block — that is what lines are
        // lined up against.
        ctx.fillStyle = selected ? 'rgba(142,164,210,0.22)' : 'rgba(120,120,150,0.16)';
        ctx.fillRect(left, blockTop, Math.max(2, right - left), blockHeight);
        ctx.strokeStyle = selected ? accent : lyric.locked ? colour('--ok', '#3ddc97') : dim;
        ctx.strokeRect(left + 0.5, blockTop + 0.5, Math.max(2, right - left) - 1, blockHeight - 1);
        // Word boundaries: solid where timed word by word, faint where interpolated.
        const tokens = lyricTokens(lyric.text);
        const spans = wordSpans({ id: lyric.id, text: lyric.text, startTicks: lyric.startTicks, endTicks: lyric.endTicks, role: lyric.role, words: lyric.words, style: null });
        const explicit = lyric.words.length === tokens.length && tokens.length > 0;
        if (right - left > tokens.length * 4) {
          spans.forEach((span, w) => {
            const confidence = explicit ? lyric.words[w]?.confidence ?? null : null;
            if (confidence !== null && confidence < 0.5) {
              ctx.fillStyle = warn;
              ctx.globalAlpha = 0.25;
              ctx.fillRect(x(span.start), blockTop + 1, Math.max(1, x(span.end) - x(span.start)), blockHeight - 2);
              ctx.globalAlpha = 1;
            }
            if (w === 0) return;
            ctx.strokeStyle = explicit ? dim : line;
            ctx.beginPath();
            ctx.moveTo(x(span.start) + 0.5, blockTop + 2);
            ctx.lineTo(x(span.start) + 0.5, blockTop + blockHeight - 2);
            ctx.stroke();
          });
        }
        // The label stays in view when the block starts off the left edge.
        const labelX = Math.max(left, PADDING) + 4;
        ctx.fillStyle = selected ? text : dim;
        ctx.fillText(lyric.text, labelX, blockTop + blockHeight / 2 + 0.5, Math.max(8, right - labelX - 4));
      }
      ctx.fillStyle = dim;
      ctx.fillText('Lyrics', PADDING + 2, laneTop - 1 + 0.5);
      top += LYRIC_HEIGHT + 4;
    }

    // Layer blocks, one row each, showing the time range the engine actually honours; under an
    // animated layer, a row per keyframe track.
    const rows = timelineRows(document);
    const fits = Math.max(0, Math.floor((rect.height - top) / ROW_HEIGHT));
    for (const [row, entry] of rows.entries()) {
      const rowTop = top + row * ROW_HEIGHT;
      if (row >= fits) break;
      if (row === fits - 1 && rows.length > fits) {
        // Say that rows are missing, rather than silently drawing fewer layers than exist.
        ctx.fillStyle = dim;
        ctx.font = '11px "Segoe UI", system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        ctx.fillText(`+${rows.length - fits + 1} more rows — select layers in the layer list`, PADDING + 6, rowTop + (ROW_HEIGHT - 4) / 2);
        break;
      }
      if (entry.kind === 'track') {
        drawTrack(ctx, entry.track, rowTop, { x, dim, control, accent, line, width: rect.width, selection: keySelection });
        continue;
      }
      const layer = entry.layer;
      const from = ticksToSeconds(layer.timeRange.inTicks);
      const to = layer.timeRange.outTicks === null ? duration : ticksToSeconds(layer.timeRange.outTicks);
      const left = Math.max(PADDING, x(from));
      const right = Math.min(rect.width - PADDING, x(Math.min(duration, to)));
      if (right < left) continue;
      const selected = layer.id === selectedLayerId;
      ctx.fillStyle = selected ? raised : line;
      ctx.globalAlpha = layer.enabled ? 1 : 0.35;
      ctx.fillRect(left, rowTop, Math.max(2, right - left), ROW_HEIGHT - 4);
      if (selected) {
        // Selection is an outline in the accent, not a filled bar of it.
        ctx.strokeStyle = accent;
        ctx.strokeRect(left + 0.5, rowTop + 0.5, Math.max(2, right - left) - 1, ROW_HEIGHT - 5);
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = selected ? text : dim;
      ctx.font = '11px "Segoe UI", system-ui, sans-serif';
      // Centred in the block. The old baseline sat 9 px down a 14 px block, so the capitals
      // touched its top edge.
      ctx.textBaseline = 'middle';
      const label = layer.name !== '' ? layer.name : layer.kind === 'group' ? 'group' : layer.module;
      ctx.fillText(label, left + 6, rowTop + (ROW_HEIGHT - 4) / 2 + 0.5, Math.max(10, right - left - 12));
    }
    ctx.textBaseline = 'alphabetic';

    // Zoomed in: say where in the track this is.
    if (view.span < duration - 1e-6) {
      ctx.fillStyle = dim;
      ctx.font = '10px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(`${formatClock(view.start)} – ${formatClock(view.start + view.span)} · F fits`, rect.width - PADDING - 2, 10);
      ctx.textAlign = 'left';
    }

    // Each marker's line through every lane, faint, so a block or a key can be lined up by eye.
    for (const marker of document.markers) {
      const mx = x(ticksToSeconds(marker.ticks));
      if (mx < PADDING || mx > rect.width - PADDING) continue;
      ctx.strokeStyle = marker.color ?? accent;
      ctx.globalAlpha = markerSelection === marker.id ? 0.7 : 0.35;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(mx + 0.5, 0);
      ctx.lineTo(mx + 0.5, MARKER_TOP);
      ctx.moveTo(mx + 0.5, MARKER_TOP + MARKER_HEIGHT);
      ctx.lineTo(mx + 0.5, rect.height);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    // Playhead last, so it is never hidden behind a block.
    const px = x(timelineSeconds);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, rect.height);
    ctx.stroke();
    ctx.lineWidth = 1;
  }, [document, peaks, analysis, sections, theme, timelineSeconds, selectedLayerId, duration, leadIn, placement, clipStart, clipEnd, view, hasLyricsLane, vocal, lyricsSelection, keySelection, markerSelection]);

  useEffect(() => {
    draw();
  }, [draw]);

  useEffect(() => {
    const onResize = () => draw();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [draw]);

  // Wheel: zoom around the pointer; Shift pans. Not a React handler — React's wheel listener is
  // passive, and a zooming wheel must not also scroll the page.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const g = geometry();
      if (g === null) return;
      const rect = canvas.getBoundingClientRect();
      if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        const delta = (event.shiftKey ? event.deltaY : event.deltaX) / Math.max(1, rect.width) * g.view.span;
        setView((v) => panBy(v, delta, duration));
      } else {
        const anchor = secondsAt(g, event.clientX - rect.left);
        setView((v) => zoomAt(v, anchor, Math.exp(event.deltaY * 0.002), duration));
      }
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [geometry, duration]);

  // F fits the whole track (ui-spec §9).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
      if (typing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      const key = event.key.toLowerCase();
      if (key === 'f') setView(fitView(duration));
      else if (key === 'm') {
        // M adds a marker at the playhead (ui-spec §9), selected so it can be named at once.
        event.preventDefault();
        const state = useStudio.getState();
        const id = newId();
        state.run(addMarker(Math.round(state.timelineSeconds * TICKS_PER_SECOND), { id }));
        state.setMarkerSelection(id);
      } else if (key === '[' || key === ']') {
        event.preventDefault();
        jumpToStop(key === ']' ? 1 : -1);
      }
    };
    const onDelete = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
      if (typing || event.key !== 'Delete') return;
      const state = useStudio.getState();
      if (state.keySelection.length === 0 && state.markerSelection !== null) {
        event.preventDefault();
        state.run(removeMarkers([state.markerSelection]));
        state.setMarkerSelection(null);
        return;
      }
      if (state.keySelection.length === 0) return;
      event.preventDefault();
      state.run(removeKeyframes(state.keySelection));
      state.setKeySelection([]);
    };
    window.addEventListener('keydown', onDelete);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keydown', onDelete);
    };
  }, [duration]);

  const drag = useRef<DragState | null>(null);
  const markerDrag = useRef<{ readonly id: string; readonly startTicks: number; readonly originX: number; readonly mergeKey: string; moved: boolean } | null>(null);
  const keyDrag = useRef<KeyDragState | null>(null);
  const scrubbing = useRef(false);
  const [cursor, setCursor] = useState('pointer');

  function laneAt(y: number): 'wave' | 'markers' | 'lyrics' | 'layers' {
    if (y < MARKER_TOP) return 'wave';
    if (y <= MARKER_TOP + MARKER_HEIGHT + 1) return 'markers';
    if (hasLyricsLane && y <= LANES_TOP + LYRIC_HEIGHT + 2) return 'lyrics';
    return 'layers';
  }

  const flagAt = (px: number) => {
    // The last drawn wins, as it is on top.
    for (let i = flagHits.current.length - 1; i >= 0; i -= 1) {
      const hit = flagHits.current[i] as { id: string; left: number; right: number };
      if (px >= hit.left && px <= hit.right) return hit.id;
    }
    return null;
  };

  function onPointerDown(event: React.PointerEvent<HTMLCanvasElement>): void {
    const canvas = canvasRef.current;
    const g = geometry();
    if (canvas === null || g === null) return;
    const rect = canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const seconds = Math.min(duration, Math.max(0, secondsAt(g, px)));
    const lane = laneAt(y);

    if (lane === 'wave') {
      capture(canvas, event.pointerId);
      scrubbing.current = true;
      previewControls.seek(seconds);
      return;
    }
    if (lane === 'markers') {
      if (event.button !== 0) return;
      const id = flagAt(px);
      setEditing(null);
      if (id === null) {
        setMarkerSelection(null);
        previewControls.seek(seconds);
        return;
      }
      const marker = document.markers.find((m) => m.id === id);
      if (marker === undefined) return;
      setMarkerSelection(id);
      capture(canvas, event.pointerId);
      dragCount += 1;
      markerDrag.current = { id, startTicks: marker.ticks, originX: px, mergeKey: `marker-drag:${dragCount}`, moved: false };
      return;
    }
    if (lane === 'lyrics') {
      const hit = hitLyric(document.lyrics, g, px, lyricsSelection);
      if (hit === null) {
        setLyricsSelection([]);
        previewControls.seek(seconds);
        return;
      }
      let selection = lyricsSelection;
      if (event.shiftKey || event.ctrlKey || event.metaKey) {
        selection = lyricsSelection.includes(hit.line.id) ? lyricsSelection.filter((id) => id !== hit.line.id) : [...lyricsSelection, hit.line.id];
        setLyricsSelection(selection);
        return;
      }
      if (!lyricsSelection.includes(hit.line.id)) {
        selection = [hit.line.id];
        setLyricsSelection(selection);
      }
      capture(canvas, event.pointerId);
      dragCount += 1;
      drag.current = {
        drag: {
          kind: hit.kind,
          lineId: hit.line.id,
          lineIds: hit.kind === 'move' ? selection : [hit.line.id],
          wordIndex: hit.kind === 'word' ? hit.wordIndex : 0,
          ripple: event.altKey,
        },
        start: history.current.lyrics,
        originX: px,
        mergeKey: `lyric-drag:${dragCount}`,
        moved: false,
      };
      return;
    }
    // Below the lanes, the click picks a layer row — or, on a keyframe row, a key.
    const rowsTop = LANES_TOP + (hasLyricsLane ? LYRIC_HEIGHT + 4 : 0);
    const index = Math.floor((y - rowsTop) / ROW_HEIGHT);
    const entry = timelineRows(document)[index];
    if (entry === undefined) return;
    if (entry.kind === 'layer') {
      select(entry.layer.id);
      return;
    }
    if (entry.layer !== null) select(entry.layer.id);
    const hit = entry.track.keyframes.find((k) => Math.abs(xOf(g, ticksToSeconds(k.ticks)) - px) <= KEY_HIT_PX);
    if (hit === undefined) {
      setKeySelection([]);
      previewControls.seek(seconds);
      return;
    }
    let selection = keySelection;
    if (event.shiftKey) {
      selection = keySelection.includes(hit.id) ? keySelection.filter((id) => id !== hit.id) : [...keySelection, hit.id];
      setKeySelection(selection);
      return;
    }
    if (!keySelection.includes(hit.id)) {
      selection = [hit.id];
      setKeySelection(selection);
    }
    capture(canvas, event.pointerId);
    dragCount += 1;
    keyDrag.current = { ids: selection, anchorTicks: hit.ticks, start: history.current, originX: px, copy: event.altKey, mergeKey: `key-drag:${dragCount}`, moved: false, copyIds: selection.map(() => newId()) };
  }

  function onPointerMove(event: React.PointerEvent<HTMLCanvasElement>): void {
    const canvas = canvasRef.current;
    const g = geometry();
    if (canvas === null || g === null) return;
    const rect = canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    if (scrubbing.current) {
      previewControls.seek(Math.min(duration, Math.max(0, secondsAt(g, px))));
      return;
    }
    const flag = markerDrag.current;
    if (flag !== null) {
      if (!flag.moved && Math.abs(px - flag.originX) < 3) return;
      flag.moved = true;
      const pxPerTick = (g.width - PADDING * 2) / (g.view.span * TICKS_PER_SECOND);
      let ticks = Math.max(0, flag.startTicks + Math.round((px - flag.originX) / pxPerTick));
      if (!event.shiftKey) ticks = nearestTarget(ticks, snapTargetsFor(new Set([flag.id])), SNAP_PX / pxPerTick) ?? ticks;
      run(moveMarker(flag.id, ticks, flag.mergeKey), { seal: false });
      return;
    }
    const keys = keyDrag.current;
    if (keys !== null) {
      if (!keys.moved && Math.abs(px - keys.originX) < 3) return;
      keys.moved = true;
      const pxPerTick = (g.width - PADDING * 2) / (g.view.span * TICKS_PER_SECOND);
      let delta = Math.round((px - keys.originX) / pxPerTick);
      if (!event.shiftKey) {
        const best = nearestTarget(keys.anchorTicks + delta, snapTargetsFor(), SNAP_PX / pxPerTick);
        if (best !== null) delta = best - keys.anchorTicks;
      }
      const from = keys.start;
      const ids = keys.ids;
      const copyIds = keys.copyIds;
      const applyFrom = (): ProjectDocument => {
        if (!keys.copy) return moveKeyframes(ids, delta).apply(from);
        // Alt: copies at the new time, the originals stay.
        let next = from;
        ids.forEach((id, i) => {
          for (const track of from.automation) {
            const k = track.keyframes.find((key) => key.id === id);
            if (k !== undefined) {
              const fixedId = copyIds[i] as string;
              next = setKeyframe(track.target, Math.max(0, k.ticks + delta), k.value, { newId: () => fixedId, easing: k.easing }).apply(next);
            }
          }
        });
        return next;
      };
      run({ label: keys.copy ? 'Copy keyframes' : ids.length === 1 ? 'Move keyframe' : 'Move keyframes', mergeKey: keys.mergeKey, apply: (d) => ({ ...d, automation: applyFrom().automation }) }, { seal: false });
      return;
    }
    const current = drag.current;
    if (current !== null) {
      if (!current.moved && Math.abs(px - current.originX) < 3) return;
      current.moved = true;
      const pxPerTick = (g.width - PADDING * 2) / (g.view.span * TICKS_PER_SECOND);
      let delta = Math.round((px - current.originX) / pxPerTick);
      const edge = dragEdgeTicks(current.start, current.drag);
      if (!event.shiftKey && edge !== null) {
        const extra = [
          ...(lyricSnap.onsets ? onsetTicks : []),
          ...(lyricSnap.beats ? beatTicks : []),
          ...sectionTicks,
          ...markerTicks(document),
          Math.round(timelineSeconds * TICKS_PER_SECOND),
        ];
        delta = snapDelta(edge, delta, snapTargets(current.start, current.drag, extra), SNAP_PX / pxPerTick);
      }
      const changes = planLyricDrag(current.start, current.drag, delta);
      const label = current.drag.kind === 'move' ? (current.drag.ripple ? 'Ripple lines' : 'Move line') : current.drag.kind === 'word' ? 'Move word boundary' : 'Resize line';
      if (changes.length > 0) run(setLineTimings(changes, label, current.mergeKey), { seal: false });
      return;
    }
    // Hover: say what a press would grab.
    const hoverLane = laneAt(event.clientY - rect.top);
    if (hoverLane === 'lyrics') {
      const hit = hitLyric(document.lyrics, g, px, lyricsSelection);
      setCursor(hit === null ? 'pointer' : hit.kind === 'move' ? 'grab' : 'ew-resize');
    } else if (hoverLane === 'markers') {
      setCursor(flagAt(px) === null ? 'copy' : 'grab');
    } else {
      setCursor('pointer');
    }
  }

  function onPointerUp(event: React.PointerEvent<HTMLCanvasElement>): void {
    if (canvasRef.current?.hasPointerCapture(event.pointerId) === true) canvasRef.current.releasePointerCapture(event.pointerId);
    scrubbing.current = false;
    const flag = markerDrag.current;
    if (flag !== null) {
      markerDrag.current = null;
      // A click without a drag jumps to the marker.
      if (flag.moved) history.seal();
      else previewControls.seek(ticksToSeconds(flag.startTicks));
      return;
    }
    if (keyDrag.current !== null) {
      const keys = keyDrag.current;
      keyDrag.current = null;
      if (keys.moved) history.seal();
      else {
        const k = keys.start.automation.flatMap((t) => t.keyframes).find((key) => key.id === keys.ids[0]);
        if (k !== undefined) previewControls.seek(ticksToSeconds(k.ticks));
      }
      return;
    }
    const current = drag.current;
    drag.current = null;
    if (current === null) return;
    history.seal();
    // A click without a drag on a line puts the playhead at its start.
    if (!current.moved) {
      const line = document.lyrics.lines.find((l) => l.id === current.drag.lineId);
      if (line?.startTicks != null) previewControls.seek(ticksToSeconds(line.startTicks));
    }
  }

  function onDoubleClick(event: React.MouseEvent<HTMLCanvasElement>): void {
    const rect = canvasRef.current?.getBoundingClientRect();
    const g = geometry();
    if (rect === undefined || g === null) return;
    const lane = laneAt(event.clientY - rect.top);
    if (lane === 'markers') {
      // On a flag: edit it. On empty lane: a new marker there, snapped like a drag would be.
      const px = event.clientX - rect.left;
      const id = flagAt(px);
      if (id !== null) {
        setEditing({ id, left: px });
        return;
      }
      const pxPerTick = (g.width - PADDING * 2) / (g.view.span * TICKS_PER_SECOND);
      const wanted = Math.round(Math.min(duration, Math.max(0, secondsAt(g, px))) * TICKS_PER_SECOND);
      const ticks = event.shiftKey ? wanted : nearestTarget(wanted, snapTargetsFor(), SNAP_PX / pxPerTick) ?? wanted;
      const created = newId();
      run(addMarker(ticks, { id: created }));
      setMarkerSelection(created);
      setEditing({ id: created, left: px });
      return;
    }
    if (lane !== 'lyrics') return;
    setLyricsOpen(true, 'lines');
  }

  function onContextMenu(event: React.MouseEvent<HTMLCanvasElement>): void {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (rect === undefined || laneAt(event.clientY - rect.top) !== 'markers') return;
    const px = event.clientX - rect.left;
    const id = flagAt(px);
    if (id === null) return;
    event.preventDefault();
    setMarkerSelection(id);
    setEditing({ id, left: px });
  }

  const lanes = LANES_TOP + (hasLyricsLane ? LYRIC_HEIGHT + 4 : 0);
  const height = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, lanes + timelineRows(document).length * ROW_HEIGHT + 6));
  const editingMarker = editing === null ? undefined : document.markers.find((m) => m.id === editing.id);
  return (
    <div className="timeline-wrap">
      <canvas
        ref={canvasRef}
        className="timeline"
        data-testid="timeline"
        style={{ height, cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
      />
      {editing !== null && editingMarker !== undefined ? (
        <MarkerEditor marker={editingMarker} left={editing.left} onClose={() => setEditing(null)} />
      ) : null}
    </div>
  );
}

/**
 * The marker editor: its name (typing is one undo step per marker), a colour, and delete. Enter or
 * Escape closes it; so does a click elsewhere on the timeline.
 */
function MarkerEditor({ marker, left, onClose }: { marker: Marker; left: number; onClose: () => void }): React.JSX.Element {
  const run = useStudio((s) => s.run);
  const setMarkerSelection = useStudio((s) => s.setMarkerSelection);
  return (
    <div
      className="marker-editor"
      data-testid="marker-editor"
      style={{ left: Math.max(4, left - 8), top: MARKER_TOP + MARKER_HEIGHT + 2 }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <input
        autoFocus
        aria-label="Marker name"
        data-action="marker-name"
        value={marker.name}
        onChange={(event) => run(renameMarker(marker.id, event.target.value))}
        onBlur={() => history.seal()}
      />
      <div className="marker-swatches" role="group" aria-label="Marker colour">
        <button type="button" className={marker.color === null ? 'swatch selected' : 'swatch'} title="Accent" style={{ background: 'var(--accent)' }} onClick={() => run(setMarkerColor(marker.id, null))} />
        {MARKER_COLORS.map((c) => (
          <button key={c} type="button" className={marker.color === c ? 'swatch selected' : 'swatch'} title={c} aria-label={`Colour ${c}`} style={{ background: c }} onClick={() => run(setMarkerColor(marker.id, c))} />
        ))}
      </div>
      <button type="button" data-action="marker-delete" onClick={() => {
        run(removeMarkers([marker.id]));
        setMarkerSelection(null);
        onClose();
      }}>Delete</button>
    </div>
  );
}

/** Keeps a drag going outside the canvas. Refused for a pointer the browser does not know (a synthetic one). */
function capture(canvas: HTMLCanvasElement, pointerId: number): void {
  try {
    canvas.setPointerCapture(pointerId);
  } catch {
    // The drag still works inside the canvas.
  }
}

function formatClock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  return `${m}:${(seconds - m * 60).toFixed(1).padStart(4, '0')}`;
}

/**
 * Layers top-first — the order the layer list shows them in. Drawing them in composite order
 * (bottom first) put the timeline's rows upside down relative to the list beside it.
 */
function layerRows(document: ProjectDocument): Layer[] {
  return [...walkLayers(document.layers)].map(({ layer }) => layer).reverse();
}

type Row = { readonly kind: 'layer'; readonly layer: Layer } | { readonly kind: 'track'; readonly layer: Layer | null; readonly track: AutomationTrack };

/** Each layer, then a row per keyframe track on it; the whole frame's tracks after all the layers. */
function timelineRows(document: ProjectDocument): Row[] {
  const rows: Row[] = [];
  for (const layer of layerRows(document)) {
    rows.push({ kind: 'layer', layer });
    for (const track of document.automation) if (track.target.startsWith(`layers.${layer.id}.`)) rows.push({ kind: 'track', layer, track });
  }
  for (const track of document.automation) if (track.target.startsWith('global.')) rows.push({ kind: 'track', layer: null, track });
  return rows;
}

/** Keys within this many pixels of the pointer are hit. */
const KEY_HIT_PX = 6;

interface KeyDragState {
  readonly ids: readonly string[];
  /** The grabbed key's time: the one that snaps. */
  readonly anchorTicks: number;
  readonly start: ProjectDocument;
  readonly originX: number;
  readonly copy: boolean;
  readonly copyIds: readonly string[];
  readonly mergeKey: string;
  moved: boolean;
}

/** One keyframe row: the parameter's name, a line through its keys, the keys as diamonds. */
function drawTrack(
  ctx: CanvasRenderingContext2D,
  track: AutomationTrack,
  rowTop: number,
  s: { x: (seconds: number) => number; dim: string; control: string; accent: string; line: string; width: number; selection: readonly string[] },
): void {
  const mid = rowTop + (ROW_HEIGHT - 4) / 2;
  ctx.globalAlpha = track.enabled ? 1 : 0.35;
  const keys = track.keyframes;
  if (keys.length > 1) {
    ctx.strokeStyle = s.line;
    ctx.beginPath();
    ctx.moveTo(Math.max(PADDING, s.x(ticksToSeconds(keys[0]!.ticks))), mid + 0.5);
    ctx.lineTo(Math.min(s.width - PADDING, s.x(ticksToSeconds(keys[keys.length - 1]!.ticks))), mid + 0.5);
    ctx.stroke();
  }
  for (const k of keys) {
    const kx = s.x(ticksToSeconds(k.ticks));
    if (kx < PADDING - 6 || kx > s.width - PADDING + 6) continue;
    ctx.fillStyle = s.selection.includes(k.id) ? s.accent : s.control;
    ctx.beginPath();
    ctx.moveTo(kx, mid - 5);
    ctx.lineTo(kx + 5, mid);
    ctx.lineTo(kx, mid + 5);
    ctx.lineTo(kx - 5, mid);
    ctx.closePath();
    ctx.fill();
  }
  ctx.fillStyle = s.dim;
  ctx.font = '10px "Segoe UI", system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  const name = track.target.split('.').slice(-1)[0] ?? track.target;
  ctx.fillText(`◆ ${name}`, PADDING + 14, mid + 0.5);
  ctx.globalAlpha = 1;
}
