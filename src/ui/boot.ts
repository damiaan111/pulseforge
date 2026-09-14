// The renderer entry point.
//
// A deliberately small vertical slice for P3 step 1: open a project through the sandboxed IPC
// bridge, parse it *here* with `src/project/` (pure, no Node), show what it contains and what
// the engine would not be able to draw, and save it back. The React studio (ui-spec) replaces
// this view in a later step; what it must not replace is the shape — the renderer never touches
// the filesystem, and every problem the loader found is on screen rather than in a console.

import { CURRENT_SCHEMA_VERSION, walkLayers, type ProjectDocument } from '../project/document.ts';
import { createDocument } from '../project/create.ts';
import { loadDocument } from '../project/load.ts';
import { ProjectFormatError, ProjectVersionError, type DocumentIssue } from '../project/parse.ts';
import { stringifyDocument } from '../project/serialize.ts';
import { timelineDurationTicks, toRenderProject } from '../project/snapshot.ts';
import { ticksToSeconds } from '../engine/core/time.ts';
import type { EnvironmentReport, SnapshotNoteView } from './view-model.ts';
import { describeProject } from './view-model.ts';

interface State {
  document: ProjectDocument;
  path: string | null;
  issues: readonly DocumentIssue[];
  migratedFrom: number | null;
  dirty: boolean;
  environment: EnvironmentReport | null;
  message: { text: string; kind: 'ok' | 'warn' | 'bad' } | null;
}

const state: State = {
  document: createDocument({ name: 'Untitled' }),
  path: null,
  issues: [],
  migratedFrom: null,
  dirty: false,
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

function render(): void {
  const { document: doc } = state;
  const summary = describeProject(doc);
  const { notes } = toRenderProject(doc);

  const openButton = element('button', {}, ['Open…']);
  openButton.addEventListener('click', () => void openProject());
  const saveButton = element('button', state.path === null ? { disabled: 'true' } : {}, ['Save']);
  saveButton.addEventListener('click', () => void saveProject());
  const saveAsButton = element('button', {}, ['Save as…']);
  saveAsButton.addEventListener('click', () => void saveProjectAs());
  const newButton = element('button', {}, ['New']);
  newButton.addEventListener('click', () => {
    state.document = createDocument({ name: 'Untitled' });
    state.path = null;
    state.issues = [];
    state.migratedFrom = null;
    state.dirty = false;
    state.message = null;
    render();
  });

  const header = element('header', {}, [
    element('h1', {}, ['Pulseforge']),
    element('span', {}, [`${doc.name}${state.dirty ? ' •' : ''}`]),
    element('span', { class: 'spacer' }),
  ]);
  header.append(newButton, openButton, saveButton, saveAsButton);

  const projectPanel = element('section', {}, [
    element('h2', {}, ['Project']),
    definitions([
      ['File', state.path ?? 'not saved yet'],
      ['Schema', `v${doc.schemaVersion}${state.migratedFrom === null ? '' : ` (migrated from v${state.migratedFrom})`}`],
      ['Canvas', `${doc.canvas.width}×${doc.canvas.height} @ ${doc.canvas.fps.num / doc.canvas.fps.den} fps · ${summary.aspect}`],
      ['Duration', `${ticksToSeconds(timelineDurationTicks(doc)).toFixed(2)} s`],
      ['Seed', String(doc.seed)],
      ['Audio', doc.audio.path === '' ? 'none' : doc.audio.path],
      ['Layers', `${count(summary.layerCount, 'layer')}, ${count(summary.effectCount, 'effect')}, ${count(summary.bindingCount, 'modulation')}`],
    ]),
    element('h2', {}, ['Layers']),
    ...(summary.layerCount === 0
      ? [element('p', { class: 'empty' }, ['This project has no layers yet.'])]
      : [...walkLayers(doc.layers)].map(({ layer, parents }) =>
        element('div', { class: `layer${layer.enabled ? '' : ' disabled'}` }, [
          element('div', { class: 'name' }, [`${'— '.repeat(parents.length)}${layer.name || '(unnamed)'}`]),
          element('div', { class: 'meta' }, [
            layer.kind === 'group' ? `group · ${layer.children.length} children` : layer.module,
          ]),
        ]))),
  ]);

  const statusPanel = element('section', {}, [
    element('h2', {}, ['Status']),
    ...(state.message === null
      ? []
      : [element('p', { class: state.message.kind }, [state.message.text])]),
    ...(state.issues.length === 0 && notes.length === 0
      ? [element('p', { class: 'ok' }, ['The project loaded cleanly and the engine can draw all of it.'])]
      : []),
    ...problemList('Loader issues', state.issues.map((i) => ({ path: i.path, detail: `${i.problem}: ${i.detail}` })), 'error'),
    ...problemList('Not yet rendered', notes as readonly SnapshotNoteView[], 'warn'),
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

  const body = element('div', { class: 'body' }, [projectPanel, statusPanel]);
  root.className = '';
  root.replaceChildren(header, body);
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
  state.document = loaded.document;
  state.issues = loaded.issues;
  state.migratedFrom = loaded.migratedFrom;
  state.path = file.path;
  state.dirty = loaded.migratedFrom !== null;
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
      text: stringifyDocument(state.document),
      ...(state.migratedFrom === null ? {} : { backupFromVersion: state.migratedFrom }),
    });
    state.dirty = false;
    state.migratedFrom = null;
    state.message = {
      text: result.backupPath === undefined ? `Saved ${result.path}` : `Saved ${result.path}; the pre-migration original is at ${result.backupPath}`,
      kind: 'ok',
    };
    render();
  } catch (error) {
    report(error, 'Saving the project');
  }
}

async function saveProjectAs(): Promise<void> {
  try {
    const suggested = `${state.document.name.replace(/[^\w\- ]+/g, '') || 'untitled'}.pvproj`;
    const result = await window.pulseforge.saveProjectAs(stringifyDocument(state.document), suggested);
    if (result === null) return;
    state.path = result.path;
    state.dirty = false;
    state.migratedFrom = null;
    state.message = { text: `Saved ${result.path}`, kind: 'ok' };
    render();
  } catch (error) {
    report(error, 'Saving the project');
  }
}

render();

async function start(): Promise<void> {
  try {
    state.environment = await window.pulseforge.environment();
    render();
    const initial = await window.pulseforge.initialProject();
    if (initial !== null) adoptProject(initial);
  } catch (error) {
    report(error, 'Starting up');
  }
}

void start();
