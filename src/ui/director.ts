// The auto-director in the studio (M21, M22, ui-spec's "Auto" panel).
//
// The director itself is pure (src/director/); this file gathers what it needs from what the studio
// already holds — the analysis, sections, onsets, the vocal stem's segments, the module library —
// runs it, and applies the result as **one undoable command**, so a generated project, a Surprise
// me and a restore from the history are each a single Ctrl+Z away.
//
// Seeds: Generate uses the project's own seed, so generating twice with the same template gives the
// same project. Surprise me draws a fresh seed here, in the UI — the one place randomness is allowed
// — and the roll records it, so every result stays reproducible.
//
// The history strip's thumbnails are drawn on the preview's stills engine (the one preset
// thumbnails use), one frame from the loudest section, at 192 px wide. They are a per-session
// picture; a roll loaded from disk is re-derived (cheap: the director is pure) and drawn on demand.

import { direct, surprise, DirectorError, type DirectorInput, type DirectResult } from '../director/direct.ts';
import { buildTrackDigest, styleVector } from '../director/digest.ts';
import { extractTemplate, templateIdFor } from '../director/extract.ts';
import { rankTemplates, type DirectorModules, type TemplateScore } from '../director/match.ts';
import { projectConditions } from '../director/direct.ts';
import { walkRenderModules } from '../engine/core/project.ts';
import { frameStartTick, sourceToTimelineSeconds } from '../engine/core/time.ts';
import { MILKDROP_MODULE } from '../engine/modules/milkdrop.ts';
import { detectVocalSegments } from '../lyrics/vocal-segments.ts';
import { bakeArrangementCurves, planCurveBake, type CurveBakePlan } from '../project/automation-commands.ts';
import { applyDirection } from '../project/commands.ts';
import { aspectBucket, type DirectorRoll, type ProjectDocument } from '../project/document.ts';
import { newId } from '../project/ids.ts';
import type { SchemaLookup } from '../project/modulation-authoring.ts';
import { toRenderProject } from '../project/snapshot.ts';
import { loadPreset } from './milkdrop.ts';
import { moduleDefinitions } from './modules.ts';
import { thumbnailHost } from './preset-thumbnails.ts';
import { previewControls } from './components/CanvasPane.tsx';
import { useStudio, type StudioState } from './store.ts';

/** Why the director cannot run yet, in the panel's words; null when it can. */
export function directorBlocker(state: StudioState): string | null {
  if (state.audio === null) return 'Import a track first: the director works from its analysis.';
  if (state.analysisState === 'working') return 'Analysing the track…';
  if (state.analysis === null) return 'The track has not been analysed.';
  if (state.templates.length === 0) return 'No templates are installed.';
  return null;
}

function modulesOf(state: StudioState): DirectorModules {
  const all = moduleDefinitions(state.userModules).map((m) => m.manifest);
  const byId = new Map(all.map((m) => [m.id, m]));
  return { get: (id) => byId.get(id), all };
}

/** The title slot's text: the project's name, or the track's file name without its extension. */
function titleOf(state: StudioState): string {
  const name = state.document.name.trim();
  if (name !== '' && name !== 'Untitled') return name;
  const file = state.audio?.path.split(/[\\/]/).pop() ?? '';
  return file.replace(/\.[^.]+$/, '');
}

export function directorInput(state: StudioState, document: ProjectDocument = state.document): DirectorInput {
  const analysis = state.analysis;
  if (analysis === null) throw new DirectorError('The track has not been analysed.');
  const durationSeconds = state.audio?.durationSeconds ?? 0;
  const digest = buildTrackDigest({ analysis, durationSeconds, onsetTimes: state.onsetTimes, sections: state.sections, key: state.musicalKey });
  const vocals = analysis.sources.get('vocals')?.features.get('rms');
  return {
    document,
    templates: state.templates.map((t) => t.template),
    modules: modulesOf(state),
    digest,
    style: styleVector(digest),
    analysis,
    beats: analysis.beatGrid?.beats ?? [],
    onsets: state.onsetTimes,
    vocalSegments: vocals === undefined ? [] : detectVocalSegments(vocals.data, vocals.rate),
    title: titleOf(state),
    milkdropPresets: state.milkdropPresets,
    images: state.images,
    colourImage: state.autoColourSource,
  };
}

