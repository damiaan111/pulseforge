// The timeline (ui-spec §3): waveform, beat grid, sections, layer blocks and the playhead.
//
// Canvas-drawn, not DOM. A DOM timeline dies at thousands of beat ticks and waveform samples,
// and this one draws a peak pyramid built for exactly this purpose — `peaksForRange` picks the
// mip level for the visible span, so zooming out costs no more than zooming in.

import { useCallback, useEffect, useRef } from 'react';

import { peaksForRange } from '../../analysis/peaks.ts';
import { ticksToSeconds } from '../../engine/core/time.ts';
import { walkLayers, type Layer, type ProjectDocument } from '../../project/document.ts';
import { timelineDurationTicks } from '../../project/snapshot.ts';
import { useStudio } from '../store.ts';
import { previewControls } from './CanvasPane.tsx';

const ROW_HEIGHT = 18;
const WAVE_HEIGHT = 56;
const PADDING = 8;
/** The timeline grows with the layer count up to a cap, so the canvas keeps most of the window. */
const MIN_HEIGHT = 132;
const MAX_HEIGHT = 240;

export function Timeline(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const document = useStudio((s) => s.document);
  const peaks = useStudio((s) => s.peaks);
  const analysis = useStudio((s) => s.analysis);
  const sections = useStudio((s) => s.sections);
  const timelineSeconds = useStudio((s) => s.timelineSeconds);
  const selectedLayerId = useStudio((s) => s.selectedLayerId);
  const select = useStudio((s) => s.select);

  const duration = Math.max(0.001, ticksToSeconds(timelineDurationTicks(document)));
  const leadIn = ticksToSeconds(document.audio.leadInTicks);

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
    const accent = colour('--accent', '#8ea4d2');
    const control = colour('--control', '#8b8b98');
    const raised = colour('--panel-raised', '#1e1e25');

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    const x = (seconds: number) => PADDING + (seconds / duration) * (rect.width - PADDING * 2);

    // Sections first, as backdrop bands.
    for (const [index, section] of sections.entries()) {
      ctx.fillStyle = index % 2 === 0 ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.06)';
      const left = x(section.startSeconds + leadIn);
      ctx.fillRect(left, 0, x(section.endSeconds + leadIn) - left, rect.height);
    }

    // Beat grid. Downbeats emphasised; skipped entirely when they would be closer than 3 px,
    // because a solid grey wash tells you nothing.
    const grid = analysis?.beatGrid;
    if (grid !== undefined && grid.beats.length > 1) {
      const spacing = x(grid.beats[1] as number) - x(grid.beats[0] as number);
      if (spacing > 3) {
        for (const [index, beat] of grid.beats.entries()) {
          const bx = x(beat + leadIn);
          if (bx < 0 || bx > rect.width) continue;
          ctx.strokeStyle = index % 4 === 0 ? dim : line;
          ctx.beginPath();
          ctx.moveTo(bx, 0);
          ctx.lineTo(bx, WAVE_HEIGHT);
          ctx.stroke();
        }
      }
    }

    // Waveform from the peak pyramid.
    if (peaks !== null) {
      const columns = Math.max(1, Math.floor(rect.width - PADDING * 2));
      const audioSeconds = peaks.sampleCount / peaks.sampleRate;
      const window = peaksForRange(peaks, 0, audioSeconds, columns);
      const mid = WAVE_HEIGHT / 2;
      // Neutral: the waveform is information, and a coloured one competes with the canvas (ui-spec §12).
      ctx.fillStyle = control;
      ctx.globalAlpha = 0.75;
      for (let i = 0; i < window.min.length; i += 1) {
        const px = PADDING + (i / window.min.length) * (rect.width - PADDING * 2) + x(leadIn) - PADDING;
        const top = mid - (window.max[i] ?? 0) * mid;
        const bottom = mid - (window.min[i] ?? 0) * mid;
        ctx.fillRect(px, top, 1, Math.max(1, bottom - top));
      }
      ctx.globalAlpha = 1;
    } else {
      ctx.strokeStyle = line;
      ctx.beginPath();
      ctx.moveTo(PADDING, WAVE_HEIGHT / 2);
      ctx.lineTo(rect.width - PADDING, WAVE_HEIGHT / 2);
      ctx.stroke();
    }

    // Layer blocks, one row each, showing the time range the engine actually honours.
    const rows = layerRows(document);
    const fits = Math.max(0, Math.floor((rect.height - WAVE_HEIGHT - 4) / ROW_HEIGHT));
    for (const [row, layer] of rows.entries()) {
      const top = WAVE_HEIGHT + 4 + row * ROW_HEIGHT;
      if (row >= fits) break;
      if (row === fits - 1 && rows.length > fits) {
        // Say that rows are missing, rather than silently drawing fewer layers than exist.
        ctx.fillStyle = dim;
        ctx.font = '11px "Segoe UI", system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        ctx.fillText(`+${rows.length - fits + 1} more layers — select them in the layer list`, PADDING + 6, top + (ROW_HEIGHT - 4) / 2);
        break;
      }
      const from = ticksToSeconds(layer.timeRange.inTicks);
      const to = layer.timeRange.outTicks === null ? duration : ticksToSeconds(layer.timeRange.outTicks);
      const left = x(from);
      const right = x(Math.min(duration, to));
      const selected = layer.id === selectedLayerId;
      ctx.fillStyle = selected ? raised : line;
      ctx.globalAlpha = layer.enabled ? 1 : 0.35;
      ctx.fillRect(left, top, Math.max(2, right - left), ROW_HEIGHT - 4);
      if (selected) {
        // Selection is an outline in the accent, not a filled bar of it.
        ctx.strokeStyle = accent;
        ctx.strokeRect(left + 0.5, top + 0.5, Math.max(2, right - left) - 1, ROW_HEIGHT - 5);
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = selected ? colour('--text', '#e6e6ea') : dim;
      ctx.font = '11px "Segoe UI", system-ui, sans-serif';
      // Centred in the block. The old baseline sat 9 px down a 14 px block, so the capitals
      // touched its top edge.
      ctx.textBaseline = 'middle';
      const label = layer.name !== '' ? layer.name : layer.kind === 'group' ? 'group' : layer.module;
      ctx.fillText(label, left + 6, top + (ROW_HEIGHT - 4) / 2 + 0.5, Math.max(10, right - left - 12));
    }
    ctx.textBaseline = 'alphabetic';

    // Playhead last, so it is never hidden behind a block.
    const px = x(timelineSeconds);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, rect.height);
    ctx.stroke();
    ctx.lineWidth = 1;
  }, [document, peaks, analysis, sections, timelineSeconds, selectedLayerId, duration, leadIn]);

  useEffect(() => {
    draw();
  }, [draw]);

  useEffect(() => {
    const onResize = () => draw();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [draw]);

  function onPointerDown(event: React.PointerEvent<HTMLCanvasElement>): void {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const rect = canvas.getBoundingClientRect();
    const fraction = (event.clientX - rect.left - PADDING) / Math.max(1, rect.width - PADDING * 2);
    const seconds = Math.min(duration, Math.max(0, fraction * duration));

    // Below the waveform, the click picks a layer row instead of scrubbing.
    const y = event.clientY - rect.top;
    if (y > WAVE_HEIGHT + 4) {
      const index = Math.floor((y - WAVE_HEIGHT - 4) / ROW_HEIGHT);
      const hit = layerRows(document)[index];
      if (hit !== undefined) select(hit.id);
      return;
    }
    previewControls.seek(seconds);
  }

  const height = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, WAVE_HEIGHT + 4 + layerRows(document).length * ROW_HEIGHT + 6));
  return <canvas ref={canvasRef} className="timeline" style={{ height }} onPointerDown={onPointerDown} />;
}

/**
 * Layers top-first — the order the layer list shows them in. Drawing them in composite order
 * (bottom first) put the timeline's rows upside down relative to the list beside it.
 */
function layerRows(document: ProjectDocument): Layer[] {
  return [...walkLayers(document.layers)].map(({ layer }) => layer).reverse();
}
