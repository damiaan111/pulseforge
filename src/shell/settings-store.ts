// User settings on disk (PROJECT.md §8.16, data-formats §6).
//
// A versioned JSON file in the user data folder, never in the repo, read defensively and written
// atomically. The first setting that needed a home is tap latency (lyrics-spec §3, D33: global,
// stored in settings, re-calibratable — latency is a property of the person and the keyboard, not
// of a project). The settings screen (M36) will add the rest here, on the same discipline:
//
//  - Every field has a default, so a missing or partly written file still yields usable settings.
//  - A field with a wrong type is dropped back to its default and reported, never trusted.
//  - Fields this version does not know are **kept** and written back, so a newer build's settings
//    survive a round trip through this one (the same rule as the project format).
//  - A newer `version` than this build understands is read for what it recognises and **never
//    written over**: saving refuses rather than downgrading someone's file.
//
// Plain Node, no Electron: tested directly, used by the main process.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { renameIntoPlace, tempPathFor } from '../node/rename-into-place.ts';

export const SETTINGS_VERSION = 1;

export interface Settings {
  /**
   * How late this person taps, in milliseconds (lyrics-spec §3). Subtracted from every tap in
   * tap-to-sync. Null until calibrated.
   */
  readonly tapLatencyMs: number | null;
}

export const DEFAULT_SETTINGS: Settings = { tapLatencyMs: null };

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
    const latency = record['tapLatencyMs'];
    let tapLatencyMs: number | null = null;
    if (typeof latency === 'number' && Number.isFinite(latency) && latency >= -500 && latency <= 1000) tapLatencyMs = latency;
    else if (latency !== undefined && latency !== null) problems.push(`tapLatencyMs ${JSON.stringify(latency)} is not a sensible latency; not calibrated`);
    const extra: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) if (key !== 'version' && key !== 'tapLatencyMs') extra[key] = value;
    return { settings: { tapLatencyMs }, problems, extra, readOnly: version > SETTINGS_VERSION };
  }

  /** Merges a patch into what is on disk and writes it atomically. */
  async update(patch: Partial<Settings>): Promise<Settings> {
    const current = await this.read();
    if (current.readOnly) {
      throw new Error('The settings file was written by a newer version of Pulseforge; it is left as it is. Update Pulseforge to change settings.');
    }
    const settings: Settings = { ...current.settings, ...patch };
    const json = `${JSON.stringify({ ...current.extra, version: SETTINGS_VERSION, ...settings }, null, 2)}\n`;
    await mkdir(dirname(this.path), { recursive: true });
    const temp = tempPathFor(this.path);
    await writeFile(temp, json, 'utf8');
    await renameIntoPlace(temp, this.path);
    return settings;
  }
}