/** The picker's list: every template, best first, with its score and why. */
export function rankedTemplates(state: StudioState): TemplateScore[] {
  if (directorBlocker(state) !== null) return [];
  const input = directorInput(state);
  return rankTemplates(input.templates, input.style, projectConditions(state.document, state.analysis, input.title, input.milkdropPresets), input.modules, aspectBucket(state.document.canvas.width, state.document.canvas.height));
}

export type DirectorAction =
  | { readonly kind: 'generate'; readonly templateId: string | null }
  | { readonly kind: 'surprise' }
  | { readonly kind: 'restore'; readonly roll: DirectorRoll };

function freshSeed(): number {
  const word = new Uint32Array(1);
  crypto.getRandomValues(word);
  return 1 + ((word[0] as number) % 2_147_483_646);
}

/** Runs the director and applies the result as one command. Returns the result, or null on failure. */
export function runDirector(action: DirectorAction): DirectResult | null {
  const state = useStudio.getState();
  const blocker = directorBlocker(state);
  if (blocker !== null) {
    state.notify({ text: blocker, kind: 'warn' });
    return null;
  }
  try {
    const input = directorInput(state);
    let result: DirectResult;
    let label: string;
    if (action.kind === 'generate') {
      result = direct(input, { seed: state.document.seed, templateId: action.templateId });
      label = `Generate project (${result.template.name})`;
    } else if (action.kind === 'surprise') {
      result = surprise(input, { seed: freshSeed(), locks: state.autoLocks, roulette: state.autoRoulette });
      label = 'Surprise me';
    } else {
      result = direct(input, { seed: action.roll.seed, restore: action.roll });
      label = 'Restore roll';
    }
    state.run(applyDirection(result.document, label));
    // Show the result, not its first frame: a generated project fades in from black, so a stopped
    // playhead at 0:00 would greet the new look with a black preview. The loudest section is what
    // the thumbnail shows too.
    if (state.transport !== 'playing') previewControls.seek(momentSeconds(state, result.document));
    const kept = result.log.filter((e) => e.step === 'keep').length;
    state.notify({ text: `${result.roll.summary}${kept > 0 ? ` — kept ${kept} thing${kept === 1 ? '' : 's'} you edited` : ''}.`, kind: 'ok' });
    void drawRollThumbnail(result.roll, result.document);
    return result;
  } catch (error) {
    state.notify({ text: error instanceof Error ? error.message : String(error), kind: 'bad' });
    return null;
  }
}

/** The project as a template draft in the user's folder (§10 step 2). Returns what stayed behind. */
export async function extractAsTemplate(): Promise<readonly string[]> {
  const state = useStudio.getState();
  const blocker = directorBlocker(state);
  if (blocker !== null) {
    state.notify({ text: blocker, kind: 'warn' });
    return [];
  }
  try {
    const input = directorInput(state);
    // A name of its own: the file is never replaced, and a second id would shadow the first.
    const taken = new Set(state.templates.map((t) => t.template.id));
    const wanted = input.title.trim() || 'Untitled';
    let name = wanted;
    for (let n = 2; taken.has(templateIdFor(name)); n += 1) name = `${wanted} ${n}`;
    const id = templateIdFor(name);
    const { raw, issues, notes } = extractTemplate(input, { id, name });
    const path = await window.pulseforge.saveTemplate(id.replace(/^tpl\.user\./, ''), `${JSON.stringify(raw, null, 2)}\n`);
    await state.loadTemplates();
    const problems = issues.map((i) => `${i.path}: ${i.detail}`);
    state.notify({ text: `Saved the template "${name}" to ${path}.`, kind: problems.length > 0 ? 'warn' : 'ok' });
    return [...problems, ...notes];
  } catch (error) {
    state.notify({ text: error instanceof Error ? error.message : String(error), kind: 'bad' });
    return [];
  }
}

