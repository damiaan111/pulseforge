// The left rail (ui-spec §5): the audio panel and the layer list.

import { BUILTIN_MODULES } from '../../engine/engine.ts';
import { secondsToTicks } from '../../engine/core/time.ts';
import {
  addLayer, duplicateLayer, moveLayer, removeLayer, setAudio, setLayerFlag,
} from '../../project/commands.ts';
import { createModuleLayer } from '../../project/create.ts';
import { walkLayers, type Layer } from '../../project/document.ts';
import { newId } from '../../project/ids.ts';
import { useStudio } from '../store.ts';

const VISUALIZERS = BUILTIN_MODULES.filter((m) => m.manifest.kind === 'visualizer' || m.manifest.kind === 'source');

export function LeftRail(): React.JSX.Element {
  const document = useStudio((s) => s.document);
  const audio = useStudio((s) => s.audio);
  const analysisState = useStudio((s) => s.analysisState);
  const analysisMessage = useStudio((s) => s.analysisMessage);
  const analysis = useStudio((s) => s.analysis);
  const sections = useStudio((s) => s.sections);
  const selectedLayerId = useStudio((s) => s.selectedLayerId);
  const select = useStudio((s) => s.select);
  const run = useStudio((s) => s.run);
  const loadAudio = useStudio((s) => s.loadAudio);

  const grid = analysis?.beatGrid;
  const layers = [...walkLayers(document.layers)];

  async function importAudio(): Promise<void> {
    const path = await window.pulseforge.pickAudio();
    if (path === null) return;
    await loadAudio(path);
    const state = useStudio.getState();
    // Record the clip in the document so the timeline has a length and export knows the file.
    run(setAudio({
      path,
      durationTicks: secondsToTicks(state.audio?.durationSeconds ?? 0),
      clipOutTicks: null,
    }));
  }

  function addVisualizer(moduleId: string): void {
    const layer = createModuleLayer(moduleId, { id: newId(), name: moduleId.split('.').pop() ?? 'Layer' });
    run(addLayer(layer));
    select(layer.id);
  }

  return (
    <aside className="left-rail">
      <h2>Audio</h2>
      <button type="button" className="wide" onClick={() => void importAudio()}>
        {audio === null ? 'Import audio…' : 'Replace audio…'}
      </button>
      {audio === null ? (
        <p className="empty">No audio yet. The preview runs, but nothing reacts.</p>
      ) : (
        <dl className="compact">
          <dt>File</dt><dd title={audio.path}>{audio.path.split(/[/\\]/).pop()}</dd>
          <dt>Length</dt><dd>{audio.durationSeconds.toFixed(2)} s</dd>
          <dt>Tempo</dt>
          <dd>
            {grid === undefined || grid.bpm <= 0
              ? 'not detected'
              : `${grid.bpm.toFixed(1)} bpm · ${(grid.confidence * 100).toFixed(0)}% sure`}
          </dd>
          <dt>Sections</dt><dd>{sections.length === 0 ? 'none' : String(sections.length)}</dd>
        </dl>
      )}
      {analysisMessage !== null && (
        <p className={analysisState === 'error' ? 'bad' : analysisState === 'working' ? 'dim' : 'ok'}>
          {analysisMessage}
        </p>
      )}

      <h2>Add layer</h2>
      <div className="module-buttons">
        {VISUALIZERS.map((m) => (
          <button key={m.manifest.id} type="button" data-action="add-layer" onClick={() => addVisualizer(m.manifest.id)}>
            {m.manifest.name}
          </button>
        ))}
      </div>

      <h2>Layers</h2>
      {layers.length === 0 ? (
        <p className="empty">No layers yet.</p>
      ) : (
        // Bottom-to-top is how they composite; showing them top-first matches every other tool.
        <ul className="layer-list">
          {[...layers].reverse().map(({ layer, parents }) => (
            <LayerRow
              key={layer.id}
              layer={layer}
              depth={parents.length}
              selected={layer.id === selectedLayerId}
              onSelect={() => select(layer.id)}
            />
          ))}
        </ul>
      )}
      {selectedLayerId !== null && (
        <div className="layer-actions">
          <button type="button" onClick={() => run(duplicateLayer(selectedLayerId, newId))}>Duplicate</button>
          <button type="button" onClick={() => { run(removeLayer(selectedLayerId)); select(null); }}>Delete</button>
          <button type="button" onClick={() => run(moveLayer(selectedLayerId, { index: Number.MAX_SAFE_INTEGER }))}>
            To top
          </button>
        </div>
      )}
    </aside>
  );
}

function LayerRow(props: {
  layer: Layer;
  depth: number;
  selected: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  const { layer, depth, selected, onSelect } = props;
  const run = useStudio((s) => s.run);
  return (
    <li className={`layer-row${selected ? ' selected' : ''}${layer.enabled ? '' : ' hidden'}`}>
      <button type="button" className="layer-name" style={{ paddingLeft: `${8 + depth * 12}px` }} onClick={onSelect}>
        <span className="name">{layer.name === '' ? '(unnamed)' : layer.name}</span>
        <span className="meta">{layer.kind === 'group' ? `group · ${layer.children.length}` : layer.module}</span>
      </button>
      <button
        type="button"
        className="eye"
        title={layer.enabled ? 'Hide' : 'Show'}
        onClick={() => run(setLayerFlag(layer.id, 'enabled', !layer.enabled))}
      >
        {layer.enabled ? '👁' : '—'}
      </button>
    </li>
  );
}
