// The preset browser (S8, ui-spec §5 "Presets", module-spec §10, D45).
//
// A library to choose looks from, not a list of files: animated thumbnails, search, tags, a
// scope filter and favourites. A click on a card does the obvious thing — replace the selected
// layer with a layer preset, or add one when nothing is selected; replace the project's look with a
// project preset — and the card's menu has the partial applies (style only, modulations only, add
// as a new layer, merge a look above the current one). Every apply is one undo step, and anything
// the preset could not carry across is said in a toast rather than dropped.
//
// Thumbnails are drawn lazily, when a card scrolls into view, and animate only under the pointer
// (ui-spec §13: heavy panels render lazily and pause when hidden).

import { useEffect, useMemo, useRef, useState } from 'react';

import { findLayer } from '../../project/commands.ts';
import { newId } from '../../project/ids.ts';
import { applyPreset, defaultApplyMode, type PresetApplyMode } from '../../project/preset-apply.ts';
import { searchPresets, tagCounts } from '../../project/preset-search.ts';
import type { ManifestLookup } from '../../project/presets.ts';
import type { PresetListing } from '../../shell/ipc.ts';
import { manifestLookup, useModules } from '../modules.ts';
import { cachedThumbnail, pendingThumbnail, thumbnailUrl } from '../preset-thumbnails.ts';
import { history, useStudio } from '../store.ts';

type ScopeFilter = 'all' | 'layer' | 'project';

const TAGS_SHOWN = 10;

export function PresetsPanel(): React.JSX.Element {
  const presets = useStudio((s) => s.presets);
  const loadPresets = useStudio((s) => s.loadPresets);
  const setPresetDialog = useStudio((s) => s.setPresetDialog);
  const selectedLayerId = useStudio((s) => s.selectedLayerId);
  const document = useStudio((s) => s.document);
  const { manifests } = useModules();
  const lookup = useMemo(() => manifestLookup(manifests), [manifests]);

  const [text, setText] = useState('');
  const [scope, setScope] = useState<ScopeFilter>('all');
  const [tags, setTags] = useState<readonly string[]>([]);
  const [starredOnly, setStarredOnly] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);

  useEffect(() => {
    void loadPresets();
  }, [loadPresets]);

  const entries = presets?.entries ?? [];
  const shown = useMemo(() => {
    const found = searchPresets(entries, {
      text,
      ...(tags.length === 0 ? {} : { tags }),
      ...(scope === 'all' ? {} : { scope }),
    });
    // Favourites first, then by name: the ones you reach for most are at the top.
    return [...found]
      .filter((entry) => !starredOnly || entry.favourite)
      .sort((a, b) => Number(b.favourite) - Number(a.favourite) || a.name.localeCompare(b.name));
  }, [entries, text, tags, scope, starredOnly]);
  const topTags = useMemo(() => [...tagCounts(entries).keys()].slice(0, TAGS_SHOWN), [entries]);

  const hasSelection = selectedLayerId !== null && findLayer(document, selectedLayerId)?.kind === 'module';

  return (
    <section className="presets-panel" data-testid="presets-panel">
      <div className="presets-head">
        <h2>Presets</h2>
        <span className="spacer" />
        <button
          type="button"
          data-action="save-preset"
          title="Save the selected layer, or the whole project, as a preset"
          onClick={() => setPresetDialog(hasSelection ? 'layer' : 'project')}
        >
          Save…
        </button>
        <button type="button" title="Open the presets folder" onClick={() => void window.pulseforge.revealPresets()}>Folder</button>
      </div>
      <input
        type="search"
        className="wide"
        placeholder="Search presets"
        value={text}
        data-action="preset-search"
        onChange={(event) => setText(event.target.value)}
      />
      <div className="presets-filters">
        {(['all', 'layer', 'project'] as const).map((value) => (
          <button key={value} type="button" className={scope === value ? 'active' : ''} onClick={() => setScope(value)}>
            {value === 'all' ? 'All' : value === 'layer' ? 'Layers' : 'Projects'}
          </button>
        ))}
        <button type="button" className={starredOnly ? 'active' : ''} title="Favourites only" onClick={() => setStarredOnly(!starredOnly)}>★</button>
      </div>
      {topTags.length > 0 && (
        <div className="tag-chips">
          {topTags.map((tag) => {
            const on = tags.includes(tag);
            return (
              <button
                key={tag}
                type="button"
                className={on ? 'chip active' : 'chip'}
                onClick={() => setTags(on ? tags.filter((t) => t !== tag) : [...tags, tag])}
              >
                {tag}
              </button>
            );
          })}
        </div>
      )}

      {presets === null ? <p className="dim">Reading presets…</p> : null}
      {presets !== null && shown.length === 0 ? (
        <p className="empty">{entries.length === 0 ? 'No presets yet. Save a layer or the project to start a library.' : 'Nothing matches.'}</p>
      ) : null}
      <ul className="preset-grid">
        {shown.map((entry) => (
          <PresetCard
            key={`${entry.scope}/${entry.slug}`}
            entry={entry}
            lookup={lookup}
            hasSelection={hasSelection}
            open={openKey === `${entry.scope}/${entry.slug}`}
            onToggle={() => setOpenKey(openKey === `${entry.scope}/${entry.slug}` ? null : `${entry.scope}/${entry.slug}`)}
          />
        ))}
      </ul>
      {(presets?.problems ?? []).map((problem) => (
        <p key={problem.path} className="bad module-problem" title={problem.path}>
          <strong>{problem.path.split(/[/\\]/).pop()}</strong>: {problem.message}
        </p>
      ))}
    </section>
  );
}

