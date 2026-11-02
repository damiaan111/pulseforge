// The performance HUD (PROJECT.md S12): GPU time per layer, "so heavy effects are visible *before*
// a 4K render".
//
// The preview measures each top-level layer, the whole-frame effects and the output pass with GPU
// timer queries (engine/render/gpu-profiler.ts) at the preview's own resolution. Most of that cost
// is per pixel, so the HUD also projects it to the project's full size and to 4K — an estimate,
// labelled as one — and to what the GPU alone would need for the whole timeline at 4K.

import { ticksToSeconds } from '../../engine/core/time.ts';
import { walkLayers } from '../../project/document.ts';
import { timelineDurationTicks } from '../../project/snapshot.ts';
import { previewRenderSize } from '../preview/render-size.ts';
import { useStudio } from '../store.ts';

/** The heaviest spans shown; the rest are summed in one line, so none is silently left out. */
const HUD_ROWS = 8;

const SPECIAL: Readonly<Record<string, string>> = {
  global: 'Whole-frame effects',
  output: 'Output (tone map, colour)',
};

function formatMs(ms: number): string {
  return ms >= 10 ? `${ms.toFixed(0)} ms` : ms >= 1 ? `${ms.toFixed(1)} ms` : `${ms.toFixed(2)} ms`;
}

function formatMinutes(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} s`;
  return `${Math.round(seconds / 60)} min`;
}

export function PerformanceHud(): React.JSX.Element | null {
  const open = useStudio((s) => s.hudOpen);
  const setOpen = useStudio((s) => s.setHudOpen);
  const timings = useStudio((s) => s.gpuTimings);
  const available = useStudio((s) => s.gpuAvailable);
  const document = useStudio((s) => s.document);
  const previewScale = useStudio((s) => s.previewScale);
  const draft = useStudio((s) => s.draft);
  if (!open) return null;

  const names = new Map([...walkLayers(document.layers)].map(({ layer }) => [layer.id, layer.name !== '' ? layer.name : layer.kind === 'group' ? 'group' : layer.module]));
  const spans = timings === null ? [] : [...timings.spans].sort((a, b) => b[1] - a[1]);
  const worst = spans[0]?.[1] ?? 0;
  const { width, height } = document.canvas;
  const rendered = previewRenderSize(document.canvas, previewScale, draft);
  const previewPixels = rendered.width * rendered.height;
  const scaleTo = (w: number, h: number) => (w * h) / Math.max(1, previewPixels);
  const total = timings?.totalMs ?? 0;
  const fps = document.canvas.fps.num / document.canvas.fps.den;
  const frames = Math.ceil(ticksToSeconds(timelineDurationTicks(document)) * fps);
  const at4k = total * scaleTo(3840, 2160);

  return (
    <div className="perf-hud" data-testid="perf-hud" role="region" aria-label="Performance HUD">
      <div className="perf-hud-head">
        <span>GPU per frame</span>
        <button type="button" className="link" aria-label="Close the performance HUD" onClick={() => setOpen(false)}>×</button>
      </div>
      {available === false ? (
        <p className="perf-hud-note">This GPU or driver does not expose timer queries, so nothing can be measured here.</p>
      ) : timings === null ? (
        <p className="perf-hud-note">Measuring… (play, or move the playhead)</p>
      ) : (
        <>
          <table>
            <tbody>
              {spans.slice(0, HUD_ROWS).map(([key, ms]) => (
                <tr key={key} data-span={key}>
                  <td className="perf-hud-name" title={key}>{SPECIAL[key] ?? names.get(key) ?? key}</td>
                  <td className="perf-hud-bar"><span style={{ width: `${worst > 0 ? Math.max(2, (ms / worst) * 100) : 0}%` }} /></td>
                  <td className="perf-hud-ms">{formatMs(ms)}</td>
                </tr>
              ))}
              {spans.length > HUD_ROWS ? (
                <tr className="perf-hud-more">
                  <td colSpan={3}>+{spans.length - HUD_ROWS} more, {formatMs(spans.slice(HUD_ROWS).reduce((sum, [, ms]) => sum + ms, 0))} together</td>
                </tr>
              ) : null}
            </tbody>
          </table>
          <div className="perf-hud-total">
            {formatMs(total)} at the preview's {rendered.width}×{rendered.height}{draft ? ' (draft)' : ''}
          </div>
          <div className="perf-hud-estimate" title="Estimates: most GPU work grows with the pixel count. Rendering is offline, so export never drops frames — this is how long it takes.">
            ≈ {formatMs(total * scaleTo(width, height))} at {width}×{height}
            {width * height < 3840 * 2160 ? <> · ≈ {formatMs(at4k)} at 3840×2160</> : null}
            {frames > 0 ? <><br />A 4K render: the GPU alone ≈ {formatMinutes((at4k * frames) / 1000)} for {frames} frames</> : null}
            {draft ? <><br />Measured in draft: a render uses full effects and costs more — turn Draft off for render estimates.</> : null}
          </div>
        </>
      )}
    </div>
  );
}
