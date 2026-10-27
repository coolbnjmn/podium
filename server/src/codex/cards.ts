// Turns what the rollout files say into the reports Podium takes. A Codex session someone sits in is one card named after its cmux
// tab. The headless `codex exec` runs other tabs launch (dozens a day) are folded into one card per launching tab, so they never
// become a wall of cards. Nothing here holds prompt or response text: only ids, folders, a model name, counts and times.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { REPORTER_SUPPORT } from '../fleet/compat.js';
import type { Report, SessionReport } from '../fleet/protocol.js';
import type { RolloutFacts } from './rollout.js';

/** Ids of the cards this sidecar makes start with this, so the server and the UI can tell a Codex card from a Claude Code one. */
export const CODEX_PREFIX = 'codex:';
/** A turn that has been open this long without a new record is not running any more (the process died or was killed). */
export const RUNNING_QUIET_MS = 10 * 60 * 1000;
/** A session with no record for this long is not reported; the server drops its card. */
export const ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** One rollout as the card builder sees it. */
export interface RunInfo {
  facts: RolloutFacts;
  /** The cmux tab the session runs in, or null when cmux does not say. */
  tab: string | null;
  /** Codex's own name for the thread, or null. */
  threadName: string | null;
}

const cut = (s: string, max: number): string => (s.length > max ? s.slice(0, max) : s);
const base = (p: string | null): string => (p ? path.basename(p.replace(/\/+$/, '')) || p : '');

export function isHeadless(f: RolloutFacts): boolean {
  return f.source === 'exec';
}

export function isRunning(f: RolloutFacts, now: number): boolean {
  return f.openTurns.size > 0 && f.lastRecordAt !== null && now - f.lastRecordAt < RUNNING_QUIET_MS;
}

/** Whether a rollout should be reported at all: it has said who it is, and has written within the window. */
export function isActive(f: RolloutFacts, now: number): boolean {
  return f.sessionId !== null && f.lastRecordAt !== null && now - f.lastRecordAt < ACTIVE_WINDOW_MS;
}

function frame(now: number, session: SessionReport): Report {
  return {
    v: 1,
    sentAt: now,
    // The newest version the server accepts, so a card is never called outdated or newer than the server supports.
    reporter: { name: 'podium-reporter', version: REPORTER_SUPPORT.max, engineVersion: null, hostSurface: 'codex' },
    session,
    agents: [],
    // No feed lines: a Codex card has no activity feed, and a run's start and end are not news.
    events: [],
  };
}

function baseSession(id: string, name: string, now: number): SessionReport {
  return {
    id,
    name: cut(name, 120),
    status: 'waiting',
    waitReason: 'input',
    waitNote: null,
    endReason: null,
    resumeId: null,
    startedAt: now,
    cwd: '',
    projectRoot: null,
    repoName: null,
    git: null,
    model: null,
    effort: null,
    context: { tokens: null, window: null, percent: null },
    costUsd: null,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    rateLimits: [],
    blowouts: 0,
    plan: null,
    loop: null,
    files: null,
    // Read from the Codex session, never typed into: a person's session is on the wall while it is active, and a folded card never leaves it.
    attached: true,
    activityFeed: false,
    clearedFrom: null,
  };
}

function contextOf(f: RolloutFacts): SessionReport['context'] {
  const tokens = f.lastPromptTokens;
  const window = f.contextWindow;
  const percent = tokens !== null && window ? Math.min(100, Math.round((tokens / window) * 100)) : null;
  return { tokens, window, percent };
}

/** The card of a Codex session someone sits in. */
export function interactiveReport(run: RunInfo, now: number): Report {
  const f = run.facts;
  const s = baseSession(`${CODEX_PREFIX}${f.sessionId}`, run.tab ?? run.threadName ?? (base(f.cwd) || 'Codex'), now);
  s.status = isRunning(f, now) ? 'running' : 'waiting';
  s.waitReason = s.status === 'running' ? null : 'input';
  s.startedAt = f.startedAt ?? now;
  s.cwd = f.cwd ?? '';
  s.projectRoot = f.cwd;
  s.model = f.model;
  s.context = contextOf(f);
  s.tokens = { ...f.tokens };
  return frame(now, s);
}

/** A short stable id for a group key, so a tab title with odd characters does not become part of an id. */
function keyId(key: string): string {
  return createHash('sha1').update(key).digest('hex').slice(0, 12);
}

/** The key headless runs are folded by: the tab that launched them, else the folder they ran in. */
export function foldKey(run: RunInfo): string {
  return run.tab ? `tab:${run.tab}` : `cwd:${run.facts.cwd ?? ''}`;
}

function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** One card for every headless run one tab launched: how many run now, how many finished, and the latest one. */
export function foldedReport(runs: RunInfo[], now: number): Report {
  const first = runs[0]!;
  const key = foldKey(first);
  const latest = runs.reduce((a, b) => ((b.facts.lastRecordAt ?? 0) > (a.facts.lastRecordAt ?? 0) ? b : a));
  const active = runs.filter((r) => isRunning(r.facts, now)).length;
  const finished = runs.length - active;
  const label = first.tab ?? (base(first.facts.cwd) || 'Codex');
  const s = baseSession(`${CODEX_PREFIX}runs:${keyId(key)}`, `${label} · codex runs`, now);
  s.status = active > 0 ? 'running' : 'waiting';
  s.waitReason = active > 0 ? null : 'input';
  s.startedAt = Math.min(...runs.map((r) => r.facts.startedAt ?? now));
  s.cwd = latest.facts.cwd ?? '';
  s.projectRoot = latest.facts.cwd;
  s.model = latest.facts.model;
  s.context = contextOf(latest.facts);
  for (const r of runs) {
    s.tokens.input += r.facts.tokens.input;
    s.tokens.output += r.facts.tokens.output;
    s.tokens.cacheRead += r.facts.tokens.cacheRead;
    s.tokens.cacheWrite += r.facts.tokens.cacheWrite;
  }
  const at = latest.facts.lastRecordAt;
  s.waitNote = cut(`${active} running, ${finished} finished in the last day. Latest: ${base(latest.facts.cwd) || 'unknown'}${at ? ` at ${clock(at)}` : ''}`, 200);
  return frame(now, s);
}

/** Every report for the runs seen now: one per interactive session, one per group of headless runs. */
export function buildReports(runs: RunInfo[], now: number): Report[] {
  const live = runs.filter((r) => isActive(r.facts, now));
  const out: Report[] = [];
  const groups = new Map<string, RunInfo[]>();
  for (const r of live) {
    if (!isHeadless(r.facts)) {
      out.push(interactiveReport(r, now));
      continue;
    }
    const k = foldKey(r);
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  for (const g of groups.values()) out.push(foldedReport(g, now));
  return out;
}
