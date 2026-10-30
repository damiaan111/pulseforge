// Choosing what to install: on the first run, and from Settings ever after.
//
// The list comes from setup/components.ts through the main process, so what is offered here, what
// `--components` accepts and what gets installed are one thing. Everything a choice costs is stated
// beforehand: its size, its licence, and whether this PC can run it. A component that needs a newer
// NVIDIA driver cannot be ticked, and says why, instead of failing twenty minutes into a download.

import { forgetMilkdropIndex } from '../milkdrop.ts';
import { useStudio } from '../store.ts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ComponentRow, ComponentsInfo } from '../../shell/ipc.ts';

function size(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.ceil(bytes / 1e6)} MB`;
}

/** Why this PC cannot run a component, or null when it can. */
export function blockedReason(component: Pick<ComponentRow, 'minDriver'>, driver: ComponentsInfo['driver']): string | null {
  if (component.minDriver === null) return null;
  if (driver === null) return 'Needs an NVIDIA graphics card.';
  return driver.major >= component.minDriver ? null : `Needs NVIDIA driver ${component.minDriver} or newer; this PC has ${driver.version}.`;
}

/** A selection with everything each chosen component needs. */
export function withRequirements(ids: ReadonlySet<string>, rows: readonly ComponentRow[]): Set<string> {
  const out = new Set(ids);
  const add = (id: string) => {
    if (out.has(id) && !ids.has(id)) return;
    out.add(id);
    rows.find((row) => row.id === id)?.requires.forEach(add);
  };
  [...ids].forEach(add);
  return out;
}

export function ComponentChooser(props: { readonly firstRun: boolean; readonly onClose?: () => void; readonly onChanged?: () => void }): React.JSX.Element {
  const { firstRun, onClose, onChanged } = props;
  const [info, setInfo] = useState<ComponentsInfo | null>(null);
  const [wanted, setWanted] = useState<ReadonlySet<string>>(new Set());
  const [accepted, setAccepted] = useState(false);
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<readonly string[]>([]);
  const [result, setResult] = useState<{ readonly ok: boolean; readonly text: string } | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  const refresh = useCallback(async () => {
    const next = await window.pulseforge.componentsInfo();
    setInfo(next);
    return next;
  }, []);
  useEffect(() => {
    void refresh().then((next) => {
      // On the first run the features this PC can use start ticked; models are asked for.
      if (firstRun) setWanted(new Set(next.components.filter((c) => c.group !== 'model' && blockedReason(c, next.driver) === null).map((c) => c.id)));
    });
  }, [firstRun, refresh]);
  useEffect(() => window.pulseforge.onSetupOutput((line) => {
    if (running) setLines((l) => [...l.slice(-400), line]);
  }), [running]);
  useEffect(() => {
    const el = logRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const rows = useMemo(() => info?.components ?? [], [info]);
  const selected = useMemo(() => withRequirements(wanted, rows), [wanted, rows]);
  const toInstall = rows.filter((row) => selected.has(row.id) && !row.installed);
  const total = toInstall.reduce((sum, row) => sum + row.bytes, 0);
  const nonCommercial = toInstall.some((row) => row.nonCommercial);
  const tooBig = info !== null && info.freeBytes !== null && total > info.freeBytes;

  const toggle = (id: string, on: boolean) => {
    const next = new Set(wanted);
    if (on) next.add(id);
    else next.delete(id);
    setWanted(next);
  };

  const install = async () => {
    setRunning(true);
    setLines([]);
    setResult(null);
    try {
      const { code } = await window.pulseforge.runSetup({ mode: 'components', components: toInstall.map((row) => row.id), acceptNonCommercial: nonCommercial && accepted });
      const after = await refresh();
      if (code === 0) {
        setWanted(new Set());
        setAccepted(false);
        setResult({ ok: true, text: 'Installed.' });
        forgetMilkdropIndex();
        void useStudio.getState().loadTemplates();
        onChanged?.();
      } else {
        const core = after.components.find((c) => c.id === 'core')?.installed === true;
        setResult({ ok: false, text: `Installing stopped${core ? '' : ' before the essentials were in'}; the log above says why. Start it again and finished downloads are kept.` });
      }
    } catch (error) {
      setResult({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setRunning(false);
    }
  };

  const row = (component: ComponentRow) => {
    const blocked = blockedReason(component, info?.driver ?? null);
    const required = component.group === 'required';
    const pulled = selected.has(component.id) && !wanted.has(component.id);
    return (
      <li key={component.id} data-extra={component.id} data-component={component.id} className={blocked !== null ? 'blocked' : ''}>
        <label>
          <input
            type="checkbox"
            data-action={`component-${component.id}`}
            checked={component.installed || required || selected.has(component.id)}
            disabled={running || component.installed || required || pulled || blocked !== null}
            onChange={(event) => toggle(component.id, event.target.checked)}
          />
          <span className="component-text">
            <span>
              <strong>{component.title}</strong> <span className="dim">{size(component.bytes)}</span>
              {component.nonCommercial ? <span className="badge warn"> Non-commercial</span> : null}
            </span>
            <span className="dim">{component.summary}</span>
            {blocked !== null && !component.installed ? <span className="warn-text">{blocked}</span> : null}
            {pulled ? <span className="dim">Needed by what you chose.</span> : null}
          </span>
        </label>
        {component.installed ? <span className="ok">Installed</span> : null}
      </li>
    );
  };

  const list = (
    <>
      <ul className="component-list" data-testid="component-features">
        {rows.filter((c) => c.group !== 'model').map(row)}
      </ul>
      <h4>Optional models</h4>
      <ul className="component-list" data-testid="optional-models">
        {rows.filter((c) => c.group === 'model').map(row)}
      </ul>
      {nonCommercial && info !== null ? (
        <div className="non-commercial" data-testid="non-commercial-notice">
          <p>{info.nonCommercialNotice}</p>
          <label>
            <input type="checkbox" data-action="accept-non-commercial" checked={accepted} disabled={running} onChange={(event) => setAccepted(event.target.checked)} />
            {' '}I understand these models are for non-commercial use.
          </label>
        </div>
      ) : null}
      <p className="dim note" data-testid="component-total">
        {toInstall.length === 0 ? 'Nothing chosen to install.' : `To download: about ${size(total)}.`}
        {info?.freeBytes != null ? ` ${size(info.freeBytes)} free on this drive.` : ''}
        {info?.driver != null ? ` ${info.driver.name}, driver ${info.driver.version}.` : ' No NVIDIA card found: video exports on the CPU, more slowly, and the GPU features are not available.'}
      </p>
      {tooBig ? <p className="warn-text">That is more than the drive has free.</p> : null}
      {lines.length > 0 ? <pre className="setup-log" ref={logRef} data-testid="component-log">{lines.join('\n')}</pre> : null}
      {result !== null ? <p className={result.ok ? 'ok' : 'bad'} data-testid="component-result">{result.text}</p> : null}
      <div className="setup-actions">
        <button
          type="button"
          className="primary"
          data-action="components-install"
          disabled={running || info === null || toInstall.length === 0 || tooBig || (nonCommercial && !accepted)}
          onClick={() => void install()}
        >
          {running ? 'Installing…' : 'Install'}
        </button>
        {running ? <button type="button" onClick={() => void window.pulseforge.cancelSetup()}>Stop</button> : null}
        {firstRun && !running && onClose !== undefined ? <button type="button" data-action="components-later" onClick={onClose}>Not now</button> : null}
      </div>
    </>
  );

  if (!firstRun) return <div className="component-chooser" data-testid="component-chooser">{list}</div>;
  return (
    <div className="modal-backdrop">
      <div className="modal component-chooser first-run" role="dialog" aria-label="Set up Pulseforge" data-testid="component-chooser">
        <h2>Set up Pulseforge</h2>
        <p className="dim note">Choose what to download. Everything stays inside this folder, and you can add more later in Settings. After this, Pulseforge works offline.</p>
        {list}
      </div>
    </div>
  );
}
