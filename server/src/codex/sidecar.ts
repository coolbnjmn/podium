// Codex sidecar: follows the rollout files Codex writes under ~/.codex/sessions and reports each session to the local Podium server,
// so Codex sessions sit on the wall next to Claude Code ones. Off unless PODIUM_CODEX=1. Local only: it reads files Codex already
// writes and posts to the server in PODIUM_URL (default http://127.0.0.1:4317). It never changes Codex or cmux, and it keeps no
// prompt or response text. Run: `PODIUM_CODEX=1 node server/dist/codex/sidecar.js` (docs/CODEX.md).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CMUX_BIN, CmuxNames, defaultHookFiles, execList } from '../fleet/cmuxNames.js';
import type { Report } from '../fleet/protocol.js';
import { createLogger, type Logger } from '../logging/logger.js';
import { ACTIVE_WINDOW_MS, buildReports, isHeadless, type RunInfo } from './cards.js';
import { RolloutFile } from './rollout.js';

export const POLL_MS = 5000;
/** How often the folders are listed for new rollout files (reading the ones already known happens every poll). */
export const DISCOVER_MS = 30_000;
/** The most rollout files followed at once, and the most bytes read from all of them in one poll. */
export const MAX_FILES = 200;
export const POLL_BYTES = 8 * 1024 * 1024;
/** Days of date folders listed: a session started two days ago can still be going. */
const DATE_DIRS = 3;
const INDEX_MAX_BYTES = 4 * 1024 * 1024;
const POST_TIMEOUT_MS = 5000;
const BACKOFF_MS = 60_000;
const PROCESS_TRIES = 3;
const PROCESS_RETRY_MS = 60_000;

export interface SidecarConfig {
  enabled: boolean;
  url: string;
  token: string | null;
  userName: string | null;
  sessionsDir: string;
  indexFile: string;
  home: string;
}

/** `KEY=value` lines of a podiumctl config file; comments and blank lines skipped. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith('#')) out[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

export function configFromEnv(env: NodeJS.ProcessEnv, home: string = os.homedir()): SidecarConfig {
  let file: Record<string, string> = {};
  try {
    file = parseEnvFile(fs.readFileSync(path.join(home, '.podium', 'config.env'), 'utf8'));
  } catch {
    // No config file: the environment has to carry the token, or the server takes none.
  }
  const v = (env.PODIUM_CODEX ?? '').toLowerCase();
  return {
    enabled: v === '1' || v === 'true',
    url: (env.PODIUM_URL || `http://127.0.0.1:${env.PODIUMCTL_PORT || file.PODIUMCTL_PORT || '4317'}`).replace(/\/+$/, ''),
    token: env.PODIUM_TOKEN || file.PODIUM_TOKEN || null,
    userName: env.PODIUM_USER || null,
    sessionsDir: env.PODIUM_CODEX_DIR || path.join(home, '.codex', 'sessions'),
    indexFile: path.join(path.dirname(env.PODIUM_CODEX_DIR || path.join(home, '.codex', 'sessions')), 'session_index.jsonl'),
    home,
  };
}

/** Finds the cmux tab a Codex session runs in from its process, for a session cmux's hook file does not list. */
export type ProcessTabLookup = (startedAt: number) => Promise<string | null>;

function execText(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 3000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/** Whether a command line is a Codex that someone sits in (not an exec run, the app server, a sandbox helper or the MCP helper). */
export function isInteractiveCodex(command: string): boolean {
  const exe = command.split(' ')[0] ?? '';
  if (exe !== 'codex' && !exe.endsWith('/codex')) return false;
  return !/\s(exec|app-server|sandbox|mcp-server|proto)(\s|$)/.test(command);
}

/** The processes that look like an interactive Codex, with when each started. One `ps` call; nothing but the command line is read. */
export function parsePs(text: string): { pid: string; startedAt: number; command: string }[] {
  const out: { pid: string; startedAt: number; command: string }[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\w{3} \w{3}\s+\d+ \d\d:\d\d:\d\d \d{4})\s+(.*)$/.exec(line);
    if (!m) continue;
    const at = Date.parse(m[2]!);
    if (Number.isFinite(at) && isInteractiveCodex(m[3]!)) out.push({ pid: m[1]!, startedAt: at, command: m[3]! });
  }
  return out;
}

/** The workspace id in a `ps eww` line (the one environment variable read), or null. */
export function workspaceIdIn(text: string): string | null {
  return /CMUX_WORKSPACE_ID=([0-9A-Fa-f-]{36})/.exec(text)?.[1] ?? null;
}

