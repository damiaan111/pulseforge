// The Settings screen (M36, PROJECT.md §8.16, ui-spec §8).
//
// Every setting saves as it changes — there is no Apply button to forget — and a refused value
// says why beside the control that sent it. Sections, in the order they are reached for:
// General, Audio & models, Export, Storage (M33, StorageSection.tsx), Diagnostics (M34), Setup &
// repair, Environment, Keyboard.
//
// Setup & repair runs the same `npm run setup` a terminal would (verify, or re-run one tier), with
// its output streamed here. It is the entry point ui-spec §8 asks for: a feature that is not
// installed says so where it would be, and this is where it gets fixed.
//
// Two items of §8.16 are shown rather than chosen, and say why: the GPU (Chromium picks the device
// for WebGL; the one in use is reported) and the keyboard map (a reference; remapping is not built
// — ROADMAP §4).

import { useEffect, useRef, useState } from 'react';

import { EXPORT_PRESETS } from '../../export/export-presets.ts';
import type { SettingsInfo, UserSettings } from '../../shell/ipc.ts';
import { useStudio } from '../store.ts';
import { StorageSection } from './StorageSection.tsx';

const SHORTCUTS: readonly (readonly [string, string])[] = [
  ['Space / K', 'Play or pause'],
  ['Home', 'Back to the start'],
  ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo'],
  ['Ctrl+S', 'Save'],
  ['Ctrl+E', 'Export'],
  ['Ctrl+,', 'Settings'],
  ['Esc', 'Close the topmost panel or dialog'],
  ['F (timeline)', 'Fit the whole timeline'],
  ['↑ / ↓ (lyrics)', 'Previous / next line'],
  ['I / O (lyrics)', 'Line starts / ends at the playhead'],
  ['[ / ] (lyrics)', 'Nudge selected lines 10 ms (Shift: 100 ms)'],
  ['S / M / L (lyrics)', 'Split at the playhead / merge with next / lock'],
  ['T (tapping)', 'Tap the next line; Backspace undoes a tap, Esc ends'],
];

