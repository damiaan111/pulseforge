// Storage (M33, PROJECT.md §8.14): the cache, seen and managed.
//
// One cache root, what is in it by category and by track (biggest first), the free space on its
// drive, the least-recently-used ceiling and the low-disk warning, and the ways to get space back:
// remove one item, clear a category, keep only the last N tracks, clear everything. What the open
// project uses is marked and never removed. Everything here is rebuildable — the screen says so,
// because "clear the cache" should never feel like a gamble.

import { useCallback, useEffect, useState } from 'react';

import type { CacheCategory } from '../../cache/cache-store.ts';
import type { CacheAction, CacheListing, UserSettings } from '../../shell/ipc.ts';
import { useStudio } from '../store.ts';

const CATEGORY_LABEL: Record<CacheCategory, string> = {
  track: 'Tracks (analysis and stems)',
  video: 'Video frames',
  thumbnails: 'Preset thumbnails',
  scratch: 'Scratch',
  other: 'Other',
};

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} B`;
}

function ago(ms: number): string {
  const days = (Date.now() - ms) / 86_400_000;
  if (days < 1) return 'today';
  if (days < 2) return 'yesterday';
  if (days < 60) return `${Math.floor(days)} days ago`;
  return new Date(ms).toLocaleDateString();
}

export function StorageSection(props: { readonly settings: UserSettings; readonly defaultRoot: string | null; readonly save: (patch: Partial<UserSettings>) => Promise<void> }): React.JSX.Element {
  const { settings, defaultRoot, save } = props;
  const notify = useStudio((s) => s.notify);
  const [listing, setListing] = useState<CacheListing | null>(null);
  const [keep, setKeep] = useState(10);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => setListing(await window.pulseforge.cacheInventory()), []);
  useEffect(() => {
    void refresh();
  }, [refresh, settings.cacheRoot]);

  const act = async (action: CacheAction, confirmText: string) => {
    if (!window.confirm(confirmText)) return;
    setBusy(true);
    try {
      const result = await window.pulseforge.cacheAction(action);
      setListing(result.listing);
      notify({ text: `Freed ${formatBytes(result.freedBytes)}${result.skipped > 0 ? `; ${result.skipped} item${result.skipped === 1 ? '' : 's'} in use were kept` : ''}.`, kind: 'ok' });
    } catch (error) {
      notify({ text: error instanceof Error ? error.message : String(error), kind: 'bad' });
    } finally {
      setBusy(false);
    }
  };
  const choose = async (key: 'cacheRoot' | 'scratchDir', title: string) => {
    const folder = await window.pulseforge.pickFolder(title);
    if (folder !== null) await save({ [key]: folder });
  };

  const low = listing !== null && listing.freeBytes !== null && listing.lowDiskBytes > 0 && listing.freeBytes < listing.lowDiskBytes;
  const inUse = new Set(listing?.inUse ?? []);

  return (
    <section data-testid="settings-storage">
      <h3>Storage</h3>
      <p className="dim note">Everything here is rebuildable: removing it costs only the time to make it again (analysis in seconds, stems in under a minute on the GPU).</p>
      <div className="field">
        <span>Cache folder</span>
        <code className="path">{settings.cacheRoot ?? `${defaultRoot ?? ''} (default)`}</code>
      </div>
      <div className="setup-actions">
        <button type="button" onClick={() => void choose('cacheRoot', 'Choose the cache folder')}>Choose…</button>
        {settings.cacheRoot !== null && <button type="button" onClick={() => void save({ cacheRoot: null })}>Use the default</button>}
        <button type="button" onClick={() => void window.pulseforge.revealCache()}>Open</button>
      </div>
      <p className="dim note">A new folder is used from now on; what is in the old one stays there until you clear it (clear it first if you are moving).</p>
      <div className="field">
        <span>Scratch folder</span>
        <code className="path">{settings.scratchDir ?? 'inside the cache folder'}</code>
        <button type="button" onClick={() => void choose('scratchDir', 'Choose the scratch folder')}>Choose…</button>
        {settings.scratchDir !== null && <button type="button" onClick={() => void save({ scratchDir: null })}>Default</button>}
      </div>
      <label className="field">
        <span>Size limit</span>
        <select value={settings.cacheCeilingGb} data-setting="cacheCeilingGb" onChange={(e) => void save({ cacheCeilingGb: Number(e.target.value) })}>
          {[0, 5, 10, 20, 50, 100, 250].map((gb) => <option key={gb} value={gb}>{gb === 0 ? 'No limit' : `${gb} GB — least recently used goes first`}</option>)}
        </select>
      </label>
      <label className="field">
        <span>Warn when free space is below</span>
        <select value={settings.lowDiskWarningGb} data-setting="lowDiskWarningGb" onChange={(e) => void save({ lowDiskWarningGb: Number(e.target.value) })}>
          {[0, 2, 5, 10, 20, 50].map((gb) => <option key={gb} value={gb}>{gb === 0 ? 'Never warn' : `${gb} GB`}</option>)}
        </select>
      </label>

      {listing === null ? <p className="dim">Measuring…</p> : (
        <div className="cache-breakdown" data-testid="cache-breakdown">
          <p>
            <strong data-testid="cache-total">{formatBytes(listing.totalBytes)}</strong> in the cache
            {listing.ceilingBytes > 0 && <> of a {formatBytes(listing.ceilingBytes)} limit</>}
            {listing.freeBytes !== null && <> · <span className={low ? 'bad' : ''}>{formatBytes(listing.freeBytes)} free on the drive{low ? ' — low' : ''}</span></>}
          </p>
          <ul className="cache-categories">
            {(Object.keys(CATEGORY_LABEL) as CacheCategory[]).filter((c) => listing.byCategory[c] > 0).map((c) => (
              <li key={c}>
                <span className="cache-bar"><span style={{ width: `${Math.max(1, (listing.byCategory[c] / Math.max(1, listing.totalBytes)) * 100)}%` }} /></span>
                <span>{CATEGORY_LABEL[c]}</span>
                <span className="dim">{formatBytes(listing.byCategory[c])}</span>
                <button type="button" disabled={busy} data-action={`cache-clear-${c}`} onClick={() => void act({ kind: 'clear', category: c }, `Clear ${CATEGORY_LABEL[c].toLowerCase()} (${formatBytes(listing.byCategory[c])})? It is rebuilt when needed; what is in use now is kept.`)}>Clear</button>
              </li>
            ))}
          </ul>
          <div className="setup-actions">
            <span>Keep the last</span>
            <input type="number" min={0} max={999} value={keep} onChange={(e) => setKeep(Math.max(0, Math.round(Number(e.target.value))))} className="short" aria-label="Tracks to keep" />
            <span>tracks</span>
            <button type="button" disabled={busy} data-action="cache-keep-recent" onClick={() => void act({ kind: 'keepRecent', keep }, `Remove the analysis and stems of every track but the ${keep} most recently used?`)}>Remove older</button>
            <button type="button" disabled={busy || listing.totalBytes === 0} data-action="cache-clear-all" onClick={() => void act({ kind: 'clear', category: 'all' }, `Clear the whole cache (${formatBytes(listing.totalBytes)})? What is in use now is kept.`)}>Clear everything</button>
          </div>
          <table className="cache-units">
            <tbody>
              {listing.units.slice(0, 50).map((u) => (
                <tr key={u.id} data-unit={u.id}>
                  <td title={u.id}>{u.label}{inUse.has(u.id) && <em className="badge">in use</em>}</td>
                  <td className="dim">{Object.keys(u.parts).length > 1 ? Object.entries(u.parts).map(([k, v]) => `${k} ${formatBytes(v)}`).join(' · ') : CATEGORY_LABEL[u.category].split(' (')[0]}</td>
                  <td className="dim">{ago(u.lastUsed)}</td>
                  <td>{formatBytes(u.bytes)}</td>
                  <td><button type="button" disabled={busy || inUse.has(u.id)} title={inUse.has(u.id) ? 'The open project uses it' : 'Remove it; it is rebuilt when needed'} onClick={() => void act({ kind: 'remove', ids: [u.id] }, `Remove ${u.label} (${formatBytes(u.bytes)}) from the cache?`)}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {listing.units.length > 50 && <p className="dim note">…and {listing.units.length - 50} smaller items.</p>}
          {listing.legacy !== null && (
            <p className="warn">
              {formatBytes(listing.legacy.bytes)} of analysis is still in the old cache location ({listing.legacy.path}); nothing reads it any more.{' '}
              <button type="button" disabled={busy} onClick={() => void act({ kind: 'clearLegacy' }, `Delete the old cache folder ${listing.legacy?.path ?? ''}?`)}>Clear it</button>
            </p>
          )}
        </div>
      )}
    </section>
  );
}