export function processTabLookup(names: CmuxNames, toleranceMs = 30_000): ProcessTabLookup {
  return async (startedAt) => {
    const procs = parsePs(await execText('ps', ['-axo', 'pid=,lstart=,command=']));
    const hit = procs.find((p) => Math.abs(p.startedAt - startedAt) <= toleranceMs);
    if (!hit) return null;
    const ws = workspaceIdIn(await execText('ps', ['eww', '-p', hit.pid]));
    return ws ? names.titleOfWorkspace(ws) : null;
  };
}

interface Tracked {
  file: RolloutFile;
  mtimeMs: number;
}

export interface SidecarDeps {
  config: SidecarConfig;
  logger: Logger;
  fetch: typeof fetch;
  /** cmux tab titles for session ids. */
  names: { titleFor(sessionId: string): string | null; refresh?: () => Promise<void> };
  now: () => number;
  /** Optional: where an interactive session cmux's hook file does not list runs. */
  processTab?: ProcessTabLookup;
}

export interface TickResult {
  files: number;
  reports: number;
  posted: number;
  failed: number;
  skipped: 'backoff' | null;
}

export class Sidecar {
  private readonly tracked = new Map<string, Tracked>();
  private lastDiscover = 0;
  private backoffUntil = 0;
  private busy = false;
  private down = false;
  private refused = false;
  private readonly threadNames = new Map<string, string>();
  private indexStat: { mtimeMs: number; size: number } | null = null;
  private readonly tabBySession = new Map<string, { tab: string | null; tries: number; at: number }>();

  constructor(private readonly deps: SidecarDeps) {}

  /** One pass: find files, read what was appended, build the cards and post them. Never overlaps itself and never throws. */
  async tick(): Promise<TickResult> {
    const none: TickResult = { files: this.tracked.size, reports: 0, posted: 0, failed: 0, skipped: null };
    if (this.busy) return none;
    this.busy = true;
    try {
      const now = this.deps.now();
      if (now < this.backoffUntil) return { ...none, skipped: 'backoff' };
      if (now - this.lastDiscover >= DISCOVER_MS) {
        this.lastDiscover = now;
        this.discover(now);
        this.readIndex();
        await this.deps.names.refresh?.();
      }
      this.readFiles();
      const runs = await this.runs(now);
      const reports = buildReports(runs, now);
      let posted = 0;
      let failed = 0;
      for (const r of reports) {
        if (await this.post(r)) posted++;
        else failed++;
        if (this.deps.now() < this.backoffUntil) break;
      }
      return { files: this.tracked.size, reports: reports.length, posted, failed, skipped: null };
    } catch (err) {
      this.deps.logger.error('codex_sidecar.tick_failed', 'codex sidecar: a pass failed', { reason: String((err as Error)?.message ?? err).slice(0, 200) });
      return none;
    } finally {
      this.busy = false;
    }
  }

  start(): () => void {
    void this.tick();
    const timer = setInterval(() => void this.tick(), POLL_MS);
    return () => clearInterval(timer);
  }

  /** Lists the newest date folders for rollout files written within the window, up to MAX_FILES, and forgets ones that are gone or old. */
  private discover(now: number): void {
    const dirs: string[] = [];
    for (let i = 0; i < DATE_DIRS; i++) {
      const d = new Date(now - i * 86_400_000);
      dirs.push(path.join(this.deps.config.sessionsDir, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')));
    }
    const seen = new Set<string>();
    for (const dir of dirs) {
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!/^rollout-.*\.jsonl$/.test(name)) continue;
        const file = path.join(dir, name);
        try {
          const st = fs.statSync(file);
          if (now - st.mtimeMs > ACTIVE_WINDOW_MS) continue;
          seen.add(file);
          const have = this.tracked.get(file);
          if (have) have.mtimeMs = st.mtimeMs;
          else if (this.tracked.size < MAX_FILES) this.tracked.set(file, { file: new RolloutFile(file), mtimeMs: st.mtimeMs });
        } catch {
          // A file that vanished between the listing and the stat is just not there.
        }
      }
    }
    // A file still being followed keeps being read even if its date folder has aged out of the list; one gone or idle for the window is dropped.
    for (const [file, t] of this.tracked) {
      if (seen.has(file)) continue;
      if (now - t.mtimeMs > ACTIVE_WINDOW_MS || !fs.existsSync(file)) this.tracked.delete(file);
    }
  }

