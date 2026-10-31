// The left rail (ui-spec §5): the audio panel and the layer list.

import { pickLayer } from '../../project/layer-picker.ts';
import {
  addPaletteColor, duplicateLayer, findLayer, groupLayers, moveLayer, removeLayer,
  removePaletteColor, sequence, setLayerFlag, setPaletteColor, setPaletteRole, ungroupLayer,
} from '../../project/commands.ts';
import { PALETTE_ROLES } from '../../project/palette.ts';
import { createGroupLayer } from '../../project/create.ts';
import { type Layer } from '../../project/document.ts';
import { displayOrder, dropPosition, stepPosition } from '../../project/layer-order.ts';
import { newId } from '../../project/ids.ts';
import { useStudio } from '../store.ts';
import { AssetsPanel } from './AssetsPanel.tsx';
import { PresetsPanel } from './PresetsPanel.tsx';
import { BeatControls } from './BeatControls.tsx';
import { ClipControls } from './ClipControls.tsx';
import { StemsControls } from './StemsControls.tsx';
import { LyricsSection } from './LyricsPanel.tsx';
import { AutoOffer } from './AutoPanel.tsx';
import { useModules } from '../modules.ts';
import { adoptFile } from '../audio-import.ts';
import { isVideoFile } from '../../assets/media-types.ts';
import { CombineAudio } from './CombineAudio.tsx';
import { useState } from 'react';

/** The drag payload for reordering layers: a layer id, under a type nothing else uses. */
const DRAG_TYPE = 'application/x-pulseforge-layer';

const LAYER_KINDS = ['source', 'text', 'visualizer', 'scene3d'] as const;

