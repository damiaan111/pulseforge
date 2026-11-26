// User settings on disk (PROJECT.md §8.16, M36, data-formats §6).
//
// A versioned JSON file in the user data folder, never in the repo, read defensively and written
// atomically. The first setting that needed a home was tap latency (lyrics-spec §3, D33); the
// settings screen (M36) brought the rest, on the same discipline:
//
//  - Every field has a default, so a missing or partly written file still yields usable settings.
//  - A field with a wrong type or an out-of-range value falls back to its default and is reported,
//    never trusted. The same rules check a patch from the studio, which is refused outright
//    instead: a bad value typed into the screen deserves an error, not a silent default.
//  - Fields this version does not know are **kept** and written back, so a newer build's settings
//    survive a round trip through this one (the same rule as the project format).
//  - A newer `version` than this build understands is read for what it recognises and **never
//    written over**: saving refuses rather than downgrading someone's file.
//
// Adding a field is not a breaking change (data-formats §2.3), so the version stays 1.
//
// Plain Node, no Electron: tested directly, used by the main process.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';

import { renameIntoPlace, tempPathFor } from '../node/rename-into-place.ts';

export const SETTINGS_VERSION = 1;

export const THEMES = ['dark', 'light', 'system'] as const;
export const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const;
export const PREVIEW_SCALES = [0.25, 0.5, 0.75, 1] as const;

export interface Settings {
  /**
   * How late this person taps, in milliseconds (lyrics-spec §3). Subtracted from every tap in
   * tap-to-sync. Null until calibrated.
   */
  readonly tapLatencyMs: number | null;
  /** How often unsaved work is snapshotted (M1), minutes. */
  readonly autosaveMinutes: number;
  /** The preview's resolution scale a session starts with. */
  readonly previewScale: number;
  readonly theme: (typeof THEMES)[number];
  /** The stem model new projects use (D8: fast by default, `htdemucs_ft` one click away). */
  readonly stemModel: string;
  /** The Whisper model folder under models/whisper used for transcription (M26). */
  readonly whisperModel: string;
  /** The export preset the dialog opens on; null for the first. */
  readonly defaultExportPreset: string | null;
  readonly logLevel: (typeof LOG_LEVELS)[number];
  /** Where every rebuildable cache lives (M33); null for the default beside the app. */
  readonly cacheRoot: string | null;
  /** Least-recently-used entries are evicted above this, gigabytes; 0 for no ceiling. */
  readonly cacheCeilingGb: number;
  /** Warn when the cache drive has less free space than this, gigabytes; 0 to never warn. */
  readonly lowDiskWarningGb: number;
  /** Temporary files during separation and rendering; null for `<cache root>/scratch`. */
  readonly scratchDir: string | null;
  /** Remapped keys by action (src/ui/shortcuts.ts); an action not here keeps its default. */
  readonly shortcuts: Readonly<Record<string, string>>;
}

export const DEFAULT_SETTINGS: Settings = {
  tapLatencyMs: null,
  autosaveMinutes: 1,
  previewScale: 1,
  theme: 'dark',
  stemModel: 'htdemucs',
  whisperModel: 'faster-whisper-medium',
  defaultExportPreset: null,
  logLevel: 'info',
  cacheRoot: null,
  cacheCeilingGb: 20,
  lowDiskWarningGb: 5,
  scratchDir: null,
  shortcuts: {},
};

type Check = (value: unknown) => string | null;