function PresetCard(props: {
  entry: PresetListing;
  lookup: ManifestLookup;
  hasSelection: boolean;
  open: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const { entry, lookup, hasSelection, open, onToggle } = props;
  const run = useStudio((s) => s.run);
  const select = useStudio((s) => s.select);
  const notify = useStudio((s) => s.notify);
  const setFavourite = useStudio((s) => s.setPresetFavourite);
  const deletePreset = useStudio((s) => s.deletePreset);
  const selectedLayerId = useStudio((s) => s.selectedLayerId);
  const document = useStudio((s) => s.document);

  function apply(mode: PresetApplyMode): void {
    try {
      const applied = applyPreset(entry.preset, mode, {
        document: history.current,
        selectedLayerId,
        manifests: lookup,
        newId,
      });
      run(applied.command);
      if (applied.select !== null) select(applied.select);
      notify(applied.notes.length > 0
        ? { text: `Applied “${entry.name}”, with notes:\n${applied.notes.join('\n')}`, kind: 'warn' }
        : { text: `Applied “${entry.name}”`, kind: 'ok' });
    } catch (error) {
      notify({ text: error instanceof Error ? error.message : String(error), kind: 'bad' });
    }
  }

  const clickMode = defaultApplyMode(entry.preset, document, selectedLayerId);
  const clickTitle = clickMode === 'replace' ? 'Click to replace the selected layer'
    : clickMode === 'add' ? 'Click to add as a new layer'
      : 'Click to use this look for the project';

  return (
    <li className={`preset-card${open ? ' open' : ''}`} data-preset={entry.slug}>
      <div className="preset-visual">
        <button type="button" className="preset-thumb" title={clickTitle} data-action="apply-preset" onClick={() => apply(clickMode)}>
          <Thumbnail entry={entry} lookup={lookup} />
        </button>
        {/* Over the picture's corner, so the name below gets the card's whole width. */}
        <div className="preset-corner">
          <button
          type="button"
            className={entry.favourite ? 'star on' : 'star'}
            title={entry.favourite ? 'Unstar' : 'Star'}
            data-action="star-preset"
            onClick={() => void setFavourite(entry.scope, entry.slug, !entry.favourite)}
          >
            {entry.favourite ? '★' : '☆'}
          </button>
          <button type="button" title="More ways to apply" data-action="preset-menu" onClick={onToggle}>⋯</button>
        </div>
      </div>
      <div className="preset-name" title={entry.name}>{entry.name}</div>
      <div className="preset-sub dim">
        {entry.scope === 'project' ? 'project' : (lookup(entry.moduleId ?? '') === undefined ? `${entry.moduleId} (not installed)` : entry.moduleId?.split('.').pop())}
        {entry.origin === 'builtin' ? ' · built-in' : ''}
      </div>
      {open && (
        <div className="preset-actions">
          {entry.scope === 'layer' ? (
            <>
              <button type="button" data-action="preset-add" onClick={() => apply('add')}>Add as layer</button>
              <button type="button" disabled={!hasSelection} onClick={() => apply('replace')}>Replace selected</button>
              <button type="button" disabled={!hasSelection} title="The preset's look; the layer keeps its name and modulations" onClick={() => apply('style')}>Style only</button>
              <button type="button" disabled={!hasSelection} title="Only the preset's modulations, onto the selected layer" onClick={() => apply('modulations')}>Modulations only</button>
            </>
          ) : (
            <>
              <button type="button" onClick={() => apply('look')}>Use this look</button>
              <button type="button" title="Add its layers above the current ones" onClick={() => apply('merge')}>Add its layers</button>
            </>
          )}
          {entry.origin === 'user' && (
            <button type="button" className="danger" data-action="preset-delete" onClick={() => void deletePreset(entry.scope, entry.slug)}>Delete</button>
          )}
          {entry.tags.length > 0 && <span className="dim preset-tags">{entry.tags.join(' · ')}</span>}
        </div>
      )}
    </li>
  );
}

/**
 * The card's animation strip. Asked for only once the card is on screen, and stepped through only
 * while the pointer is over it; a still first frame otherwise.
 */
function Thumbnail(props: { entry: PresetListing; lookup: ManifestLookup }): React.JSX.Element {
  const { entry, lookup } = props;
  const ref = useRef<HTMLSpanElement>(null);
  const [url, setUrl] = useState<string | undefined>(() => cachedThumbnail(entry.thumbnailKey));

  useEffect(() => {
    if (url !== undefined) return;
    const element = ref.current;
    if (element === null) return;
    let alive = true;
    // Already on its way (Save draws a new preset's strip at once): take it, visible or not.
    const inFlight = pendingThumbnail(entry.thumbnailKey);
    if (inFlight !== undefined) {
      void inFlight.then((found) => {
        if (alive && found !== null) setUrl(found);
      });
      return () => {
        alive = false;
      };
    }
    const observer = new IntersectionObserver((seen) => {
      if (!seen.some((item) => item.isIntersecting)) return;
      observer.disconnect();
      void thumbnailUrl(entry, lookup).then((found) => {
        if (alive && found !== null) setUrl(found);
      });
    });
    observer.observe(element);
    return () => {
      alive = false;
      observer.disconnect();
    };
  }, [entry, lookup, url]);

  return (
    <span
      ref={ref}
      className={url === undefined ? 'strip loading' : 'strip'}
      data-thumbnail={url === undefined ? 'pending' : 'ready'}
      style={url === undefined ? undefined : { backgroundImage: `url(${url})` }}
    />
  );
}
