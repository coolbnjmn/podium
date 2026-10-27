// Card names from cmux tab titles (opt-in, local only). cmux keeps each Claude Code and Codex session in a workspace (a tab) the
// person titles; its hook file says which session runs in which workspace. One `cmux workspace list` every few seconds for the
// whole fleet gives the titles, so nothing is spawned per session or per request. A name shown here replaces the folder-based
// one only on the card and the activity feed; what the reporter sent is stored unchanged.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Logger } from '../logging/logger.js';

export const CMUX_BIN = '/Applications/cmux.app/Contents/Resources/bin/cmux';
export const NAMES_REFRESH_MS = 15_000;
const LIST_TIMEOUT_MS = 3000;
const LIST_MAX_BYTES = 1024 * 1024;
const HOOK_FILE_MAX_BYTES = 4 * 1024 * 1024;
const TITLE_MAX = 80;

/** What `cmux workspace list --json` printed for each window; rejects when cmux is missing, slow, or fails. */
export type ListRunner = () => Promise<string[]>;
/** The most windows read in one refresh. */
const MAX_WINDOWS = 8;

export function cmuxNamesOn(env: NodeJS.ProcessEnv): boolean {
  const v = (env.PODIUM_CMUX_NAMES ?? '').toLowerCase();
  return v === '1' || v === 'true';
}

/** The hook files cmux keeps: which session runs in which workspace, for Claude Code and for Codex. */
export function defaultHookFiles(home: string): string[] {
  return [path.join(home, '.cmuxterm', 'claude-hook-sessions.json'), path.join(home, '.cmuxterm', 'codex-hook-sessions.json')];
}

