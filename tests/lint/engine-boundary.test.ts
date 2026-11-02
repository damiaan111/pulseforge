import { join, resolve } from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// Proves the engine boundary in eslint.config.js actually fires. The rules are
// load-bearing (CLAUDE.md constraint 2): a typo in a glob would silently turn the
// boundary off, and nothing else would notice until a violation had spread.

const ROOT = resolve(import.meta.dirname, '..', '..');
const eslint = new ESLint({ cwd: ROOT });

async function lint(relativePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: join(ROOT, relativePath) });
  if (result === undefined) throw new Error('ESLint returned no result');
  return result.messages.map((m) => `${m.ruleId ?? 'fatal'}: ${m.message}`);
}

const ENGINE_FILE = 'src/engine/core/__boundary_fixture__.ts';

describe('engine boundary', () => {
  const forbidden: Array<[string, string, string]> = [
    ['Electron import', `import { ipcRenderer } from 'electron';\nexport const x = ipcRenderer;`, 'no-restricted-imports'],
    ['React import', `import { useState } from 'react';\nexport const x = useState;`, 'no-restricted-imports'],
    ['type-only Electron import', `import type { BrowserWindow } from 'electron';\nexport type X = BrowserWindow;`, 'no-restricted-imports'],
    ['node: built-in', `import { readFileSync } from 'node:fs';\nexport const x = readFileSync;`, 'no-restricted-imports'],
    ['bare built-in', `import { join } from 'path';\nexport const x = join;`, 'no-restricted-imports'],
    ['import from shell/', `import { x } from '../../shell/ipc.ts';\nexport const y = x;`, 'no-restricted-imports'],
    ['import from ui/', `import { x } from '../../ui/panel.ts';\nexport const y = x;`, 'no-restricted-imports'],
    ['dynamic import', `export const load = () => import('./other.ts');`, 'no-restricted-syntax'],
    ['Date.now()', `export const now = () => Date.now();`, 'no-restricted-globals'],
    ['new Date()', `export const d = () => new Date();`, 'no-restricted-globals'],
    ['performance.now()', `export const now = () => performance.now();`, 'no-restricted-globals'],
    ['Math.random()', `export const r = () => Math.random();`, 'no-restricted-properties'],
    ['requestAnimationFrame', `export const f = () => requestAnimationFrame(() => {});`, 'no-restricted-globals'],
    ['setTimeout', `export const f = () => setTimeout(() => {}, 1);`, 'no-restricted-globals'],
    ['document', `export const c = () => document.createElement('canvas');`, 'no-restricted-globals'],
    ['window', `export const w = () => window.innerWidth;`, 'no-restricted-globals'],
    ['globalThis escape hatch', `export const p = () => globalThis.performance;`, 'no-restricted-globals'],
    ['fetch', `export const f = () => fetch('x');`, 'no-restricted-globals'],
    ['crypto.getRandomValues', `export const f = () => crypto.getRandomValues(new Uint8Array(4));`, 'no-restricted-globals'],
    ['AnalyserNode', `export type A = AnalyserNode;\nexport const make = (c: BaseAudioContext) => new AnalyserNode(c);`, 'no-restricted-globals'],
    ['process', `export const env = () => process.env;`, 'no-restricted-globals'],
    ['default export', `export default function render() {}`, 'no-restricted-syntax'],
  ];

  it.each(forbidden)('rejects %s inside src/engine/', async (_name, code, rule) => {
    const messages = await lint(ENGINE_FILE, code);
    expect(messages.some((m) => m.includes(rule))).toBe(true);
  });

  it('allows pure, deterministic engine code', async () => {
    const code = [
      `import { mix } from './math.ts';`,
      `import type { Rational } from './time.ts';`,
      `export function frameTime(n: number, fps: Rational): number {`,
      `  return (n * fps.den) / fps.num;`,
      `}`,
      `export function blend(a: number, b: number, gl: WebGL2RenderingContext): number {`,
      `  void gl;`,
      `  return mix(a, b, Math.sin(0.5));`,
      `}`,
    ].join('\n');
    expect(await lint(ENGINE_FILE, code)).toEqual([]);
  });

  it('does not apply engine rules outside src/engine/', async () => {
    const code = `import { readFileSync } from 'node:fs';\nexport const read = () => [readFileSync, Date.now()];`;
    expect(await lint('src/shell/__boundary_fixture__.ts', code)).toEqual([]);
  });

  it('applies to nested engine folders', async () => {
    const messages = await lint('src/engine/modules/bars/__fixture__.ts', `export const r = () => Math.random();`);
    expect(messages.some((m) => m.includes('no-restricted-properties'))).toBe(true);
  });
});

// The studio runs sandboxed with no Node integration (src/shell/main.ts). The app build also
// catches this — the renderer is bundled with platform: 'browser' — but a sentence at edit time
// beats a resolver error at bundle time, and a typo in the glob would turn the rule off silently.
describe('renderer boundary', () => {
  const UI_FILE = 'src/ui/__boundary_fixture__.ts';

  const forbidden: Array<[string, string]> = [
    ['node: built-in', `import { readFileSync } from 'node:fs';\nexport const x = readFileSync;`],
    ['bare built-in', `import { join } from 'path';\nexport const x = join;`],
    ['Electron directly', `import { ipcRenderer } from 'electron';\nexport const x = ipcRenderer;`],
    ['the main process', `import { readProjectText } from '../shell/project-io.ts';\nexport const x = readProjectText;`],
  ];

  it.each(forbidden)('rejects %s inside src/ui/', async (_name, code) => {
    const messages = await lint(UI_FILE, code);
    expect(messages.some((m) => m.includes('no-restricted-imports'))).toBe(true);
  });

  it('allows the shared IPC types and the pure project and engine code', async () => {
    const code = [
      `import type { PulseforgeApi } from '../shell/ipc.ts';`,
      `import { loadDocument } from '../project/load.ts';`,
      `import { ticksToSeconds } from '../engine/core/time.ts';`,
      `export function open(api: PulseforgeApi, text: string): number {`,
      `  void api;`,
      `  return ticksToSeconds(loadDocument(text).document.audio.durationTicks);`,
      `}`,
    ].join('\n');
    expect(await lint(UI_FILE, code)).toEqual([]);
  });

  it('does not apply renderer rules to the main process, which needs Node', async () => {
    const code = `import { readFileSync } from 'node:fs';\nexport const read = () => readFileSync('x', 'utf8');`;
    expect(await lint('src/shell/__boundary_fixture__.ts', code)).toEqual([]);
  });
});
