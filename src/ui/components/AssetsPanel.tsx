// The Assets panel (ui-spec §5, M40): the files this project uses, and the managed library.
//
// The project half answers "is everything this project needs actually here?" at a glance — each
// asset shows whether it loaded, is missing, or changed on disk, what uses it, and offers relink.
// The library half is a folder of backgrounds and logos to pull into any project; clicking one adds
// it as a background layer, and "Random" does that with a pick from the pool (ui-spec §5).

import { useEffect, useRef, useState } from 'react';

import { assetUsage, removeAsset, removeUnusedAssets } from '../../project/commands.ts';
import type { ImageBytes, LibraryItem } from '../../shell/ipc.ts';
import { useStudio, type AssetStatus } from '../store.ts';

const STATE_LABEL: Readonly<Record<AssetStatus['state'], string>> = {
  loading: 'loading',
  ok: 'ok',
  missing: 'missing',
  changed: 'changed',
  error: 'unreadable',
};

export function AssetsPanel(): React.JSX.Element {
  const document = useStudio((s) => s.document);
  const statuses = useStudio((s) => s.assetStatus);
  const run = useStudio((s) => s.run);
  const relink = useStudio((s) => s.relink);
  const findMissing = useStudio((s) => s.findMissing);
  const collectFiles = useStudio((s) => s.collectFiles);
  const loadAssets = useStudio((s) => s.loadAssets);

  const usage = assetUsage(document);
  const missing = document.assets.filter((a) => statuses[a.id]?.state === 'missing').length;
  const unused = document.assets.filter((a) => !usage.has(a.id)).length;

  return (
    <>
      <h2>Assets</h2>
      {document.assets.length === 0 ? (
        <p className="empty">No files yet. Images chosen in a layer, or picked from the library below, appear here.</p>
      ) : (
        <ul className="asset-list" data-testid="asset-list">
          {document.assets.map((asset) => {
            const status = statuses[asset.id];
            const uses = usage.get(asset.id) ?? [];
            return (
              <li key={asset.id} className={`asset-row state-${status?.state ?? 'loading'}`}>
                <div className="asset-row-head">
                  <span className="asset-row-name" title={asset.path}>{asset.name || asset.path}</span>
                  <span className={`asset-state state-${status?.state ?? 'loading'}`} title={status?.detail ?? ''}>
                    {STATE_LABEL[status?.state ?? 'loading']}
                  </span>
                </div>
                <div className="asset-row-meta" title={uses.map((u) => u.where).join('\n')}>
                  {uses.length === 0 ? 'unused' : `used by ${uses.length === 1 ? uses[0]!.where : `${uses.length} parameters`}`}
                  {asset.size > 0 ? ` · ${formatBytes(asset.size)}` : ''}
                </div>
                {status !== undefined && (status.state === 'missing' || status.state === 'error' || status.state === 'changed') && (
                  <div className={status.state === 'changed' ? 'asset-row-detail warn' : 'asset-row-detail bad'}>{status.detail}</div>
                )}
                <div className="asset-row-actions">
                  <button type="button" data-action="asset-relink" onClick={() => void relink(asset.id)}>Relink…</button>
                  <button type="button" disabled={status?.state !== 'ok' && status?.state !== 'changed'} onClick={() => void window.pulseforge.revealAsset(asset.path)}>Show</button>
                  <button
                    type="button"
                    disabled={uses.length > 0}
                    title={uses.length > 0 ? 'In use — remove it from those layers first' : 'Remove from the project (the file stays on disk)'}
                    onClick={() => run(removeAsset(asset.id))}
                  >
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div className="asset-tools">
        {missing > 0 && (
          <button type="button" className="wide" data-action="find-missing" onClick={() => void findMissing()}>
            Find {missing} missing file{missing === 1 ? '' : 's'} in folder…
          </button>
        )}
        {document.assets.some((a) => statuses[a.id]?.state === 'missing' || statuses[a.id]?.state === 'error') && (
          <button type="button" className="wide" onClick={() => void loadAssets(true)}>Check again</button>
        )}
        {unused > 0 && (
          <button type="button" className="wide" onClick={() => run(removeUnusedAssets())}>Remove {unused} unused</button>
        )}
        <button
          type="button"
          className="wide"
          data-action="collect-files"
          title="Copy the project, its audio and its images into one folder, for archiving or moving to another machine"
          onClick={() => void collectFiles()}
        >
          Collect files…
        </button>
      </div>

      <LibrarySection />
    </>
  );
}

function LibrarySection(): React.JSX.Element {
  const library = useStudio((s) => s.library);
  const loadLibrary = useStudio((s) => s.loadLibrary);
  const addToLibrary = useStudio((s) => s.addToLibrary);
  const useLibraryImage = useStudio((s) => s.useLibraryImage);
  const [category, setCategory] = useState('backgrounds');

  useEffect(() => {
    if (library === null) void loadLibrary();
  }, [library, loadLibrary]);

  const items = (library?.items ?? []).filter((item) => category === 'all' || item.category === category);

  function random(): void {
    if (items.length === 0) return;
    // UI randomness, not render randomness: it only decides which file becomes a layer, and the
    // result is an ordinary, undoable, deterministic layer.
    const pick = items[Math.floor(Math.random() * items.length)];
    if (pick !== undefined) void useLibraryImage(pick.path);
  }

  return (
    <>
      <h2>Library</h2>
      <div className="library-bar">
        <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Library category">
          <option value="backgrounds">Backgrounds</option>
          <option value="logos">Logos</option>
          <option value="">Top level</option>
          <option value="all">All</option>
        </select>
        <button type="button" title="Add images to this category" data-action="library-add" onClick={() => void addToLibrary(category === 'all' ? '' : category)}>Add…</button>
        <button type="button" title="Pick a random image from this category as a background" disabled={items.length === 0} onClick={random}>Random</button>
        <button type="button" title="Open the library folder" onClick={() => void window.pulseforge.revealLibrary()}>Folder</button>
        <button type="button" title="Re-read the folder" onClick={() => void loadLibrary()}>↻</button>
      </div>
      {library === null ? (
        <p className="dim">Reading the library…</p>
      ) : items.length === 0 ? (
        <p className="empty">Nothing here yet. Add images, or drop files into {library.folder}.</p>
      ) : (
        <ul className="library-grid">
          {items.map((item) => (
            <li key={item.path}>
              <button type="button" className="library-item" title={`${item.name}\nClick to add as a background layer`} onClick={() => void useLibraryImage(item.path)}>
                <Thumbnail item={item} />
                <span className="library-name">{item.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Decoded thumbnails, kept for the session: the library rarely changes and each costs an FFmpeg run. */
const thumbnails = new Map<string, Promise<ImageBytes>>();

function Thumbnail({ item }: { item: LibraryItem }): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    const key = `${item.path}|${item.size}`;
    let pending = thumbnails.get(key);
    if (pending === undefined) {
      pending = window.pulseforge.libraryThumbnail(item.path);
      thumbnails.set(key, pending);
      pending.catch(() => thumbnails.delete(key));
    }
    pending.then((image) => {
      const canvas = canvasRef.current;
      if (!alive || canvas === null) return;
      canvas.width = image.width;
      canvas.height = image.height;
      const pixels = new Uint8ClampedArray(image.pixels); // a copy with its own ArrayBuffer, as ImageData requires
      canvas.getContext('2d')?.putImageData(new ImageData(pixels, image.width, image.height), 0, 0);
    }).catch(() => {
      if (alive) setFailed(true);
    });
    return () => {
      alive = false;
    };
  }, [item.path, item.size]);

  return failed ? <span className="library-thumb broken">?</span> : <canvas ref={canvasRef} className="library-thumb" />;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}
