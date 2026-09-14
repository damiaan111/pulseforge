// The renderer entry point.
//
// A deliberately small vertical slice while the React studio (ui-spec) is built: open a project
// through the sandboxed IPC bridge, parse it *here* with `src/project/` (pure, no Node), show
// what it contains and what the engine could not draw, edit it through commands, undo, and save.
//
// What this view must not lose when it is replaced: the renderer never touches the filesystem,
// every mutation goes through the command stack, and every problem the loader found is on
// screen rather than in a console.

import { CURRENT_SCHEMA_VERSION, walkLayers } from '../project/document.ts';
import { createDocument } from '../project/create.ts';
import { renameLayer, setLayerFlag } from '../project/commands.ts';
import { History } from '../project/history.ts';
import { loadDocument } from '../project/load.ts';
import { ProjectFormatError, ProjectVersionError, type DocumentIssue } from '../project/parse.ts';
import { stringifyDocument } from '../project/serialize.ts';
import { timelineDurationTicks, toRenderProject } from '../project/snapshot.ts';
import { ticksToSeconds } from '../engine/core/time.ts';
import type { EnvironmentReport, SnapshotNoteView } from './view-model.ts';
import { describeProject } from './view-model.ts';

interface State {
  path: string | null;
  issues: readonly DocumentIssue[];
  migratedFrom: number | null;
  environment: EnvironmentReport | null;
  message: { text: string; kind: 'ok' | 'warn' | 'bad' } | null;
}

/** The single source of truth for the project. Every edit goes through it (M8). */
const history = new History(createDocument({ name: 'Untitled' }));

const state: State = {
  path: null,
  issues: [],
  migratedFrom: null,
  environment: null,
  message: null,
};

function appRoot(): HTMLElement {
  const node = document.getElementById('app');
  if (node === null) throw new Error('The renderer page has no #app element');
  return node;
}

const root: HTMLElement = appRoot();

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string> = {},
  children: readonly (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  // textContent, never innerHTML: project names and module ids are untrusted text, and this
  // page has no reason to ever interpret them as markup.
  for (const child of children) node.append(child);
  return node;
}

function button(label: string, onClick: () => void, disabled = false): HTMLButtonElement {
  const node = element('button', disabled ? { disabled: 'true' } : {}, [label]);
  node.addEventListener('click', onClick);
  return node;
}

/** "1 layer" / "2 layers" — a UI that says "1 effects" reads as unfinished. */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function definitions(pairs: readonly (readonly [string, string | Node])[]): HTMLElement {
  const list = element('dl');
  for (const [term, value] of pairs) {
    list.append(element('dt', {}, [term]), element('dd', {}, [value]));
  }
  return list;
}

function problemList(title: string, problems: readonly { path: string; detail: string }[], kind: 'warn' | 'error'): readonly Node[] {
  if (problems.length === 0) return [];
  return [
    element('h2', {}, [`${title} (${problems.length})`]),
    ...problems.map((problem) =>
      element('div', { class: `problem ${kind}` }, [
        element('code', {}, [problem.path]),
        element('div', {}, [problem.detail]),
      ])),
  ];
}

function newProject(): void {
  history.reset(createDocument({ name: 'Untitled' }), 'New project');
  state.path = null;
  state.issues = [];
  state.migratedFrom = null;
  state.message = null;
  render();
}

