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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { peaksForRange } from '../../analysis/peaks.ts';
import { lyricTokens, wordSpans } from '../../engine/core/lyrics.ts';
import { sourceToTimelineSeconds, TICKS_PER_SECOND, ticksToSeconds } from '../../engine/core/time.ts';
import { onsetPeaks } from '../../lyrics/tap.ts';
import { detectVocalSegments } from '../../lyrics/vocal-segments.ts';
import { dragEdgeTicks, planLyricDrag, snapDelta, snapTargets, type LyricDrag } from '../../lyrics/timeline-edit.ts';
import { walkLayers, type Layer, type LyricLine, type Lyrics, type ProjectDocument } from '../../project/document.ts';
import { setLineTimings } from '../../project/lyrics-commands.ts';
import { timelineDurationTicks } from '../../project/snapshot.ts';
import { history, useStudio } from '../store.ts';
import { clampView, fitView, follow, panBy, zoomAt, type TimelineView } from '../timeline-view.ts';
import { previewControls } from './CanvasPane.tsx';

const ROW_HEIGHT = 18;
const WAVE_HEIGHT = 56;
const LYRIC_HEIGHT = 30;
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
  const timelineSeconds = useStudio((s) => s.timelineSeconds);
  const transport = useStudio((s) => s.transport);
  const selectedLayerId = useStudio((s) => s.selectedLayerId);
  const select = useStudio((s) => s.select);
  const lyricsSelection = useStudio((s) => s.lyricsSelection);
  const setLyricsSelection = useStudio((s) => s.setLyricsSelection);
  const setLyricsOpen = useStudio((s) => s.setLyricsOpen);
  const lyricSnap = useStudio((s) => s.lyricSnap);
  const run = useStudio((s) => s.run);

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
      ctx.fillStyle = index % 2 === 0 ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.06)';
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

    let top = WAVE_HEIGHT + 4;
    if (hasLyricsLane) {
      const laneTop = top;
      ctx.fillStyle = 'rgba(255,255,255,0.025)';
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

    // Layer blocks, one row each, showing the time range the engine actually honours.
    const rows = layerRows(document);
    const fits = Math.max(0, Math.floor((rect.height - top) / ROW_HEIGHT));
    for (const [row, layer] of rows.entries()) {
      const rowTop = top + row * ROW_HEIGHT;
      if (row >= fits) break;
      if (row === fits - 1 && rows.length > fits) {
        // Say that rows are missing, rather than silently drawing fewer layers than exist.
        ctx.fillStyle = dim;
        ctx.font = '11px "Segoe UI", system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        ctx.fillText(`+${rows.length - fits + 1} more layers — select them in the layer list`, PADDING + 6, rowTop + (ROW_HEIGHT - 4) / 2);
        break;
      }
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

    // Playhead last, so it is never hidden behind a block.
    const px = x(timelineSeconds);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, rect.height);
    ctx.stroke();
    ctx.lineWidth = 1;
  }, [document, peaks, analysis, sections, timelineSeconds, selectedLayerId, duration, leadIn, placement, clipStart, clipEnd, view, hasLyricsLane, vocal, lyricsSelection]);

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
      if (event.key.toLowerCase() === 'f') setView(fitView(duration));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [duration]);

  const drag = useRef<DragState | null>(null);
  const scrubbing = useRef(false);
  const [cursor, setCursor] = useState('pointer');

  function laneAt(y: number): 'wave' | 'lyrics' | 'layers' {
    if (y <= WAVE_HEIGHT + 2) return 'wave';
    if (hasLyricsLane && y <= WAVE_HEIGHT + 4 + LYRIC_HEIGHT + 2) return 'lyrics';
    return 'layers';
  }

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
    // Below the lanes, the click picks a layer row.
    const rowsTop = WAVE_HEIGHT + 4 + (hasLyricsLane ? LYRIC_HEIGHT + 4 : 0);
    const index = Math.floor((y - rowsTop) / ROW_HEIGHT);
    const layer = layerRows(document)[index];
    if (layer !== undefined) select(layer.id);
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
          ...(lyricSnap.beats ? (analysis?.beatGrid?.beats ?? []).map((b) => Math.round(sourceToTimelineSeconds(b, placement) * TICKS_PER_SECOND)) : []),
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
    if (laneAt(event.clientY - rect.top) === 'lyrics') {
      const hit = hitLyric(document.lyrics, g, px, lyricsSelection);
      setCursor(hit === null ? 'pointer' : hit.kind === 'move' ? 'grab' : 'ew-resize');
    } else {
      setCursor('pointer');
    }
  }

  function onPointerUp(event: React.PointerEvent<HTMLCanvasElement>): void {
    if (canvasRef.current?.hasPointerCapture(event.pointerId) === true) canvasRef.current.releasePointerCapture(event.pointerId);
    scrubbing.current = false;
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
    if (rect === undefined || laneAt(event.clientY - rect.top) !== 'lyrics') return;
    setLyricsOpen(true, 'lines');
  }

  const lanes = WAVE_HEIGHT + 4 + (hasLyricsLane ? LYRIC_HEIGHT + 4 : 0);
  const height = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, lanes + layerRows(document).length * ROW_HEIGHT + 6));
  return (
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
    />
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
