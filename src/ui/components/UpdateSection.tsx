// Settings → Updates (D52). Nothing reaches the network until the button is pressed; a newer release
// is shown with its notes, and installs only on a second press, after its SHA-256 checks out.

import { useEffect, useState } from 'react';

import type { UpdateCheck } from '../../shell/ipc.ts';
import { useStudio } from '../store.ts';

type UpdateState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'checked'; readonly check: UpdateCheck }
  | { readonly kind: 'installing'; readonly check: UpdateCheck; readonly received: number; readonly total: number }
  | { readonly kind: 'failed'; readonly message: string; readonly check: UpdateCheck | null };

const megabytes = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export function UpdateSection(): React.JSX.Element {
  const [state, setState] = useState<UpdateState>({ kind: 'idle' });
  const dirty = useStudio((s) => s.dirty);

  useEffect(() => window.pulseforge.onUpdateProgress(({ received, total }) => {
    setState((current) => (current.kind === 'installing' ? { ...current, received, total } : current));
  }), []);

  const check = async () => {
    setState({ kind: 'checking' });
    try {
      setState({ kind: 'checked', check: await window.pulseforge.checkForUpdate() });
    } catch (error) {
      setState({ kind: 'failed', message: `Could not reach GitHub: ${message(error)}`, check: null });
    }
  };

  const install = async (found: UpdateCheck) => {
    setState({ kind: 'installing', check: found, received: 0, total: found.latest?.bytes ?? 0 });
    try {
      await window.pulseforge.installUpdate();
    } catch (error) {
      setState({ kind: 'failed', message: message(error), check: found });
    }
  };

  const found = state.kind === 'checked' || state.kind === 'installing' || state.kind === 'failed' ? state.check : null;
  const latest = found?.latest ?? null;

  return (
    <section data-testid="settings-updates">
      <h3>Updates</h3>
      <p className="dim note">Pulseforge never looks for updates by itself. This button asks GitHub once, and only installs when you say so.</p>
      <div className="setup-actions">
        <button type="button" data-action="update-check" disabled={state.kind === 'checking' || state.kind === 'installing'} onClick={() => void check()}>
          {state.kind === 'checking' ? 'Checking…' : 'Check for updates'}
        </button>
      </div>
      {found !== null && !found.newer ? (
        <p className="ok" data-testid="update-current">
          {latest === null ? `This is ${found.current}; there is no release for this system yet.` : `Up to date: ${found.current} is the newest release.`}
        </p>
      ) : null}
      {found !== null && found.newer && latest !== null ? (
        <div className="update-offer" data-testid="update-offer">
          <p>
            <strong>Pulseforge {latest.version}</strong> is available (this is {found.current}). {megabytes(latest.bytes)}.
            {' '}<a href={latest.page} target="_blank" rel="noreferrer">Release page</a>
          </p>
          {latest.notes === '' ? null : <pre className="update-notes">{latest.notes}</pre>}
          {found.cannotInstall !== null ? <p className="dim">{found.cannotInstall}</p> : (
            <>
              <p className="dim note">
                Downloads the installer, checks it against the release&apos;s SHA-256, then installs it over this version. Your
                components, projects and settings stay. Pulseforge closes and opens again on the new version.
              </p>
              {dirty && state.kind !== 'installing' ? <p className="warn-text">Save your project first: the app restarts.</p> : null}
              <button type="button" className="primary" data-action="update-install" disabled={dirty || state.kind === 'installing'} onClick={() => void install(found)}>
                {state.kind === 'installing'
                  ? `Downloading… ${state.total > 0 ? Math.floor((state.received / state.total) * 100) : 0}%`
                  : `Install ${latest.version}`}
              </button>
            </>
          )}
        </div>
      ) : null}
      {state.kind === 'failed' ? <p className="bad" data-testid="update-error">{state.message}</p> : null}
    </section>
  );
}
