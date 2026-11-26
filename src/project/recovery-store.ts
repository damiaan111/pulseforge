// Autosave and crash recovery on disk (M1, ui-spec §10).
//
// Each run of the studio is a **session**, with its own folder of recovery snapshots:
//
//   <root>/<sessionId>/session.json          which project, when, why the last snapshot was taken
//   <root>/<sessionId>/<n>.pvproj            the rolling snapshots, newest highest, the last few kept
//
// A clean quit deletes the session's folder, and so does a normal save (the file on disk is then
// the newest state). So a folder that is still there at the next start belongs to a run that ended
// without either — a crash, a killed process, a power cut — and its newest snapshot is offered
// back. Snapshots are written atomically, so the one offered is never half a file.
//
// Plain Node, no Electron: tested directly, used by the main process.

import { rmSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { renameIntoPlace, tempPathFor } from '../node/rename-into-place.ts';

/** How many snapshots a session keeps: enough to step back past a bad autosave, few enough to be small. */
export const SNAPSHOTS_KEPT = 5;

export interface SessionInfo {
  readonly sessionId: string;
  /** The file the project was opened from or saved to; null for a project never saved. */
  readonly projectPath: string | null;
  readonly projectName: string;
  readonly startedAt: string;
  readonly savedAt: string;
  /** Why the newest snapshot was taken: "interval", "before applying a preset", … */
  readonly reason: string;
}

export interface RecoverableSession extends SessionInfo {
  readonly snapshots: number;
}

export interface RecoveryStoreOptions {
  readonly root: string;
  readonly now?: () => string;
}

export class RecoveryStore {
  private readonly root: string;
  private readonly now: () => string;

  constructor(options: RecoveryStoreOptions) {
    this.root = options.root;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** Writes a snapshot of the project for this session, keeping the newest `SNAPSHOTS_KEPT`. */
  async write(
    sessionId: string,
    snapshot: { readonly text: string; readonly projectPath: string | null; readonly projectName: string; readonly reason: string },
  ): Promise<void> {
    const dir = this.sessionDir(sessionId);
    await mkdir(dir, { recursive: true });
    const numbers = await snapshotNumbers(dir);
    const next = (numbers.at(-1) ?? 0) + 1;
    await writeAtomic(join(dir, `${next}.pvproj`), snapshot.text);

    const previous = await this.readSession(sessionId);
    const info: SessionInfo = {
      sessionId,
      projectPath: snapshot.projectPath,
      projectName: snapshot.projectName,
      startedAt: previous?.startedAt ?? this.now(),
      savedAt: this.now(),
      reason: snapshot.reason,
    };
    await writeAtomic(join(dir, 'session.json'), `${JSON.stringify(info, null, 2)}\n`);

    for (const old of numbers.slice(0, Math.max(0, numbers.length + 1 - SNAPSHOTS_KEPT))) {
      await rm(join(dir, `${old}.pvproj`), { force: true });
    }
  }

  /** The session ended well — a clean quit, or everything saved: nothing to recover. */
  async clear(sessionId: string): Promise<void> {
    await rm(this.sessionDir(sessionId), { recursive: true, force: true });
  }

  /** The same, synchronously — for the last moment of a clean quit, which cannot wait for a promise. */
  clearSync(sessionId: string): void {
    rmSync(this.sessionDir(sessionId), { recursive: true, force: true });
  }

  /**
   * Sessions other than `currentSessionId` that left snapshots behind, newest first. A folder that
   * cannot be read is skipped rather than failing the whole list: one damaged session must not
   * hide another that is fine.
   */
  async listRecoverable(currentSessionId: string): Promise<readonly RecoverableSession[]> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch {
      return [];
    }
    const sessions: RecoverableSession[] = [];
    for (const name of names) {
      // Anything else in the folder (a stray file, a temp) is not a session.
      if (name === currentSessionId || !/^[0-9A-Za-z_-]{1,64}$/.test(name)) continue;
      const info = await this.readSession(name);
      const snapshots = (await snapshotNumbers(this.sessionDir(name))).length;
      if (info === null || snapshots === 0) continue;
      sessions.push({ ...info, snapshots });
    }
    return sessions.sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0));
  }

  /** The newest snapshot of a session, as project text. */
  async readLatest(sessionId: string): Promise<string> {
    const numbers = await snapshotNumbers(this.sessionDir(sessionId));
    const newest = numbers.at(-1);
    if (newest === undefined) throw new Error('There is nothing to recover from that session.');
    return readFile(join(this.sessionDir(sessionId), `${newest}.pvproj`), 'utf8');
  }

  private sessionDir(sessionId: string): string {
    // The id becomes a folder name: accept only what `newId` produces.
    if (!/^[0-9A-Za-z_-]{1,64}$/.test(sessionId)) throw new Error(`"${sessionId}" is not a recovery session id.`);
    return join(this.root, sessionId);
  }

  private async readSession(sessionId: string): Promise<SessionInfo | null> {
    try {
      const parsed = JSON.parse(await readFile(join(this.sessionDir(sessionId), 'session.json'), 'utf8')) as SessionInfo;
      return typeof parsed.savedAt === 'string' ? parsed : null;
    } catch {
      return null;
    }
  }
}

async function snapshotNumbers(dir: string): Promise<number[]> {
  try {
    return (await readdir(dir))
      .map((name) => /^(\d+)\.pvproj$/.exec(name)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const temp = tempPathFor(path);
  await writeFile(temp, text, 'utf8');
  await renameIntoPlace(temp, path);
}