function execText(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: LIST_MAX_BYTES, encoding: 'utf8', windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/** The ids of the windows `cmux list-windows --json` printed. Throws on JSON that is not a list. */
export function parseWindowIds(text: string): string[] {
  const doc = JSON.parse(text) as unknown;
  if (!Array.isArray(doc)) throw new Error('no_windows_array');
  return doc.map((w) => (w as { id?: unknown } | null)?.id).filter((id): id is string => typeof id === 'string' && id !== '');
}

/**
 * Runs `cmux workspace list --json` in every window (it lists one window at a time). A cmux that cannot list its windows is
 * asked once, for the window it answers for by default.
 */
export function execList(bin: string, timeoutMs: number = LIST_TIMEOUT_MS): ListRunner {
  return async () => {
    const ids = await execText(bin, ['list-windows', '--json'], timeoutMs).then(parseWindowIds, () => [] as string[]);
    if (ids.length === 0) return [await execText(bin, ['workspace', 'list', '--json'], timeoutMs)];
    return Promise.all(ids.slice(0, MAX_WINDOWS).map((id) => execText(bin, ['workspace', 'list', '--json', '--window', id], timeoutMs)));
  };
}

/** A title fit to show: control characters out, trimmed, cut at TITLE_MAX. Null when nothing is left. */
export function cleanTitle(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const printable = Array.from(v, (c) => {
    const code = c.codePointAt(0) ?? 0;
    return code < 32 || code === 127 ? ' ' : c;
  }).join('');
  const t = printable.replaceAll(/\s+/g, ' ').trim();
  return t ? t.slice(0, TITLE_MAX) : null;
}

const key = (id: string) => id.toUpperCase();

/** Workspace id -> title, from the JSON `cmux workspace list --json` prints. The person's own title wins over cmux's. Throws on JSON that is not that shape. */
export function parseWorkspaceTitles(text: string): Map<string, string> {
  const doc = JSON.parse(text) as { workspaces?: unknown };
  if (!doc || !Array.isArray(doc.workspaces)) throw new Error('no_workspaces_array');
  const out = new Map<string, string>();
  for (const w of doc.workspaces as Record<string, unknown>[]) {
    if (!w || typeof w.id !== 'string') continue;
    const title = cleanTitle(w.custom_title) ?? cleanTitle(w.title);
    if (title) out.set(key(w.id), title);
  }
  return out;
}

/** Session id -> workspace id, from a cmux hook-sessions file. Throws on JSON that is not that shape. */
export function parseHookSessions(text: string): Map<string, string> {
  const doc = JSON.parse(text) as { sessions?: unknown };
  if (!doc || typeof doc.sessions !== 'object' || doc.sessions === null) throw new Error('no_sessions_object');
  const out = new Map<string, string>();
  for (const [id, s] of Object.entries(doc.sessions as Record<string, unknown>)) {
    const ws = (s as { workspaceId?: unknown } | null)?.workspaceId;
    if (typeof ws === 'string' && ws) out.set(id, key(ws));
  }
  return out;
}

interface HookCache {
  mtimeMs: number;
  size: number;
  sessions: Map<string, string>;
}

export interface NameSource {
  /** The cmux tab title of a session, or null when it is not known to cmux (or the feature has nothing yet). */
  titleFor(sessionId: string): string | null;
}

export class CmuxNames implements NameSource {
  private titles = new Map<string, string>();
  private readonly hooks = new Map<string, HookCache>();
  private busy = false;
  private lastFailure = new Map<string, string>();

  constructor(
    private readonly logger: Logger,
    private readonly runList: ListRunner,
    private readonly hookFiles: string[],
  ) {}

  titleFor(sessionId: string): string | null {
    for (const cache of this.hooks.values()) {
      const ws = cache.sessions.get(sessionId);
      if (ws) return this.titles.get(ws) ?? null;
    }
    return null;
  }

  /** One refresh: never overlaps another, and a failure keeps what was known. Resolves when done. */
  async refresh(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.refreshTitles();
      for (const file of this.hookFiles) this.refreshHooks(file);
    } finally {
      this.busy = false;
    }
  }

  start(intervalMs: number = NAMES_REFRESH_MS): () => void {
    void this.refresh();
    const timer = setInterval(() => void this.refresh(), intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  private async refreshTitles(): Promise<void> {
    try {
      const merged = new Map<string, string>();
      for (const text of await this.runList()) for (const [id, title] of parseWorkspaceTitles(text)) merged.set(id, title);
      this.titles = merged;
      this.lastFailure.delete('cmux');
    } catch (err) {
      this.failed('cmux', (err as Error).message);
    }
  }

  private refreshHooks(file: string): void {
    try {
      const st = fs.statSync(file);
      const have = this.hooks.get(file);
      if (have && have.mtimeMs === st.mtimeMs && have.size === st.size) return;
      if (st.size > HOOK_FILE_MAX_BYTES) throw new Error('hook_file_too_large');
      this.hooks.set(file, { mtimeMs: st.mtimeMs, size: st.size, sessions: parseHookSessions(fs.readFileSync(file, 'utf8')) });
      this.lastFailure.delete(file);
    } catch (err) {
      // A missing file is normal (Codex may not be installed): nothing is logged for it, and a rename or delete forgets its sessions.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.hooks.delete(file);
        return;
      }
      this.failed(file, (err as Error).message);
    }
  }

  /** One warning per source and reason until it recovers, so a broken file is not logged every few seconds. */
  private failed(source: string, reason: string): void {
    if (this.lastFailure.get(source) === reason) return;
    this.lastFailure.set(source, reason);
    this.logger.warn('cmux_names.refresh_failed', `podium: cmux tab names not refreshed (${source === 'cmux' ? 'cmux' : path.basename(source)}): ${reason}`, {
      source: source === 'cmux' ? 'cmux' : path.basename(source),
      reason: reason.slice(0, 200),
    });
  }
}

export function cmuxNamesFromEnv(env: NodeJS.ProcessEnv, logger: Logger, home: string = os.homedir()): CmuxNames | null {
  if (!cmuxNamesOn(env)) return null;
  return new CmuxNames(logger, execList(env.PODIUM_CMUX_BIN || CMUX_BIN), defaultHookFiles(home));
}
