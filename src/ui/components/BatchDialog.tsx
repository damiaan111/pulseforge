// Batch mode (PROJECT.md S13, export-spec §12): "drop 10 tracks in, auto-direct and render them all
// overnight". Each track becomes its own auto-directed project, saved in the output folder so it can
// be opened and changed later, and a render queued beside it. The work happens in the main process:
// the dialog closes at once and the render queue shows the batch as it goes.
//
// Tracks arrive from "Add tracks…" or from dropping audio files anywhere on the window (App.tsx).

import { useEffect, useState } from 'react';

import { MOTION_BLUR_DEFAULT } from '../../engine/core/time.ts';
import { EXPORT_PRESETS, findExportPreset } from '../../export/export-presets.ts';
import { useStudio } from '../store.ts';

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

export function BatchDialog(): React.JSX.Element | null {
  const open = useStudio((s) => s.batchOpen);
  const setOpen = useStudio((s) => s.setBatchOpen);
  const tracks = useStudio((s) => s.batchTracks);
  const setTracks = useStudio((s) => s.setBatchTracks);
  const templates = useStudio((s) => s.templates);
  const running = useStudio((s) => s.batch?.state === 'running');
  const setQueueOpen = useStudio((s) => s.setQueueOpen);
  const notify = useStudio((s) => s.notify);
  const preferred = useStudio((s) => s.settings?.defaultExportPreset ?? null);
  const opening = findExportPreset(preferred ?? '')?.id ?? 'youtube-1080p';

  const [outDir, setOutDir] = useState<string | null>(null);
  const [presetId, setPresetId] = useState(opening);
  const [templateId, setTemplateId] = useState<string>('');
  const [seed, setSeed] = useState(1);
  const [stems, setStems] = useState(false);
  const [refine, setRefine] = useState(false);
  const [motionBlur, setMotionBlur] = useState(false);
  const [karaoke, setKaraoke] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setPresetId(opening);
  }, [open, opening]);

  if (!open) return null;
  const preset = findExportPreset(presetId);

  async function addTracks(): Promise<void> {
    const picked = await window.pulseforge.pickBatchTracks();
    if (picked.length > 0) setTracks([...tracks, ...picked]);
  }

  async function chooseFolder(): Promise<void> {
    const picked = await window.pulseforge.pickFolder('Batch output folder: every project and video goes here');
    if (picked !== null) setOutDir(picked);
  }

  async function start(): Promise<void> {
    if (outDir === null || tracks.length === 0 || preset === undefined) return;
    setBusy(true);
    try {
      const status = await window.pulseforge.startBatch({
        tracks, outDir, presetId: preset.id, templateId: templateId === '' ? null : templateId, seed, stems: stems || karaoke, refineBeats: refine,
        motionBlur: motionBlur ? MOTION_BLUR_DEFAULT : null,
        audioMix: karaoke ? 'instrumental' : 'full',
      });
      useStudio.getState().setBatch(status);
      notify({ text: `Batch started: ${tracks.length} track${tracks.length === 1 ? '' : 's'}, ${preset.label}.`, kind: 'ok' });
      setTracks([]);
      setOpen(false);
      setQueueOpen(true);
    } catch (error) {
      notify({ text: `Could not start the batch. ${error instanceof Error ? error.message : String(error)}`, kind: 'bad' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => setOpen(false)}>
      <div className="modal batch-dialog" role="dialog" aria-label="Batch" onClick={(event) => event.stopPropagation()}>
        <h2>Batch: auto-direct and render</h2>
        <p className="dim-text">
          Each track becomes its own project, directed automatically, saved in the output folder so you
          can open and change it later, and rendered in the queue.
        </p>

        <div className="batch-tracks" data-testid="batch-tracks">
          {tracks.length === 0 ? (
            <p className="empty">No tracks yet. Add them, or drop audio files onto the window.</p>
          ) : (
            <ol>
              {tracks.map((track, index) => (
                <li key={`${track}#${index}`} title={track}>
                  <span className="batch-track-name">{fileName(track)}</span>
                  <button type="button" className="link" aria-label={`Remove ${fileName(track)}`} onClick={() => setTracks(tracks.filter((_, i) => i !== index))}>Remove</button>
                </li>
              ))}
            </ol>
          )}
          <div className="batch-track-actions">
            <button type="button" data-action="batch-add" onClick={() => void addTracks()}>Add tracks…</button>
            {tracks.length > 0 ? <button type="button" onClick={() => setTracks([])}>Clear</button> : null}
          </div>
        </div>

        <div className="batch-options">
          <label className="field">
            <span>Export</span>
            <select data-action="batch-preset" value={presetId} onChange={(e) => setPresetId(e.target.value)}>
              {EXPORT_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label} — {p.description}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Template</span>
            <select data-action="batch-template" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="">Best match for each track</option>
              {templates.map((t) => <option key={t.template.id} value={t.template.id}>{t.template.name}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Seed</span>
            <input type="number" step={1} value={seed} onChange={(e) => setSeed(Math.trunc(Number(e.target.value)) || 1)} title="The same seed gives the same looks for the same tracks" />
          </label>
          <label>
            <input type="checkbox" checked={stems || karaoke} disabled={karaoke} onChange={(e) => setStems(e.target.checked)} />
            {' '}Separate stems first <span className="dim-text">(about 20–40 s per track on the GPU; stem-driven looks read better)</span>
          </label>
          <label>
            <input type="checkbox" data-action="batch-refine-beats" checked={refine} onChange={(e) => setRefine(e.target.checked)} />
            {' '}Refine beats <span className="dim-text">(about 8 s per track; for music that speeds up and slows down)</span>
          </label>
          <label>
            <input type="checkbox" data-action="batch-karaoke" checked={karaoke} onChange={(e) => setKaraoke(e.target.checked)} />
            {' '}Karaoke <span className="dim-text">(the instrumental as the soundtrack — separates stems first)</span>
          </label>
          <label>
            <input type="checkbox" checked={motionBlur} onChange={(e) => setMotionBlur(e.target.checked)} />
            {' '}Motion blur <span className="dim-text">(8 samples, 180°: about 2–8× the render time)</span>
          </label>
        </div>

        <div className="output-row">
          <span className="output-path" title={outDir ?? ''}>{outDir ?? 'No output folder chosen'}</span>
          <button type="button" data-action="batch-folder" onClick={() => void chooseFolder()}>Choose folder…</button>
        </div>
        {running ? <p className="warn-text">A batch is still being directed; wait for it, or cancel it in the render queue.</p> : null}

        <div className="modal-actions">
          <button type="button" onClick={() => setOpen(false)}>Close</button>
          <button
            type="button"
            className="primary"
            data-action="batch-start"
            disabled={busy || running || tracks.length === 0 || outDir === null || preset === undefined}
            onClick={() => void start()}
          >
            {tracks.length === 0 ? 'Start batch' : `Start ${tracks.length} track${tracks.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}
