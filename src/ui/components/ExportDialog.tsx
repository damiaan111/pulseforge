// The export dialog (ui-spec §7): pick a preset and an output file, add the render to the queue.
//
// It queues rather than renders. The queue snapshots the document as it is at this moment
// (export-spec §12), so editing carries on while the render runs — and "a YouTube cut and a Short"
// is two clicks rather than a wait between them.

import { useEffect, useState } from 'react';

import { MOTION_BLUR_DEFAULT } from '../../engine/core/time.ts';
import { EXPORT_PRESETS, findExportPreset, presetCanvas, suggestedOutputName } from '../../export/export-presets.ts';
import { stringifyDocument } from '../../project/serialize.ts';
import { history, useStudio } from '../store.ts';

/** Subframes per frame; 8 at 180° is the film-like default (export-spec §9). */
const BLUR_SAMPLES = [4, 8, 16] as const;
const SHUTTER_ANGLES = [90, 180, 270, 360] as const;

export function ExportDialog(): React.JSX.Element | null {
  const open = useStudio((s) => s.exportOpen);
  const setOpen = useStudio((s) => s.setExportOpen);
  const setQueueOpen = useStudio((s) => s.setQueueOpen);
  const document = useStudio((s) => s.document);
  const path = useStudio((s) => s.path);
  const audio = useStudio((s) => s.audio);
  const notify = useStudio((s) => s.notify);
  // The preset the dialog opens on is a setting (M36); an unknown id falls back to the first.
  const preferred = useStudio((s) => s.settings?.defaultExportPreset ?? null);
  const opening = findExportPreset(preferred ?? '')?.id ?? EXPORT_PRESETS[0]?.id ?? '';
  const [presetId, setPresetId] = useState(opening);
  const [outputPath, setOutputPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Motion blur (S10, export-spec §9): off by default, since it multiplies the render time.
  const [blurOn, setBlurOn] = useState(false);
  const [samples, setSamples] = useState(MOTION_BLUR_DEFAULT.samples);
  const [shutter, setShutter] = useState(MOTION_BLUR_DEFAULT.shutterDegrees);
  // The dialog stays mounted while closed, so each opening starts from the setting again.
  useEffect(() => {
    if (open) setPresetId(opening);
  }, [open, opening]);

  if (!open) return null;
  const preset = findExportPreset(presetId);
  const canvas = preset === undefined ? null : presetCanvas(preset, document.canvas);
  const noAudio = document.audio.path === '' || audio === null;

  async function choose(): Promise<void> {
    if (preset === undefined) return;
    const picked = await window.pulseforge.pickRenderOutput(suggestedOutputName(document.name, preset));
    if (picked !== null) setOutputPath(picked);
  }

  async function enqueue(): Promise<void> {
    if (preset === undefined || outputPath === null) return;
    setBusy(true);
    try {
      await window.pulseforge.enqueueRender({
        text: stringifyDocument(history.current),
        projectPath: path,
        presetId: preset.id,
        outputPath,
        motionBlur: blurOn ? { samples, shutterDegrees: shutter } : null,
      });
      notify({ text: `Queued: ${document.name} — ${preset.label}`, kind: 'ok' });
      setOpen(false);
      setQueueOpen(true);
    } catch (error) {
      notify({ text: `Could not queue the render. ${error instanceof Error ? error.message : String(error)}`, kind: 'bad' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => setOpen(false)}>
      <div className="modal export-dialog" role="dialog" aria-label="Export video" onClick={(event) => event.stopPropagation()}>
        <h2>Export video</h2>

        <div className="preset-list">
          {EXPORT_PRESETS.map((entry) => (
            <label key={entry.id} className={entry.id === presetId ? 'preset selected' : 'preset'}>
              <input
                type="radio"
                name="preset"
                value={entry.id}
                data-action="export-preset"
                checked={entry.id === presetId}
                onChange={() => {
                  setPresetId(entry.id);
                  setOutputPath(null);
                }}
              />
              <span className="preset-label">{entry.label}</span>
              <span className="preset-description">{entry.description}</span>
            </label>
          ))}
        </div>

        {canvas === null ? null : (
          <p className="export-summary">
            {canvas.width}×{canvas.height} at {document.canvas.fps.num / document.canvas.fps.den} fps.
            {' '}Per-aspect overrides for this shape are applied.
          </p>
        )}

        <fieldset className="export-blur">
          <label>
            <input type="checkbox" data-action="export-motion-blur" checked={blurOn} onChange={(event) => setBlurOn(event.target.checked)} />
            {' '}Motion blur
          </label>
          <select aria-label="Motion-blur samples" data-action="export-blur-samples" disabled={!blurOn} value={samples} onChange={(event) => setSamples(Number(event.target.value))}>
            {BLUR_SAMPLES.map((n) => <option key={n} value={n}>{n} samples</option>)}
          </select>
          <select aria-label="Shutter angle" data-action="export-blur-shutter" disabled={!blurOn} value={shutter} onChange={(event) => setShutter(Number(event.target.value))}>
            {SHUTTER_ANGLES.map((deg) => <option key={deg} value={deg}>{deg}° shutter</option>)}
          </select>
          {blurOn ? <span className="dim-text">Each frame is rendered {samples} times: about {samples}× the render time.</span> : null}
        </fieldset>

        <div className="output-row">
          <span className="output-path" title={outputPath ?? ''}>{outputPath ?? 'No output file chosen'}</span>
          <button type="button" data-action="export-choose" onClick={() => void choose()}>Choose…</button>
        </div>

        {noAudio ? <p className="warn-text">The project has no audio. Import audio before rendering.</p> : null}
        <p className="dim-text">The project is snapshotted when queued; keep editing while it renders.</p>

        <div className="modal-actions">
          <button type="button" onClick={() => setOpen(false)}>Close</button>
          <button
            type="button"
            className="primary"
            data-action="export-enqueue"
            disabled={busy || noAudio || outputPath === null || preset === undefined}
            onClick={() => void enqueue()}
          >
            Add to queue
          </button>
        </div>
      </div>
    </div>
  );
}
