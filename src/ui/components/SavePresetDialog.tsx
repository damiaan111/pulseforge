// Save preset (S8, M25, PROJECT.md §8 top bar "Save Preset").
//
// Saves the selected layer — its module, non-default values, effects, modulations, transform and
// per-aspect overrides — or the whole project's look, into the user library. The name may be
// anything; the file gets a slug of it, and a name already taken gets a suffix rather than
// replacing someone's earlier work (preset-store.ts). The thumbnail is drawn straight away, so the
// new card has its picture when the browser shows it (D45: pre-rendered on save).

import { useEffect, useMemo, useState } from 'react';

import { findLayer } from '../../project/commands.ts';
import { createLayerPreset, createProjectPreset } from '../../project/presets.ts';
import { manifestLookup, useModules } from '../modules.ts';
import { thumbnailUrl } from '../preset-thumbnails.ts';
import { history, useStudio } from '../store.ts';

export function SavePresetDialog(): React.JSX.Element | null {
  const scope = useStudio((s) => s.presetDialog);
  const setScope = useStudio((s) => s.setPresetDialog);
  const setPresets = useStudio((s) => s.setPresets);
  const notify = useStudio((s) => s.notify);
  const document = useStudio((s) => s.document);
  const selectedLayerId = useStudio((s) => s.selectedLayerId);
  const { manifests } = useModules();
  const lookup = useMemo(() => manifestLookup(manifests), [manifests]);

  const layer = selectedLayerId === null ? undefined : findLayer(document, selectedLayerId);
  const moduleLayer = layer?.kind === 'module' ? layer : undefined;
  const suggested = scope === 'layer' ? (moduleLayer?.name || manifests.get(moduleLayer?.module ?? '')?.name || 'Layer preset') : document.name;

  const [name, setName] = useState(suggested);
  const [tags, setTags] = useState('');
  const [busy, setBusy] = useState(false);
  // A fresh suggestion each time the dialog opens, or switches between layer and project.
  useEffect(() => setName(suggested), [scope]);

  if (scope === null) return null;

  async function save(): Promise<void> {
    if (scope === null || name.trim() === '') return;
    setBusy(true);
    try {
      const options = { name: name.trim(), tags: tags.split(',').map((tag) => tag.trim().toLowerCase()).filter((tag) => tag !== '') };
      const current = history.current;
      let preset;
      if (scope === 'layer') {
        const target = selectedLayerId === null ? undefined : findLayer(current, selectedLayerId);
        if (target === undefined || target.kind !== 'module') throw new Error('Select a layer to save it as a preset.');
        preset = createLayerPreset(target, lookup, options);
      } else {
        preset = createProjectPreset(current, lookup, options);
      }
      const { slug, library } = await window.pulseforge.savePreset(preset);
      setPresets(library);
      setScope(null);
      notify({ text: `Saved preset “${preset.name}”`, kind: 'ok' });
      const entry = library.entries.find((item) => item.origin === 'user' && item.scope === scope && item.slug === slug);
      if (entry !== undefined) void thumbnailUrl(entry, lookup);
    } catch (error) {
      notify({ text: `Could not save the preset. ${error instanceof Error ? error.message : String(error)}`, kind: 'bad' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => setScope(null)}>
      <div className="modal save-preset-dialog" role="dialog" aria-label="Save preset" onClick={(event) => event.stopPropagation()}>
        <h2>Save preset</h2>
        <div className="presets-filters">
          <button
            type="button"
            className={scope === 'layer' ? 'active' : ''}
            disabled={moduleLayer === undefined}
            title={moduleLayer === undefined ? 'Select a layer first' : 'The selected layer, its effects and modulations'}
            onClick={() => setScope('layer')}
          >
            Selected layer
          </button>
          <button type="button" className={scope === 'project' ? 'active' : ''} title="Every layer, the global effects and the palette" onClick={() => setScope('project')}>
            Whole project
          </button>
        </div>
        <label className="field">
          <span>Name</span>
          <input type="text" value={name} data-action="preset-name" autoFocus onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="field">
          <span>Tags</span>
          <input type="text" value={tags} placeholder="neon, bars, calm" data-action="preset-tags" onChange={(event) => setTags(event.target.value)} />
        </label>
        <p className="dim">
          {scope === 'layer'
            ? 'Only settings that differ from the defaults are stored, so later improvements to the defaults still reach this preset.'
            : 'A project preset is a look: the audio, canvas, timing and seed of whatever it is applied to are left alone.'}
        </p>
        <div className="modal-actions">
          <button type="button" onClick={() => setScope(null)}>Cancel</button>
          <button type="button" className="primary" data-action="preset-save-confirm" disabled={busy || name.trim() === ''} onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