const number = (min: number, max: number, unit = ''): Check => (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? null : `must be a number from ${min} to ${max}${unit}`;
const oneOf = (options: readonly (string | number)[]): Check => (value) =>
  (options as readonly unknown[]).includes(value) ? null : `must be one of ${options.join(', ')}`;
const name: Check = (value) => (typeof value === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(value) ? null : 'must be a model name');
const nullable = (check: Check): Check => (value) => (value === null ? null : check(value));
const absolutePath: Check = (value) => (typeof value === 'string' && value.length < 1024 && isAbsolute(value) ? null : 'must be an absolute folder path');

/** One validator per field: the file's rules and the studio's patches share them. */
const CHECKS: { readonly [K in keyof Settings]: Check } = {
  tapLatencyMs: nullable(number(-500, 1000, ' ms')),
  autosaveMinutes: number(1, 30, ' minutes'),
  previewScale: oneOf(PREVIEW_SCALES),
  theme: oneOf(THEMES),
  stemModel: name,
  whisperModel: name,
  defaultExportPreset: nullable(name),
  logLevel: oneOf(LOG_LEVELS),
  cacheRoot: nullable(absolutePath),
  cacheCeilingGb: number(0, 10_000, ' GB'),
  lowDiskWarningGb: number(0, 1000, ' GB'),
  scratchDir: nullable(absolutePath),
  shortcuts: (value) => (typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.entries(value).length <= 64 && Object.entries(value).every(([action, key]) => /^[A-Za-z]{1,40}$/.test(action) && typeof key === 'string' && key.length > 0 && key.length <= 20)
    ? null : 'must map actions to keys'),
};

const KEYS = Object.keys(CHECKS) as (keyof Settings)[];

/**
 * A patch from the studio, checked field by field. Unknown keys and bad values are refused with
 * the reason — the screen shows it next to the control that sent it.
 */
export function validateSettingsPatch(raw: unknown): Partial<Settings> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('Settings must be an object.');
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const check = CHECKS[key as keyof Settings];
    if (check === undefined) throw new Error(`"${key}" is not a setting.`);
    const problem = check(value);
    if (problem !== null) throw new Error(`${key} ${problem}.`);
    out[key] = value;
  }
  return out as Partial<Settings>;
}

export interface SettingsFile {
  readonly settings: Settings;
  /** Problems reading the file, in plain language; empty when it was fine or absent. */
  readonly problems: readonly string[];
  /** Keys this version does not know, kept verbatim. */
  readonly extra: Readonly<Record<string, unknown>>;
  /** True when the file was written by a newer build: it is read, and not saved over. */
  readonly readOnly: boolean;
}

export class SettingsStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async read(): Promise<SettingsFile> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch {
      return { settings: DEFAULT_SETTINGS, problems: [], extra: {}, readOnly: false };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { settings: DEFAULT_SETTINGS, problems: ['The settings file is not valid JSON; defaults are used until settings are saved again.'], extra: {}, readOnly: false };
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { settings: DEFAULT_SETTINGS, problems: ['The settings file is not an object; defaults are used.'], extra: {}, readOnly: false };
    }
    const record = raw as Record<string, unknown>;
    const problems: string[] = [];
    const version = typeof record['version'] === 'number' ? record['version'] : 0;
    const settings: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    for (const key of KEYS) {
      const value = record[key];
      if (value === undefined) continue;
      const problem = CHECKS[key](value);
      if (problem === null) settings[key] = value;
      else problems.push(`${key} ${JSON.stringify(value)} ${problem}; the default is used`);
    }
    const extra: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) if (key !== 'version' && !(KEYS as string[]).includes(key)) extra[key] = value;
    return { settings: settings as unknown as Settings, problems, extra, readOnly: version > SETTINGS_VERSION };
  }

  /** Merges a patch into what is on disk and writes it atomically. */
  async update(patch: Partial<Settings>): Promise<Settings> {
    const current = await this.read();
    if (current.readOnly) {
      throw new Error('The settings file was written by a newer version of Pulseforge; it is left as it is. Update Pulseforge to change settings.');
    }
    const settings: Settings = { ...current.settings, ...validateSettingsPatch(patch) };
    const json = `${JSON.stringify({ ...current.extra, version: SETTINGS_VERSION, ...settings }, null, 2)}\n`;
    await mkdir(dirname(this.path), { recursive: true });
    const temp = tempPathFor(this.path);
    await writeFile(temp, json, 'utf8');
    await renameIntoPlace(temp, this.path);
    return settings;
  }
}
