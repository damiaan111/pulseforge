// Stems for the loaded track (M5, ui-spec §5 "Audio": stem status with progress, re-run controls).
//
// One button to separate, a progress bar with the stage while it runs (it can take a minute or two
// on a long track the first time), cancel, and afterwards which stems exist. Once separated, the
// stems are in the analysis cache: bindings and visualizers set to a stem react to it at once, and
// opening the project again finds them without separating again.

import { useStudio } from '../store.ts';

const STAGE_TEXT: Readonly<Record<string, string>> = {
  queued: 'Waiting for the GPU…',
  decoding: 'Decoding…',
  separating: 'Separating…',
  analysing: 'Analysing',
};

export function StemsControls(): React.JSX.Element | null {
  const audio = useStudio((s) => s.audio);
  const stems = useStudio((s) => s.stems);
  const separate = useStudio((s) => s.separateStems);
  const cancel = useStudio((s) => s.cancelStems);
  if (audio === null) return null;

  return (
    <div className="stems-controls" data-testid="stems-controls" data-state={stems.state}>
      <h3>Stems</h3>
      {stems.state === 'running' ? (
        <>
          <div className="progress"><div className="progress-fill" style={{ width: `${(stems.fraction * 100).toFixed(1)}%` }} /></div>
          <div className="stems-line">
            <span className="dim">
              {STAGE_TEXT[stems.stage ?? 'queued'] ?? stems.stage}{stems.stage === 'analysing' && stems.detail !== null ? ` ${stems.detail}…` : ''}
              {' '}{(stems.fraction * 100).toFixed(0)}%
            </span>
            <button type="button" data-action="stems-cancel" onClick={() => void cancel()}>Cancel</button>
          </div>
        </>
      ) : stems.state === 'ready' ? (
        <p className="ok stems-line">
          {stems.ready.join(' · ')}
          <span className="dim"> — set a layer's Source or a modulation's stem to use one</span>
        </p>
      ) : (
        <>
          {stems.message !== null && <p className={stems.state === 'failed' ? 'bad stems-line' : 'warn stems-line'}>{stems.message}</p>}
          <button
            type="button"
            className="wide"
            data-action="stems-separate"
            title="Split the track into drums, bass, vocals and other with Demucs, on the GPU, and analyse each"
            onClick={() => void separate()}
          >
            {stems.state === 'failed' ? 'Try separating again' : 'Separate stems'}
          </button>
          {stems.ready.length === 0 && (
            <p className="dim stems-line">Until then, every stem reads as “not analysed” and only the mix reacts.</p>
          )}
        </>
      )}
    </div>
  );
}
