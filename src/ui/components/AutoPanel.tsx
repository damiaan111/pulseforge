// The Auto drawer (M21, M22, D9; auto-director-spec §8–§9).
//
// Four things, top to bottom, in the order they are used:
//  - **Templates**, ranked for this track with their scores and why — the director's first choice
//    is marked, but any available one can be picked. Unavailable ones say what they are missing.
//  - **Colours**: optionally, a picture of the user's or the song's own cover, for the palette.
//  - **Generate** with the picked template, and **Surprise me** with its locks (keep template,
//    palette, layout, motion) and the roulette toggle (may change template).
//  - **The history strip**: the last rolls as thumbnails, each restorable.
//  - **The decision log** in plain language, grouped by step — what was chosen, from what, and why,
//    and every guardrail that fired. "Nothing black-box" is this list.
//
// Everything the director writes is an ordinary layer, effect or binding: the panel says so, and a
// reroll keeps whatever the user has edited since.

import { useEffect, useMemo, useRef, useState } from 'react';

import { DIRECTOR_LOCKS, type DecisionStep, type DirectorLock, type DirectorRoll } from '../../project/document.ts';
import { directorBlocker, drawRollThumbnail, rankedTemplates, rollKey, runDirector } from '../director.ts';
import { useStudio } from '../store.ts';

const LOCK_LABEL: Record<DirectorLock, { label: string; hint: string }> = {
  template: { label: 'Template', hint: 'Stay with this template' },
  palette: { label: 'Palette', hint: 'Keep the colours exactly as they are, your edits included' },
  layout: { label: 'Layout', hint: 'Keep the same modules in the same places (implies Template)' },
  motion: { label: 'Motion', hint: 'Keep what drives what, and how hard' },
};

const STEP_LABEL: Record<DecisionStep, string> = {
  classify: 'The track',
  match: 'Template',
  palette: 'Palette',
  populate: 'Layers',
  calibrate: 'Modulation',
  arrange: 'Arrangement',
  guardrail: 'Guardrails',
  keep: 'Kept from before',
};