function render(): void {
  const doc = history.current;
  const summary = describeProject(doc);
  const { notes } = toRenderProject(doc);

  const header = element('header', {}, [
    element('h1', {}, ['Pulseforge']),
    element('span', {}, [`${doc.name}${history.dirty ? ' •' : ''}`]),
    element('span', { class: 'spacer' }),
  ]);
  header.append(
    button('New', newProject),
    button('Open…', () => void openProject()),
    button('Save', () => void saveProject(), state.path === null),
    button('Save as…', () => void saveProjectAs()),
    // Labelled, so it says what it will reverse rather than just "Undo" (ui-spec §10).
    button(history.undoLabel === undefined ? 'Undo' : `Undo ${history.undoLabel}`, () => {
      history.undo();
      render();
    }, !history.canUndo),
    button(history.redoLabel === undefined ? 'Redo' : `Redo ${history.redoLabel}`, () => {
      history.redo();
      render();
    }, !history.canRedo),
  );

  const projectPanel = element('section', {}, [
    element('h2', {}, ['Project']),
    definitions([
      ['File', state.path ?? 'not saved yet'],
      ['Schema', `v${doc.schemaVersion}${state.migratedFrom === null ? '' : ` (migrated from v${state.migratedFrom})`}`],
      ['Canvas', `${doc.canvas.width}×${doc.canvas.height} @ ${doc.canvas.fps.num / doc.canvas.fps.den} fps · ${summary.aspect}`],
      ['Duration', `${ticksToSeconds(timelineDurationTicks(doc)).toFixed(2)} s`],
      ['Seed', String(doc.seed)],
      ['Audio', doc.audio.path === '' ? 'none' : doc.audio.path],
      ['Contents', `${count(summary.layerCount, 'layer')}, ${count(summary.effectCount, 'effect')}, ${count(summary.bindingCount, 'modulation')}`],
    ]),
    element('h2', {}, ['Layers']),
    ...(summary.layerCount === 0
      ? [element('p', { class: 'empty' }, ['This project has no layers yet.'])]
      : [...walkLayers(doc.layers)].map(({ layer, parents }) => {
        const row = element('div', { class: `layer${layer.enabled ? '' : ' disabled'}`, title: 'Click to show or hide' }, [
          element('div', { class: 'name' }, [`${'— '.repeat(parents.length)}${layer.name || '(unnamed)'}`]),
          element('div', { class: 'meta' }, [
            layer.kind === 'group' ? `group · ${count(layer.children.length, 'child')}` : layer.module,
          ]),
        ]);
        // Every mutation is a command, even this one — there is no second path that skips undo.
        row.addEventListener('click', () => {
          history.run(setLayerFlag(layer.id, 'enabled', !layer.enabled));
          render();
        });
        row.addEventListener('dblclick', () => {
          const name = prompt('Layer name', layer.name);
          if (name !== null) {
            history.run(renameLayer(layer.id, name));
            history.seal();
            render();
          }
        });
        return row;
      })),
  ]);

  const statusPanel = element('section', {}, [
    element('h2', {}, ['Status']),
    ...(state.message === null ? [] : [element('p', { class: state.message.kind }, [state.message.text])]),
    ...(state.issues.length === 0 && notes.length === 0
      ? [element('p', { class: 'ok' }, ['The project loaded cleanly and the engine can draw all of it.'])]
      : []),
    ...problemList('Loader issues', state.issues.map((i) => ({ path: i.path, detail: `${i.problem}: ${i.detail}` })), 'error'),
    ...problemList('Not yet rendered', notes as readonly SnapshotNoteView[], 'warn'),

    element('h2', {}, ['History']),
    ...history.entries.map((entry) => {
      const row = element('div', { class: `history-entry${entry.current ? ' current' : ''}` }, [
        element('div', { class: 'name' }, [entry.label]),
      ]);
      // Browsable, so "undo twelve steps" is one click rather than Ctrl+Z and hope.
      row.addEventListener('click', () => {
        history.jumpTo(entry.index);
        render();
      });
      return row;
    }),

    element('h2', {}, ['Environment']),
    ...(state.environment === null
      ? [element('p', { class: 'empty' }, ['Checking…'])]
      : [definitions([
        ['Electron', state.environment.electronVersion],
        ['Chrome', state.environment.chromeVersion],
        ['Node', state.environment.nodeVersion],
        ['Platform', `${state.environment.platform} ${state.environment.arch}`],
        ...(Object.entries(state.environment.vendor).map(([name, entry]) => [
          name,
          element('span', { class: entry.present ? 'ok' : 'bad' }, [entry.present ? entry.path : `missing — ${entry.path}`]),
        ] as const)),
      ])]),
  ]);

  root.className = '';
  root.replaceChildren(header, element('div', { class: 'body' }, [projectPanel, statusPanel]));
}

