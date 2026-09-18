// The left rail (ui-spec §5): the audio panel and the layer list.

import { secondsToTicks } from '../../engine/core/time.ts';
import {
  addLayer, addPaletteColor, duplicateLayer, findLayer, groupLayers, moveLayer, removeLayer,
  removePaletteColor, setAudio, setLayerFlag, setPaletteColor, setPaletteRole, ungroupLayer,
} from '../../project/commands.ts';
import { PALETTE_ROLES } from '../../project/palette.ts';
import { createGroupLayer, createModuleLayer } from '../../project/create.ts';
import { walkLayers, type Layer } from '../../project/document.ts';
import { newId } from '../../project/ids.ts';
import { useStudio } from '../store.ts';
import { AssetsPanel } from './AssetsPanel.tsx';
import { PresetsPanel } from './PresetsPanel.tsx';
import { useModules } from '../modules.ts';

const LAYER_KINDS = ['source', 'text', 'visualizer', 'scene3d'] as const;

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

  const { all } = useModules();
  const VISUALIZERS = all.filter((m) => (LAYER_KINDS as readonly string[]).includes(m.manifest.kind));
  const grid = analysis?.beatGrid;
  const layers = [...walkLayers(document.layers)];

  async function importAudio(): Promise<void> {
    const path = await window.pulseforge.pickAudio();
    if (path === null) return;
    await loadAudio(path);
    const loaded = useStudio.getState().audio;
    // Only if this file actually loaded. After a failure the store still holds the previous
    // track, and recording the new path with the old track's length made a document whose
    // timeline and file disagree.
    if (loaded === null || loaded.path !== path) return;
    // Record the clip in the document so the timeline has a length and export knows the file.
    run(setAudio({
      path,
      durationTicks: secondsToTicks(loaded.durationSeconds),
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
      <PresetsPanel />

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

      <AssetsPanel />

      <h2>Add layer</h2>
      <div className="module-buttons">
        {VISUALIZERS.map((m) => (
          <button key={m.manifest.id} type="button" data-action="add-layer" onClick={() => addVisualizer(m.manifest.id)}>
            {m.manifest.name}
          </button>
        ))}
      </div>

      <ModulesPanel />

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
          {/* Groups composite their children into one image, so the group's transform, opacity,
              blend and effects apply to the result (M38). */}
          {findLayer(document, selectedLayerId)?.kind === 'group' ? (
            <button type="button" data-action="ungroup" onClick={() => run(ungroupLayer(selectedLayerId))}>Ungroup</button>
          ) : (
            <button
              type="button"
              data-action="group"
              onClick={() => {
                const group = createGroupLayer([], { id: newId(), name: 'Group' });
                run(groupLayers([selectedLayerId], group));
                select(group.id);
              }}
            >
              Group
            </button>
          )}
        </div>
      )}

      <PaletteEditor />
    </aside>
  );
}

/**
 * The palette (M17, compositor-spec §9). Colours on the left, role assignments on the right —
 * a role is an *index* into the colour list, so this is deliberately two lists and not a row of
 * seven pickers: two roles may point at the same colour, and changing that colour then moves
 * both, which is the entire point of the feature.
 */
function PaletteEditor(): React.JSX.Element {
  const palette = useStudio((s) => s.document.palette);
  const run = useStudio((s) => s.run);

  return (
    <>
      <h2>Palette</h2>
      {palette.colors.length === 0 ? (
        <p className="empty">No palette yet. Colours added here can be linked from any layer.</p>
      ) : (
        <ul className="swatches">
          {palette.colors.map((color, index) => (
            // Index as key: colours have no identity of their own, and the role table already
            // addresses them positionally.
            <li key={index}>
              <input
                type="color"
                value={color.slice(0, 7)}
                aria-label={`Palette colour ${index + 1}`}
                onChange={(e) => run(setPaletteColor(index, e.target.value))}
              />
              <button type="button" title="Remove" onClick={() => run(removePaletteColor(index))}>✕</button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="wide" data-action="add-palette-colour" onClick={() => run(addPaletteColor('#ff2d95'))}>
        Add colour
      </button>
      {palette.colors.length > 0 && PALETTE_ROLES.map((role) => (
        <label className="field" key={role}>
          <span>{role}</span>
          <select
            value={palette.roles[role] ?? ''}
            onChange={(e) => run(setPaletteRole(role, e.target.value === '' ? null : Number(e.target.value)))}
          >
            <option value="">unassigned</option>
            {palette.colors.map((color, index) => (
              <option key={index} value={index}>{index + 1} · {color}</option>
            ))}
          </select>
        </label>
      ))}
    </>
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

/**
 * The drop-in modules folder (M35): how many loaded, and every folder that did not, with the
 * reason — a module that fails is flagged here rather than silently missing from the list.
 */
function ModulesPanel(): React.JSX.Element {
  const userModules = useStudio((s) => s.userModules);
  const problems = useStudio((s) => s.moduleProblems);
  const loadModules = useStudio((s) => s.loadModules);
  return (
    <div className="modules-panel" data-testid="modules-panel">
      <div className="modules-bar">
        <span className="dim">
          {userModules.length === 0 ? 'No drop-in modules' : `${userModules.length} drop-in module${userModules.length === 1 ? '' : 's'}`}
        </span>
        <span className="spacer" />
        <button type="button" title="Read modules/ again" data-action="modules-reload" onClick={() => void loadModules()}>Reload</button>
        <button type="button" title="Open the modules folder" onClick={() => void window.pulseforge.revealModules()}>Folder</button>
      </div>
      {problems.map((problem) => (
        <p key={problem.folder} className="bad module-problem">
          <strong>modules/{problem.folder}</strong>: {problem.problems.join('; ')}
        </p>
      ))}
    </div>
  );
}