const schemasOf = (state: StudioState): SchemaLookup => {
  const modules = modulesOf(state);
  return (id) => modules.get(id);
};

/** What "Curves to keyframes" would do to this project. */
export function curveBakePlan(state: StudioState): CurveBakePlan {
  return planCurveBake(state.document, schemasOf(state));
}

/** One undo step. Returns what stayed a curve, and why. */
export function bakeCurves(): readonly string[] {
  const state = useStudio.getState();
  const schemas = schemasOf(state);
  const { bakes, skipped } = planCurveBake(state.document, schemas);
  if (bakes.length > 0) {
    state.run(bakeArrangementCurves(schemas, { newId }));
    state.notify({ text: `${bakes.length} curve target${bakes.length === 1 ? '' : 's'} became keyframes.`, kind: 'ok' });
  }
  return skipped.map((s) => `${s.label} stayed a curve: ${s.reason}.`);
}

/** A roll's identity for the thumbnail cache. */
export function rollKey(roll: DirectorRoll): string {
  return `${roll.templateId}|${roll.seeds.palette}|${roll.seeds.layout}|${roll.seeds.motion}|${roll.palette.join(',')}`;
}

let drawing: Promise<unknown> = Promise.resolve();
const pending = new Set<string>();

/** Draws a roll's thumbnail (once per session) into the store. */
export function drawRollThumbnail(roll: DirectorRoll, document?: ProjectDocument): Promise<void> {
  const key = rollKey(roll);
  if (useStudio.getState().rollThumbs[key] !== undefined || pending.has(key)) return Promise.resolve();
  pending.add(key);
  const job = drawing.then(async () => {
    try {
      const state = useStudio.getState();
      const host = thumbnailHost();
      if (host === null || state.analysis === null) return;
      // A roll from the saved history: re-derive its project (the director is pure) without applying it.
      const made = document ?? direct(directorInput(state), { seed: roll.seed, restore: roll }).document;
      const { project } = toRenderProject(made);
      const width = 192;
      const height = Math.max(2, Math.round((width * project.canvas.height) / project.canvas.width / 2) * 2);
      const small = { ...project, canvas: { ...project.canvas, width, height } };
      for (const layer of walkRenderModules(small.layers)) {
        const preset = layer.params['preset'];
        if (layer.module === MILKDROP_MODULE && typeof preset === 'string') await loadPreset(preset);
      }
      const frames = host.renderStills(small, state.analysis, [momentFrame(state, made)]);
      const pixels = frames?.[0];
      if (pixels === undefined) return;
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d');
      if (context === null) return;
      context.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
      const url = URL.createObjectURL(await canvas.convertToBlob({ type: 'image/png' }));
      useStudio.setState((s) => ({ rollThumbs: { ...s.rollThumbs, [key]: url } }));
    } catch {
      // A missing thumbnail is a blank tile, not an error worth a toast.
    } finally {
      pending.delete(key);
    }
  });
  drawing = job;
  return job;
}

/** The moment that shows a look best: the middle of the loudest section, or 40% in; timeline seconds. */
function momentSeconds(state: StudioState, document: ProjectDocument): number {
  const loudest = [...state.sections].sort((a, b) => b.energy - a.energy)[0];
  const placement = { leadInTicks: document.audio.leadInTicks, clipInTicks: document.audio.clipInTicks };
  return loudest === undefined
    ? (state.audio?.durationSeconds ?? 10) * 0.4
    : sourceToTimelineSeconds((loudest.startSeconds + loudest.endSeconds) / 2, placement);
}

/** That moment as a frame index of the document's own frame rate. */
function momentFrame(state: StudioState, document: ProjectDocument): number {
  const seconds = momentSeconds(state, document);
  const { fps } = document.canvas;
  let frame = Math.max(0, Math.floor((seconds * fps.num) / fps.den));
  // Guard against rounding past the requested time.
  while (frame > 0 && frameStartTick(frame, fps) > seconds * 48_000) frame -= 1;
  return frame;
}