  /** Thread names from Codex's index: one read, only when the file changed. A missing or garbled file leaves the names as they were. */
  private readIndex(): void {
    const file = this.deps.config.indexFile;
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const st = fs.fstatSync(fd);
        if (this.indexStat && this.indexStat.mtimeMs === st.mtimeMs && this.indexStat.size === st.size) return;
        if (st.size > INDEX_MAX_BYTES) throw new Error('index_too_large');
        const text = fs.readFileSync(fd, 'utf8');
        this.indexStat = { mtimeMs: st.mtimeMs, size: st.size };
        for (const line of text.split('\n')) {
          try {
            const o = JSON.parse(line) as { id?: unknown; thread_name?: unknown };
            if (typeof o.id === 'string' && typeof o.thread_name === 'string' && this.threadNames.size < 20_000) this.threadNames.set(o.id, o.thread_name.slice(0, 120));
          } catch {
            // A line that is not JSON is skipped.
          }
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.deps.logger.warn('codex_sidecar.index_unreadable', 'codex sidecar: thread names not read', { reason: String((err as Error).message).slice(0, 120) });
    }
  }

  /** Reads what was appended to each file, newest files first, until the byte budget for this poll is spent. */
  private readFiles(): void {
    let budget = POLL_BYTES;
    const order = [...this.tracked.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const t of order) {
      if (budget <= 0) break;
      let size = 0;
      try {
        size = fs.statSync(t.file.path).size;
      } catch {
        this.tracked.delete(t.file.path);
        continue;
      }
      if (!t.file.read()) {
        this.tracked.delete(t.file.path);
        continue;
      }
      budget -= Math.min(size, 512 * 1024);
    }
  }

  private async runs(now: number): Promise<RunInfo[]> {
    const out: RunInfo[] = [];
    for (const t of this.tracked.values()) {
      const f = t.file.facts;
      if (!f.sessionId) continue;
      let tab = this.deps.names.titleFor(f.sessionId);
      if (!tab && !isHeadless(f)) tab = await this.tabFromProcess(f.sessionId, f.startedAt, now);
      out.push({ facts: f, tab, threadName: this.threadNames.get(f.sessionId) ?? null });
    }
    return out;
  }

  /** The tab of an interactive session cmux's file does not list, from its process; tried a few times a minute apart, then given up. */
  private async tabFromProcess(id: string, startedAt: number | null, now: number): Promise<string | null> {
    const lookup = this.deps.processTab;
    if (!lookup || startedAt === null) return null;
    const have = this.tabBySession.get(id);
    if (have && (have.tab || have.tries >= PROCESS_TRIES || now - have.at < PROCESS_RETRY_MS)) return have.tab;
    let tab: string | null = null;
    try {
      tab = await lookup(startedAt);
    } catch (err) {
      this.deps.logger.warn('codex_sidecar.process_lookup_failed', 'codex sidecar: tab not found from the process', { reason: String((err as Error).message).slice(0, 120) });
    }
    this.tabBySession.set(id, { tab, tries: (have?.tries ?? 0) + 1, at: now });
    return tab;
  }

  /** Posts one report. True when the server took it; a refused token or an unreachable server pauses all posting for a minute. */
  private async post(report: Report): Promise<boolean> {
    const { config, logger } = this.deps;
    const body = config.userName ? { ...report, userName: config.userName } : report;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (config.token) headers['x-podium-token'] = config.token;
    let res: Response;
    try {
      res = await this.deps.fetch(`${config.url}/api/fleet/report`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(POST_TIMEOUT_MS) });
    } catch (err) {
      this.backoffUntil = this.deps.now() + BACKOFF_MS;
      if (!this.down) logger.warn('codex_sidecar.server_unreachable', 'codex sidecar: the Podium server did not answer', { reason: String((err as Error)?.message ?? err).slice(0, 120) });
      this.down = true;
      return false;
    }
    if (res.status === 401 || res.status === 403) {
      this.backoffUntil = this.deps.now() + BACKOFF_MS;
      if (!this.refused) logger.error('codex_sidecar.token_refused', 'codex sidecar: the server refused the token', { status: res.status });
      this.refused = true;
      return false;
    }
    if (!res.ok) {
      // A report the server will not take (it names the field): skip this card, carry on with the others.
      logger.warn('codex_sidecar.report_refused', 'codex sidecar: a report was refused', { session: report.session.id, status: res.status });
      return false;
    }
    this.down = false;
    this.refused = false;
    return true;
  }
}

export function makeSidecar(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): Sidecar | null {
  const config = configFromEnv(env, home);
  if (!config.enabled) return null;
  const logger = createLogger({ format: 'json', service: 'podium-codex', secrets: config.token ? [config.token] : [] });
  const names = new CmuxNames(logger, execList(env.PODIUM_CMUX_BIN || CMUX_BIN), defaultHookFiles(home));
  return new Sidecar({ config, logger, fetch, names, now: Date.now, processTab: processTabLookup(names) });
}

const invoked = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (invoked) {
  const sidecar = makeSidecar();
  if (!sidecar) {
    console.log('podium-codex: off (set PODIUM_CODEX=1 to follow Codex sessions); nothing to do');
  } else {
    sidecar.start();
  }
}