export function LeftRail(): React.JSX.Element {
  const document = useStudio((s) => s.document);
  const audio = useStudio((s) => s.audio);
  const analysisState = useStudio((s) => s.analysisState);
  const analysisMessage = useStudio((s) => s.analysisMessage);
  const analysis = useStudio((s) => s.analysis);
  const sections = useStudio((s) => s.sections);
  const selectedLayerId = useStudio((s) => s.selectedLayerId);
  const selectedLayerIds = useStudio((s) => s.selectedLayerIds);
  const extendLayerSelection = useStudio((s) => s.extendLayerSelection);
  const select = useStudio((s) => s.select);
  const run = useStudio((s) => s.run);
  // A video was chosen as audio: its sound alone, or its picture too, is asked before anything runs.
  const [videoChoice, setVideoChoice] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);

  const { all, manifests } = useModules();
  const VISUALIZERS = all.filter((m) => (LAYER_KINDS as readonly string[]).includes(m.manifest.kind));
  const grid = analysis?.beatGrid;
  // Top first, each group's row above its children (layer-order.ts).
  const layers = displayOrder(document.layers);
  const selectedLayer = selectedLayerId === null ? undefined : findLayer(document, selectedLayerId);
  // Undo can bring back a document without them.
  const selectedIds = selectedLayerIds.filter((id) => findLayer(document, id) !== undefined);

  async function importAudio(): Promise<void> {
    const path = await window.pulseforge.pickAudio();
    if (path === null) return;
    if (isVideoFile(path)) setVideoChoice(path);
    else await prepare(path, false);
  }

  async function prepare(path: string, picture: boolean): Promise<void> {
    setVideoChoice(null);
    setPreparing(true);
    try {
      await adoptFile(path, picture);
    } finally {
      setPreparing(false);
    }
  }

  function pick(moduleId: string, stack: boolean): void {
    const result = pickLayer(document, selectedLayerId, moduleId, (id) => manifests.get(id)?.kind, stack, newId);
    run(result.command);
    select(result.select);
    if (result.note !== null) useStudio.getState().notify({ text: result.note, kind: 'warn' });
  }

  return (
    <aside className="left-rail">
      <PresetsPanel />

      <h2>Audio</h2>
      <button type="button" className="wide" data-action="import-audio" onClick={() => void importAudio()}>
        {audio === null ? 'Import audio…' : 'Replace audio…'}
      </button>
      {videoChoice !== null && (
        <div className="video-choice" data-testid="video-audio-choice">
          <p className="dim note">{videoChoice.split(/[/\\]/).pop()} is a video. Its sound becomes the project's audio. Use its picture as well, under everything else?</p>
          <div className="layer-actions">
            <button type="button" data-action="video-audio-picture" onClick={() => void prepare(videoChoice, true)}>Sound and picture</button>
            <button type="button" data-action="video-audio-only" onClick={() => void prepare(videoChoice, false)}>Sound only</button>
            <button type="button" data-action="video-audio-cancel" onClick={() => setVideoChoice(null)}>Cancel</button>
          </div>
        </div>
      )}
      {preparing && <p className="dim note" data-testid="audio-preparing">Taking the sound out of the file…</p>}
      <CombineAudio />
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
      <BeatControls />
      <ClipControls />
      <StemsControls />
      {analysisMessage !== null && (
        <p className={analysisState === 'error' ? 'bad' : analysisState === 'working' ? 'dim' : 'ok'}>
          {analysisMessage}
        </p>
      )}

      <AutoOffer />

      <LyricsSection />

      <AssetsPanel />

      <h2>Visuals</h2>
      <div className="module-buttons">
        {VISUALIZERS.map((m) => {
          const active = selectedLayer?.kind === 'module' && selectedLayer.module === m.manifest.id;
          return (
            <button
              key={m.manifest.id}
              type="button"
              className={active ? 'active' : ''}
              aria-pressed={active}
              data-action="add-layer"
              title={active ? 'In use. Click to remove it; Shift+click adds another' : 'Click to use it; Shift+click adds it as an extra layer'}
              onClick={(event) => pick(m.manifest.id, event.shiftKey)}
            >
              {m.manifest.name}
            </button>
          );
        })}
      </div>
      <p className="dim note">Click to use, click again to remove. Shift+click adds another. New visuals stay under the words. Esc deselects.</p>

      <ModulesPanel />

      <h2>Layers</h2>
      <p className="dim note">The top row draws over the rest. Drag a row onto another to put it above that one.</p>
      {/* The whole frame sits above every layer: its effects run after they are composited. Selecting
          it (or nothing) shows the global effect chain in the inspector. */}
      <button
        type="button"
        className={`frame-row${selectedLayerId === null ? ' selected' : ''}`}
        data-action="select-whole-frame"
        onClick={() => select(null)}
      >
        <span className="layer-name">
          <span className="name">Whole frame</span>
          <span className="meta">{document.globalEffects.length === 0 ? 'no effects' : `${document.globalEffects.length} effect${document.globalEffects.length === 1 ? '' : 's'}`}</span>
        </span>
      </button>
      {layers.length === 0 ? (
        <p className="empty">No layers yet.</p>
      ) : (
        // Bottom-to-top is how they composite; showing them top-first matches every other tool.
        <ul className="layer-list">
          {layers.map(({ layer, depth }) => (
            <LayerRow
              key={layer.id}
              layer={layer}
              depth={depth}
              selected={selectedIds.includes(layer.id)}
              onSelect={(event) => {
                // A second click lets go, so there is always an obvious way out of a selection.
                if (!event.shiftKey && !event.ctrlKey && !event.metaKey && layer.id === selectedLayerId && selectedIds.length <= 1) select(null);
                else if (event.shiftKey) extendLayerSelection(layer.id, 'range', layers.map((row) => row.layer.id));
                else if (event.ctrlKey || event.metaKey) extendLayerSelection(layer.id, 'toggle', layers.map((row) => row.layer.id));
                else select(layer.id);
              }}
            />
          ))}
        </ul>
      )}
      {selectedIds.length > 1 && (
        <div className="layer-actions" data-testid="multi-layer-actions">
          <span className="dim">{selectedIds.length} layers</span>
          <button type="button" data-action="layers-toggle" title="Show or hide them all" onClick={() => {
            const show = selectedIds.some((id) => findLayer(document, id)?.enabled === false);
            run(sequence(show ? 'Show layers' : 'Hide layers', selectedIds.map((id) => setLayerFlag(id, 'enabled', show))));
          }}>Show / hide</button>
          <button type="button" data-action="layers-group" onClick={() => {
            const group = createGroupLayer([], { id: newId(), name: 'Group' });
            run(groupLayers(selectedIds, group));
            select(group.id);
          }}>Group</button>
          <button type="button" data-action="layers-delete" title="Locked layers stay" onClick={() => {
            const free = selectedIds.filter((id) => findLayer(document, id)?.locked !== true);
            if (free.length > 0) run(sequence('Delete layers', free.map((id) => removeLayer(id))));
            select(null);
          }}>Delete</button>
        </div>
      )}
      {selectedLayerId !== null && selectedIds.length <= 1 && (
        <div className="layer-actions">
          <button type="button" onClick={() => run(duplicateLayer(selectedLayerId, newId))}>Duplicate</button>
          <button
            type="button"
            disabled={selectedLayer?.locked === true}
            title={selectedLayer?.locked === true ? 'Locked — unlock it to delete' : 'Delete this layer'}
            onClick={() => { run(removeLayer(selectedLayerId)); select(null); }}
          >
            Delete
          </button>
          {(['up', 'down'] as const).map((direction) => {
            const position = stepPosition(document, selectedLayerId, direction);
            return (
              <button
                key={direction}
                type="button"
                data-action={`layer-${direction}`}
                title={direction === 'up' ? 'Up one (drawn later, on top)' : 'Down one (drawn earlier, underneath)'}
                disabled={position === undefined}
                onClick={() => position !== undefined && run(moveLayer(selectedLayerId, position))}
              >
                {direction === 'up' ? '↑' : '↓'}
              </button>
            );
          })}
          <button type="button" data-action="layer-top" onClick={() => run(moveLayer(selectedLayerId, { index: Number.MAX_SAFE_INTEGER }))}>
            To top
          </button>
          <button type="button" data-action="layer-bottom" title="Under everything else" onClick={() => run(moveLayer(selectedLayerId, { index: 0 }))}>
            To bottom
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
  onSelect: (event: React.MouseEvent) => void;
}): React.JSX.Element {
  const { layer, depth, selected, onSelect } = props;
  const run = useStudio((s) => s.run);
  const notify = useStudio((s) => s.notify);
  const [dropping, setDropping] = useState(false);

  // Drag a row onto another to put it directly above that row, in that row's group (layer-order.ts).
  function drop(event: React.DragEvent): void {
    event.preventDefault();
    setDropping(false);
    const draggedId = event.dataTransfer.getData(DRAG_TYPE);
    if (draggedId === '') return;
    const position = dropPosition(useStudio.getState().document, draggedId, layer.id);
    if (position === undefined) return;
    try {
      run(moveLayer(draggedId, position));
    } catch (error) {
      notify({ text: error instanceof Error ? error.message : String(error), kind: 'bad' });
    }
  }

  return (
    <li
      className={`layer-row${selected ? ' selected' : ''}${layer.enabled ? '' : ' hidden'}${layer.locked ? ' locked' : ''}${dropping ? ' drop-target' : ''}`}
      data-layer={layer.id}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(DRAG_TYPE, layer.id);
        event.dataTransfer.effectAllowed = 'move';
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
        event.preventDefault();
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={drop}
    >
      <button type="button" className="layer-name" style={{ paddingLeft: `${8 + depth * 12}px` }} onClick={onSelect}>
        <span className="name">{layer.locked ? '🔒 ' : ''}{layer.name === '' ? '(unnamed)' : layer.name}</span>
        <span className="meta">{layer.kind === 'group' ? `group · ${layer.children.length}` : layer.module}</span>
      </button>
      <button
        type="button"
        className={layer.soloed ? 'flag on' : 'flag'}
        title={layer.soloed ? 'Soloed — only soloed layers draw. Click to unsolo' : 'Solo: draw only this layer (and other soloed ones)'}
        data-action="solo"
        onClick={() => run(setLayerFlag(layer.id, 'soloed', !layer.soloed))}
      >
        S
      </button>
      <button
        type="button"
        className={layer.locked ? 'flag on' : 'flag'}
        title={layer.locked ? 'Locked — its settings cannot be edited. Click to unlock' : 'Lock its settings against edits'}
        data-action="lock"
        onClick={() => run(setLayerFlag(layer.id, 'locked', !layer.locked))}
      >
        L
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
        <button type="button" title="Paste a shader from shadertoy.com; it becomes a layer" data-action="shadertoy-paste" onClick={() => useStudio.getState().setShadertoyOpen(true)}>Paste Shadertoy…</button>
        <button type="button" title="Read modules/ again" data-action="modules-reload" onClick={() => void loadModules().then(() => useStudio.getState().notify({ text: 'Read the modules folder again.', kind: 'ok' }))}>Reload</button>
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