export function SettingsDialog(): React.JSX.Element | null {
  const open = useStudio((s) => s.settingsOpen);
  const setOpen = useStudio((s) => s.setSettingsOpen);
  const settings = useStudio((s) => s.settings);
  const updateSettings = useStudio((s) => s.updateSettings);
  const [info, setInfo] = useState<SettingsInfo | null>(null);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});

  useEffect(() => {
    if (!open) return;
    let live = true;
    void window.pulseforge.settingsInfo().then((next) => {
      if (live) setInfo(next);
    });
    return () => {
      live = false;
    };
  }, [open]);

  if (!open || settings === null) return null;

  const save = async (patch: Partial<UserSettings>) => {
    const key = Object.keys(patch)[0] ?? '';
    const problem = await updateSettings(patch);
    setErrors((e) => {
      const next = { ...e };
      if (problem === null) delete next[key];
      else next[key] = problem;
      return next;
    });
  };
  const error = (key: keyof UserSettings) => (errors[key] === undefined ? null : <p className="bad field-error">{errors[key]}</p>);

  return (
    <div className="modal-backdrop" onClick={() => setOpen(false)}>
      <div className="modal settings-dialog" role="dialog" aria-label="Settings" data-testid="settings-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="queue-head">
          <h2>Settings</h2>
          <span className="spacer" />
          <button type="button" onClick={() => setOpen(false)} title="Close (Esc)">✕</button>
        </div>

        <div className="settings-body">
          <section>
            <h3>General</h3>
            <label className="field">
              <span>Theme</span>
              <select value={settings.theme} data-setting="theme" onChange={(e) => void save({ theme: e.target.value as UserSettings['theme'] })}>
                <option value="dark">Dark</option>
                <option value="light">Light</option>
                <option value="system">Follow Windows</option>
              </select>
            </label>
            <label className="field">
              <span>Autosave every</span>
              <select value={settings.autosaveMinutes} data-setting="autosaveMinutes" onChange={(e) => void save({ autosaveMinutes: Number(e.target.value) })}>
                {[1, 2, 5, 10, 15, 30].map((m) => <option key={m} value={m}>{m} minute{m === 1 ? '' : 's'}</option>)}
              </select>
            </label>
            {error('autosaveMinutes')}
            <label className="field">
              <span>Preview quality at start</span>
              <select value={settings.previewScale} data-setting="previewScale" onChange={(e) => void save({ previewScale: Number(e.target.value) })}>
                {[1, 0.75, 0.5, 0.25].map((s) => <option key={s} value={s}>{Math.round(s * 100)}% resolution</option>)}
              </select>
            </label>
          </section>

          <section>
            <h3>Audio &amp; models</h3>
            <label className="field">
              <span>Stem model for new projects</span>
              <select value={settings.stemModel} data-setting="stemModel" onChange={(e) => void save({ stemModel: e.target.value })}>
                {withCurrent(info?.stemModels ?? [], settings.stemModel).map((m) => <option key={m} value={m}>{m}{info !== null && !info.stemModels.includes(m) ? ' (not installed)' : ''}</option>)}
              </select>
            </label>
            {info !== null && info.stemModels.length <= 1 && <p className="dim note">Only {info.stemModels[0] ?? 'no model'} is installed. The slower, finer <code>htdemucs_ft</code> comes with the extras tier (not built yet).</p>}
            <label className="field">
              <span>Transcription model</span>
              <select value={settings.whisperModel} data-setting="whisperModel" onChange={(e) => void save({ whisperModel: e.target.value })}>
                {withCurrent(info?.whisperModels ?? [], settings.whisperModel).map((m) => <option key={m} value={m}>{m.replace('faster-whisper-', 'Whisper ')}{info !== null && !info.whisperModels.includes(m) ? ' (not installed)' : ''}</option>)}
              </select>
            </label>
            <div className="field">
              <span>Tap latency</span>
              <span>{settings.tapLatencyMs === null ? 'not calibrated' : `${settings.tapLatencyMs} ms`}</span>
              {settings.tapLatencyMs !== null && <button type="button" onClick={() => void save({ tapLatencyMs: null })}>Reset</button>}
            </div>
            <p className="dim note">Calibrate it from the Lyrics drawer's tap-to-sync.</p>
          </section>

          <section>
            <h3>Export</h3>
            <label className="field">
              <span>Export dialog opens on</span>
              <select value={settings.defaultExportPreset ?? ''} data-setting="defaultExportPreset" onChange={(e) => void save({ defaultExportPreset: e.target.value === '' ? null : e.target.value })}>
                <option value="">{EXPORT_PRESETS[0]?.label ?? 'The first preset'}</option>
                {EXPORT_PRESETS.slice(1).map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </label>
          </section>

          <StorageSection settings={settings} defaultRoot={info?.paths.defaultCacheRoot ?? null} save={save} />

          <DiagnosticsSection level={settings.logLevel} save={save} />

          <SetupSection />

          <section data-testid="settings-environment">
            <h3>Environment</h3>
            {info === null ? <p className="dim">Reading…</p> : (
              <dl className="env-report">
                <dt>Pulseforge</dt><dd>{info.environment.appVersion}</dd>
                <dt>Electron</dt><dd>{info.environment.electronVersion} (Chromium {info.environment.chromeVersion}, Node {info.environment.nodeVersion})</dd>
                <dt>System</dt><dd>{info.environment.platform} {info.environment.arch}</dd>
                <dt>GPU</dt><dd title="Chromium chooses the GPU for WebGL; this is the one in use.">{info.gpu}</dd>
                {(['ffmpeg', 'ffprobe', 'python'] as const).map((k) => (
                  <FragmentRow key={k} label={k} value={info.environment.vendor[k].present ? info.environment.vendor[k].path : `missing — ${info.environment.vendor[k].path}`} bad={!info.environment.vendor[k].present} />
                ))}
                <dt>Settings file</dt><dd>{info.paths.settings} <button type="button" onClick={() => void window.pulseforge.revealPath('settings')}>Open folder</button></dd>
              </dl>
            )}
          </section>

          <section>
            <h3>Keyboard</h3>
            <table className="shortcuts">
              <tbody>{SHORTCUTS.map(([keys, what]) => <tr key={keys}><td><kbd>{keys}</kbd></td><td>{what}</td></tr>)}</tbody>
            </table>
            <p className="dim note">A reference: remapping is not built yet.</p>
          </section>
        </div>
      </div>
    </div>
  );
}

function FragmentRow(props: { label: string; value: string; bad: boolean }): React.JSX.Element {
  return (
    <>
      <dt>{props.label}</dt>
      <dd className={props.bad ? 'bad' : ''}>{props.value}</dd>
    </>
  );
}