export function AutoDrawer(): React.JSX.Element | null {
  const open = useStudio((s) => s.autoOpen);
  const setOpen = useStudio((s) => s.setAutoOpen);
  // Field by field: the store changes on every preview frame, and this drawer must not.
  const director = useStudio((s) => s.document.director);
  const analysis = useStudio((s) => s.analysis);
  const analysisState = useStudio((s) => s.analysisState);
  const audio = useStudio((s) => s.audio);
  const templates = useStudio((s) => s.templates);
  const templateProblems = useStudio((s) => s.templateProblems);
  const templatesFolder = useStudio((s) => s.templatesFolder);
  const loadTemplates = useStudio((s) => s.loadTemplates);
  const sections = useStudio((s) => s.sections);
  const lyrics = useStudio((s) => s.document.lyrics);
  const assets = useStudio((s) => s.document.assets);
  const canvas = useStudio((s) => s.document.canvas);
  const userModules = useStudio((s) => s.userModules);
  const autoLocks = useStudio((s) => s.autoLocks);
  const setAutoLocks = useStudio((s) => s.setAutoLocks);
  const autoRoulette = useStudio((s) => s.autoRoulette);
  const setAutoRoulette = useStudio((s) => s.setAutoRoulette);
  const colourSource = useStudio((s) => s.autoColourSource);
  const chooseColourImage = useStudio((s) => s.chooseAutoColourImage);
  const useCoverColours = useStudio((s) => s.useCoverArtColours);
  const clearColourSource = useStudio((s) => s.clearAutoColourSource);
  const blocker = directorBlocker(useStudio.getState());
  // Ranking reads the analysis and the templates, not the layers: recomputed only when those change.
  const ranked = useMemo(
    () => (open && blocker === null ? rankedTemplates(useStudio.getState()) : []),
    [open, blocker, analysis, analysisState, audio, templates, sections, lyrics, assets, canvas, userModules],
  );
  const [picked, setPicked] = useState<string | null>(null);
  const current = director?.current.templateId ?? null;
  const choice = picked ?? current ?? ranked.find((r) => r.availability.available)?.template.id ?? null;

  // Thumbnails for the strip: drawn when the drawer is open and a roll has none yet.
  const rolls = useMemo(() => (director === null ? [] : [director.current, ...[...director.history].reverse()]), [director]);
  useEffect(() => {
    if (!open || blocker !== null) return;
    for (const roll of rolls) void drawRollThumbnail(roll);
  }, [open, rolls, blocker]);

  if (!open) return null;

  return (
    <aside className="queue-drawer auto-drawer" aria-label="Auto" data-testid="auto-drawer">
      <div className="queue-head">
        <h2>Auto</h2>
        <span className="dim">{director === null ? 'a project from the track' : director.current.summary}</span>
        <span className="spacer" />
        <button type="button" onClick={() => setOpen(false)} title="Close (Esc)">✕</button>
      </div>

      {blocker !== null ? <p className="empty" data-testid="auto-blocked">{blocker}</p> : (
        <>
          <section className="auto-templates" data-testid="auto-templates">
            <h3>Template</h3>
            <ul>
              {ranked.map((r, i) => {
                const id = r.template.id;
                const available = r.availability.available;
                return (
                  <li key={id}>
                    <label className={`auto-template${choice === id ? ' chosen' : ''}${available ? '' : ' unavailable'}`} title={available ? r.reasons.join('\n') || 'Fits this track' : r.availability.reason ?? ''}>
                      <input type="radio" name="auto-template" value={id} checked={choice === id} disabled={!available} onChange={() => setPicked(id)} data-template={id} />
                      <span className="auto-template-name">
                        {r.template.name}
                        {i === 0 && available ? <em className="badge">best match</em> : null}
                        {current === id ? <em className="badge">current</em> : null}
                      </span>
                      <span className="auto-score" aria-label={`score ${r.score.toFixed(2)}`}>
                        <span style={{ width: `${Math.min(100, Math.round((r.score / Math.max(1e-6, ranked[0]!.score)) * 100))}%` }} />
                      </span>
                      <span className="auto-template-note">{available ? r.template.description : `Unavailable: ${r.availability.reason ?? ''}`}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
            <div className="auto-actions">
              <button type="button" className="primary" data-action="auto-generate" disabled={choice === null}
                title="Make a complete project from this track with the chosen template. One undo step."
                onClick={() => runDirector({ kind: 'generate', templateId: choice })}>
                {director === null ? 'Generate project' : 'Generate again'}
              </button>
            </div>
          </section>

          <section className="auto-colours" data-testid="auto-colours">
            <h3>Colours</h3>
            <p className="dim" data-testid="auto-colour-source">
              {colourSource === null ? 'From the template and the track.' : `From ${colourSource.name}, on the next roll.`}
            </p>
            <div className="auto-actions">
              <button type="button" data-action="auto-colour-image" onClick={() => void chooseColourImage()} title="Choose a picture on this computer: its dominant colours become the palette. Your file is read here and goes nowhere.">Choose image…</button>
              <button type="button" data-action="auto-colour-cover" onClick={() => void useCoverColours()} title="Use the picture embedded in the song's file, if it has one. Nothing is looked up online.">Use song cover</button>
              {colourSource !== null && <button type="button" data-action="auto-colour-clear" onClick={clearColourSource} title="Back to the colours the template makes from the track">Clear</button>}
            </div>
          </section>

          <section className="auto-surprise" data-testid="auto-surprise">
            <h3>Surprise me</h3>
            <div className="auto-locks">
              <span className="dim">Keep</span>
              {DIRECTOR_LOCKS.map((lock) => (
                <label key={lock} title={LOCK_LABEL[lock].hint}>
                  <input
                    type="checkbox"
                    data-lock={lock}
                    checked={autoLocks.includes(lock) || (lock === 'template' && autoLocks.includes('layout'))}
                    disabled={lock === 'template' && autoLocks.includes('layout')}
                    onChange={(e) => setAutoLocks(e.target.checked ? [...autoLocks, lock] : autoLocks.filter((l) => l !== lock))}
                  />
                  {LOCK_LABEL[lock].label}
                </label>
              ))}
            </div>
            <label className="auto-roulette" title="Let a reroll pick among the best-matching templates, not only the current one">
              <input type="checkbox" checked={autoRoulette} disabled={autoLocks.includes('template') || autoLocks.includes('layout')} onChange={(e) => setAutoRoulette(e.target.checked)} data-action="auto-roulette" />
              Try other templates
            </label>
            <button type="button" data-action="auto-surprise" onClick={() => runDirector({ kind: 'surprise' })} title="A different take — anything you edited is kept. One undo step.">
              ✦ Surprise me
            </button>
          </section>

          {rolls.length > 0 && (
            <section className="auto-history" data-testid="auto-history">
              <h3>Rolls</h3>
              <ul className="roll-strip">
                {rolls.map((roll, i) => <RollTile key={`${rollKey(roll)}:${i}`} roll={roll} current={i === 0} />)}
              </ul>
            </section>
          )}
        </>
      )}

      {director !== null && <DecisionLog />}

      <div className="auto-footer">
        {templateProblems.length > 0 && (
          <ul className="auto-problems">
            {templateProblems.map((p) => <li key={p.path} className="bad">{p.path}: {p.message}</li>)}
          </ul>
        )}
        {templates.filter((t) => t.issues.length > 0).map((t) => (
          <p key={t.path} className="warn" title={t.issues.map((i) => `${i.path}: ${i.detail}`).join('\n')}>
            {t.template.name}: {t.issues.length} template issue{t.issues.length === 1 ? '' : 's'} (hover for details)
          </p>
        ))}
        <p className="dim">Everything generated is ordinary layers, effects and modulations — edit freely; a reroll keeps what you changed.</p>
        <button type="button" onClick={() => void loadTemplates().then(() => useStudio.getState().notify({ text: 'Read the template folders again.', kind: 'ok' }))} title="Read the template folders again">Reload templates</button>
        <button type="button" onClick={() => void window.pulseforge.revealTemplates()} title={templatesFolder ?? ''}>Open templates folder</button>
      </div>
    </aside>
  );
}

function RollTile(props: { roll: DirectorRoll; current: boolean }): React.JSX.Element {
  const { roll, current } = props;
  const url = useStudio((s) => s.rollThumbs[rollKey(roll)]);
  return (
    <li>
      <button
        type="button"
        className={`roll-tile${current ? ' current' : ''}`}
        data-action="auto-restore"
        disabled={current}
        title={current ? `Now: ${roll.summary}` : `Restore: ${roll.summary}`}
        onClick={() => runDirector({ kind: 'restore', roll })}
      >
        {url === undefined
          ? <span className="roll-swatches">{roll.palette.slice(0, 5).map((c, i) => <span key={i} style={{ background: c }} />)}</span>
          : <img src={url} alt="" />}
        <span className="roll-label">{roll.summary}</span>
      </button>
    </li>
  );
}

function DecisionLog(): React.JSX.Element {
  const log = useStudio((s) => s.document.director?.log ?? []);
  const [open, setOpen] = useState(true);
  const groups = new Map<DecisionStep, string[]>();
  for (const entry of log) groups.set(entry.step, [...(groups.get(entry.step) ?? []), entry.text]);
  return (
    <section className="auto-log" data-testid="auto-log">
      <button type="button" className="section-toggle" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} Why it looks like this
      </button>
      {open && [...groups].map(([step, texts]) => (
        <div key={step} className={`log-group log-${step}`}>
          <h4>{STEP_LABEL[step]}</h4>
          <ul>{texts.map((text, i) => <li key={i}>{text}</li>)}</ul>
        </div>
      ))}
    </section>
  );
}

/** The import-time offer (D9): shown in the audio section once a track lands in an empty project. */
export function AutoOffer(): React.JSX.Element | null {
  const offer = useStudio((s) => s.autoOffer);
  const setOpen = useStudio((s) => s.setAutoOpen);
  const dismiss = useStudio((s) => s.dismissAutoOffer);
  // The audio section sits below the preset browser: an offer out of sight is no offer.
  const place = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (offer) place.current?.scrollIntoView({ block: 'center' });
  }, [offer]);
  if (!offer) return null;
  return (
    <div className="auto-offer" data-testid="auto-offer" ref={place}>
      <span>Make a project from this track?</span>
      <button type="button" className="primary" data-action="auto-offer-open" onClick={() => setOpen(true)}>✦ Auto…</button>
      <button type="button" title="Not now" onClick={dismiss}>✕</button>
    </div>
  );
}