/** Turns any failure into a sentence on screen. Never a raw stack trace (ui-spec §11). */
function report(error: unknown, whileDoing: string): void {
  if (error instanceof ProjectVersionError) {
    state.message = { text: error.message, kind: 'bad' };
  } else if (error instanceof ProjectFormatError) {
    state.message = { text: `That file is not a Pulseforge project. ${error.message}`, kind: 'bad' };
  } else {
    state.message = { text: `${whileDoing} failed. ${error instanceof Error ? error.message : String(error)}`, kind: 'bad' };
  }
  render();
}

/** Applies a file the shell handed us, from the dialog or from the command line. */
function adoptProject(file: { path: string; text: string }): void {
  const loaded = loadDocument(file.text);
  // Opening replaces the history: the previous project's undo steps do not apply to this one.
  history.reset(loaded.document, 'Opened');
  state.issues = loaded.issues;
  state.migratedFrom = loaded.migratedFrom;
  state.path = file.path;
  state.message = loaded.migratedFrom === null
    ? { text: `Opened ${file.path}`, kind: 'ok' }
    : { text: `Opened and migrated from schema v${loaded.migratedFrom} to v${CURRENT_SCHEMA_VERSION}. The original is backed up on the first save.`, kind: 'warn' };
  render();
}

async function openProject(): Promise<void> {
  try {
    const file = await window.pulseforge.openProject();
    if (file === null) return;
    adoptProject(file);
  } catch (error) {
    report(error, 'Opening the project');
  }
}

async function saveProject(): Promise<void> {
  if (state.path === null) return saveProjectAs();
  try {
    const result = await window.pulseforge.saveProject({
      path: state.path,
      text: stringifyDocument(history.current),
      ...(state.migratedFrom === null ? {} : { backupFromVersion: state.migratedFrom }),
    });
    history.markSaved();
    state.migratedFrom = null;
    state.message = {
      text: result.backupPath === undefined
        ? `Saved ${result.path}`
        : `Saved ${result.path}; the pre-migration original is at ${result.backupPath}`,
      kind: 'ok',
    };
    render();
  } catch (error) {
    report(error, 'Saving the project');
  }
}

async function saveProjectAs(): Promise<void> {
  try {
    const suggested = `${history.current.name.replace(/[^\w\- ]+/g, '') || 'untitled'}.pvproj`;
    const result = await window.pulseforge.saveProjectAs(stringifyDocument(history.current), suggested);
    if (result === null) return;
    state.path = result.path;
    history.markSaved();
    state.migratedFrom = null;
    state.message = { text: `Saved ${result.path}`, kind: 'ok' };
    render();
  } catch (error) {
    report(error, 'Saving the project');
  }
}

// ui-spec §9. The full remappable map comes with the studio; these three are the ones whose
// absence is felt immediately.
window.addEventListener('keydown', (event) => {
  if (!event.ctrlKey && !event.metaKey) return;
  const key = event.key.toLowerCase();
  if (key === 'z') {
    event.preventDefault();
    if (event.shiftKey) history.redo();
    else history.undo();
    render();
  } else if (key === 's') {
    event.preventDefault();
    void saveProject();
  }
});

render();

async function start(): Promise<void> {
  try {
    state.environment = await window.pulseforge.environment();
    render();
    const initial = await window.pulseforge.initialProject();
    if (initial !== null) adoptProject(initial);
  } catch (error) {
    report(error, 'Starting up');
  } finally {
    // Startup is async, so "the page has painted" is not the same as "the app has settled".
    // Anything driving the window from outside — the launch smoke check today, UI tests later
    // — must wait for this rather than race the first render.
    document.body.dataset['pulseforgeReady'] = 'true';
  }
}

void start();