/** The log's level, where it is, and "Copy diagnostics" (M34). */
function DiagnosticsSection(props: { readonly level: UserSettings['logLevel']; readonly save: (patch: Partial<UserSettings>) => Promise<void> }): React.JSX.Element {
  const notify = useStudio((s) => s.notify);
  const [info, setInfo] = useState<{ path: string; bytes: number } | null>(null);
  useEffect(() => {
    void window.pulseforge.logInfo().then((next) => setInfo({ path: next.path, bytes: next.bytes }));
  }, [props.level]);
  const copy = async () => {
    try {
      const { lines } = await window.pulseforge.copyDiagnostics();
      notify({ text: `Diagnostics copied (${lines} lines) — paste them into a message.`, kind: 'ok' });
    } catch (error) {
      notify({ text: error instanceof Error ? error.message : String(error), kind: 'bad' });
    }
  };
  return (
    <section data-testid="settings-diagnostics">
      <h3>Diagnostics</h3>
      <label className="field">
        <span>Log detail</span>
        <select value={props.level} data-setting="logLevel" onChange={(e) => void props.save({ logLevel: e.target.value as UserSettings['logLevel'] })}>
          <option value="error">Errors only</option>
          <option value="warn">Warnings and errors</option>
          <option value="info">Normal</option>
          <option value="debug">Everything (for chasing a problem)</option>
        </select>
      </label>
      <div className="field">
        <span>Log file</span>
        <code className="path" data-testid="log-path">{info === null ? '…' : `${info.path} (${info.bytes < 1e6 ? `${Math.round(info.bytes / 1e3)} KB` : `${(info.bytes / 1e6).toFixed(1)} MB`})`}</code>
      </div>
      <div className="setup-actions">
        <button type="button" onClick={() => void window.pulseforge.revealLogs()}>Open log folder</button>
        <button type="button" data-action="copy-diagnostics" onClick={() => void copy()}>Copy diagnostics</button>
      </div>
      <p className="dim note">Diagnostics are the environment, the settings, the cache at a glance and the log's last 200 lines, copied to your clipboard — nothing is sent anywhere.</p>
    </section>
  );
}

/** The installed choices, plus the saved one if it is not among them (so it is visible, not lost). */
function withCurrent(options: readonly string[], current: string): string[] {
  return options.includes(current) ? [...options] : [current, ...options];
}

/** Verify, or re-run one tier, with setup's output streamed in. */
function SetupSection(): React.JSX.Element {
  const [lines, setLines] = useState<readonly string[]>([]);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => window.pulseforge.onSetupOutput((line) => setLines((l) => [...l.slice(-400), line])), []);
  useEffect(() => {
    const el = logRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const run = async (request: Parameters<typeof window.pulseforge.runSetup>[0]) => {
    setLines([]);
    setResult(null);
    setRunning(true);
    try {
      const { code } = await window.pulseforge.runSetup(request);
      setResult(code === 0 ? (request.mode === 'verify' ? 'Everything installed checks out.' : 'Done.') : `Setup stopped with code ${code ?? 'none'}; the output above says why.`);
    } catch (error) {
      setResult(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
    }
  };

  return (
    <section data-testid="settings-setup">
      <h3>Setup &amp; repair</h3>
      <p className="dim note">Verify re-checks every installed file against its checksum, offline. Repair re-runs one part of setup: finished work is kept, and anything missing or damaged is fetched again (this needs the network, or the archives folder setup was given).</p>
      <div className="setup-actions">
        <button type="button" data-action="setup-verify" disabled={running} onClick={() => void run({ mode: 'verify' })}>Verify installation</button>
        {(['core', 'stems', 'lyrics'] as const).map((tier) => (
          <button key={tier} type="button" disabled={running} data-action={`setup-repair-${tier}`} onClick={() => void run({ mode: 'repair', tier })}>Repair {tier}</button>
        ))}
        {running && <button type="button" onClick={() => void window.pulseforge.cancelSetup()}>Cancel</button>}
      </div>
      {lines.length > 0 && <pre className="setup-log" ref={logRef} data-testid="setup-log">{lines.join('\n')}</pre>}
      {result !== null && <p className={/stopped|not|fail/i.test(result) ? 'bad' : 'ok'} data-testid="setup-result">{result}</p>}
    </section>
  );
}
