import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

// ---------------------------------------------------------------------------
// Engine boundary (CLAUDE.md constraint 2, PROJECT.md §13).
//
// src/engine/ must stay pure, headless and deterministic: no Electron, no DOM,
// no React, no Node built-ins, nothing that reads the clock, the network or a
// random source. This is what keeps headless rendering, golden-frame tests and
// the CLI possible. tests/lint/engine-boundary.test.ts proves these rules fire.
// ---------------------------------------------------------------------------

const BOUNDARY = 'Engine boundary (CLAUDE.md #2):';

const NODE_BUILTINS = [
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'crypto', 'dgram',
  'diagnostics_channel', 'dns', 'events', 'fs', 'http', 'http2', 'https', 'inspector', 'module',
  'net', 'os', 'path', 'perf_hooks', 'process', 'querystring', 'readline', 'repl', 'stream',
  'string_decoder', 'timers', 'tls', 'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads',
  'zlib',
];

const engineRestrictedImports = {
  patterns: [
    {
      group: ['electron', 'electron/*'],
      message: `${BOUNDARY} the engine may not import Electron. Pass what it needs in through the render context.`,
    },
    {
      group: ['react', 'react/*', 'react-dom', 'react-dom/*'],
      message: `${BOUNDARY} the engine may not import React. UI lives in src/ui/.`,
    },
    {
      group: ['node:*', ...NODE_BUILTINS, ...NODE_BUILTINS.map((m) => `${m}/*`)],
      message: `${BOUNDARY} the engine runs headless in a browser context and may not import Node built-ins. File, process and network access belong to the shell.`,
    },
    {
      group: ['**/shell', '**/shell/**', '**/ui', '**/ui/**', '**/export', '**/export/**', '**/ml', '**/ml/**'],
      message: `${BOUNDARY} the engine may not depend on shell/, ui/, export/ or ml/ — those depend on the engine, never the reverse.`,
    },
  ],
};

const TIME = 'reads wall-clock time; time must come in as a parameter (`t` / frameIndex).';
const engineRestrictedGlobals = [
  ...['window', 'self', 'globalThis', 'document', 'navigator', 'location', 'localStorage',
    'sessionStorage', 'indexedDB'].map((name) => ({
    name,
    message: `${BOUNDARY} \`${name}\` is a host/DOM global; the engine must not reach outside its render context.`,
  })),
  ...['Date', 'performance'].map((name) => ({ name, message: `${BOUNDARY} \`${name}\` ${TIME}` })),
  ...['requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'setTimeout',
    'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate'].map((name) => ({
    name,
    message: `${BOUNDARY} \`${name}\` schedules work on the wall clock; the engine is called with an explicit time.`,
  })),
  ...['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'].map((name) => ({
    name,
    message: `${BOUNDARY} \`${name}\` is network access; assets arrive resolved through params (module-spec §7 rule 4).`,
  })),
  {
    name: 'crypto',
    message: `${BOUNDARY} \`crypto\` is a non-deterministic random source here; use the seeded PRNG (and an engine-local hash).`,
  },
  ...['AudioContext', 'OfflineAudioContext', 'AnalyserNode'].map((name) => ({
    name,
    message: `${BOUNDARY} \`${name}\` is live audio; audio data comes only from the precomputed AnalysisCache.`,
  })),
  ...['process', 'require', 'Buffer', '__dirname', '__filename'].map((name) => ({
    name,
    message: `${BOUNDARY} \`${name}\` is a Node global; the engine must run headless in a browser context.`,
  })),
];

const NO_DEFAULT_EXPORTS = [
  {
    selector: 'ExportDefaultDeclaration',
    message: 'Named exports only (CLAUDE.md conventions).',
  },
  {
    selector: 'ExportNamedDeclaration > ExportSpecifier[exported.name="default"]',
    message: 'Named exports only (CLAUDE.md conventions).',
  },
];

export default defineConfig(
  {
    ignores: ['vendor/', 'node_modules/', 'dist/', 'build/', 'out/', 'release/', 'coverage/'],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs}'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', URL: 'readonly' },
    },
  },
  {
    files: ['src/**/*.ts', 'setup/**/*.{ts,mjs}', 'spike/**/*.ts', 'tests/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...NO_DEFAULT_EXPORTS],
      '@typescript-eslint/consistent-type-imports': 'error',
      // `_`-prefixed names are deliberately unused (e.g. dropping a field via rest destructuring).
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }],
    },
  },
  {
    files: ['src/engine/**/*.ts'],
    rules: {
      // The typescript-eslint variant also catches `import type` and `import x = require()`.
      '@typescript-eslint/no-restricted-imports': ['error', engineRestrictedImports],
      'no-restricted-globals': ['error', ...engineRestrictedGlobals],
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: `${BOUNDARY} \`Math.random\` is not reproducible; derive randomness from the seeded PRNG: hash(seed, layerId, index).`,
        },
      ],
      'no-restricted-syntax': [
        'error',
        ...NO_DEFAULT_EXPORTS,
        {
          selector: 'ImportExpression',
          message: `${BOUNDARY} no dynamic import(); module loading is the host's job, and it would bypass these import rules.`,
        },
      ],
    },
  },
);
