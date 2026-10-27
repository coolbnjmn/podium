// Context hygiene (local only): how full each session's context is against two limits, a feed line when a session crosses one,
// an opt-in nudge to the session's cmux tab, and a "reset due" mark for a session that is idle at the hard limit. Everything is
// read from numbers the reporters already send; nothing here changes a reporter or touches a session unless the nudge is on.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Logger } from '../logging/logger.js';
import { CMUX_BIN } from './cmuxNames.js';

export interface ContextLimits {
  soft: number;
  hard: number;
}

export const DEFAULT_LIMITS: ContextLimits = { soft: 100_000, hard: 250_000 };
/** A crossing re-arms once the context falls below this share of its limit, so a session hovering at a limit does not repeat itself. */
export const REARM_SHARE = 0.9;
/** How often the limits file is looked at again; a change shows up within this long. */
const LIMITS_RECHECK_MS = 10_000;
const LIMITS_FILE_MAX_BYTES = 4096;
/** After cmux refuses a nudge, none is tried for this long. */
export const NUDGE_BACKOFF_MS = 10 * 60_000;
const NUDGE_TIMEOUT_MS = 5000;

export function defaultLimitsFile(home: string): string {
  return path.join(home, 'Code', '_agent-data', 'context-limits.json');
}

/** `{ "soft": 100000, "hard": 250000 }`. Throws unless both are whole numbers above zero and soft is below hard. */
export function parseLimits(text: string): ContextLimits {
  const doc = JSON.parse(text) as { soft?: unknown; hard?: unknown } | null;
  const soft = doc?.soft;
  const hard = doc?.hard;
  if (typeof soft !== 'number' || typeof hard !== 'number' || !Number.isInteger(soft) || !Number.isInteger(hard) || soft <= 0 || hard <= soft) {
    throw new Error('limits_not_soft_below_hard');
  }
  return { soft, hard };
}

/** The limits, from one file shared with the reset scripts. A missing or broken file means the defaults, logged once per reason. */
export class LimitsSource {
  private limits: ContextLimits = DEFAULT_LIMITS;
  private mtimeMs = -1;
  private checkedAt = -Infinity;
  private lastFailure: string | null = null;

  constructor(
    private readonly file: string,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  get(): ContextLimits {
    const t = this.now();
    if (t - this.checkedAt < LIMITS_RECHECK_MS) return this.limits;
    this.checkedAt = t;
    try {
      const fd = fs.openSync(this.file, 'r');
      try {
        const st = fs.fstatSync(fd);
        if (st.mtimeMs === this.mtimeMs) return this.limits;
        if (st.size > LIMITS_FILE_MAX_BYTES) throw new Error('limits_file_too_large');
        this.limits = parseLimits(fs.readFileSync(fd, 'utf8'));
        this.mtimeMs = st.mtimeMs;
        this.lastFailure = null;
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      this.limits = DEFAULT_LIMITS;
      this.mtimeMs = -1;
      this.failed(code === 'ENOENT' ? 'limits_file_missing' : (err as Error).message);
    }
    return this.limits;
  }

  private failed(reason: string): void {
    if (this.lastFailure === reason) return;
    this.lastFailure = reason;
    this.logger.warn('context_limits.load_failed', `podium: context limits file not used (${path.basename(this.file)}): ${reason}; using ${DEFAULT_LIMITS.soft} and ${DEFAULT_LIMITS.hard}`, {
      file: path.basename(this.file),
      reason: reason.slice(0, 200),
    });
  }
}

export type ContextLevel = 'ok' | 'soft' | 'hard';

export function levelOf(tokens: number | null | undefined, limits: ContextLimits): ContextLevel {
  if (typeof tokens !== 'number') return 'ok';
  return tokens >= limits.hard ? 'hard' : tokens >= limits.soft ? 'soft' : 'ok';
}

export interface Crossing {
  level: 'soft' | 'hard';
  tokens: number;
  limit: number;
}

interface Tracked {
  over: { soft: boolean; hard: boolean };
  resumedWith: number | null;
}

/**
 * Watches the context of the sessions it is told about. A crossing is reported once per session until the context falls below
 * REARM_SHARE of the limit. The first time a session is seen it only sets the state, so a server restart does not repeat every
 * crossing; a session that is new and already over the soft limit was resumed with that much context, and is marked so.
 */
export class ContextWatch {
  private readonly seen = new Map<string, Tracked>();

  constructor(private readonly limits: () => ContextLimits) {}

  observe(sessionId: string, tokens: number | null | undefined, created: boolean): Crossing[] {
    if (typeof tokens !== 'number' || !Number.isFinite(tokens)) return [];
    const { soft, hard } = this.limits();
    const first = !this.seen.has(sessionId);
    const t = this.seen.get(sessionId) ?? { over: { soft: false, hard: false }, resumedWith: null };
    if (first && created && tokens >= soft) t.resumedWith = tokens;
    const out: Crossing[] = [];
    for (const [level, limit] of [['soft', soft], ['hard', hard]] as const) {
      if (tokens >= limit) {
        if (!t.over[level] && !first) out.push({ level, tokens, limit });
        t.over[level] = true;
      } else if (tokens < limit * REARM_SHARE) {
        t.over[level] = false;
      }
    }
    this.seen.set(sessionId, t);
    return out;
  }

  /** The context a session started with when it was new and already over the soft limit; null otherwise. */
  resumedWith(sessionId: string): number | null {
    return this.seen.get(sessionId)?.resumedWith ?? null;
  }

  forget(sessionId: string): void {
    this.seen.delete(sessionId);
  }

  size(): number {
    return this.seen.size;
  }
}

/** What the card shows about a session's context. `resetDue` never holds for the Orchestrator, a Codex card or a session that is not idle. */
export interface HygieneView {
  level: ContextLevel;
  resetDue: boolean;
  resumedWith: number | null;
}

export function isOrchestrator(title: string | null | undefined, name: string): boolean {
  return /^orchestrator$/i.test((title ?? '').trim()) || /^orchestrator$/i.test(name.trim());
}

export function hygieneView(
  o: { tokens: number | null | undefined; idle: boolean; backgroundPending: boolean; claude: boolean; orchestrator: boolean; resumedWith: number | null },
  limits: ContextLimits,
): HygieneView {
  const level = levelOf(o.tokens, limits);
  return { level, resetDue: level === 'hard' && o.idle && !o.backgroundPending && o.claude && !o.orchestrator, resumedWith: o.resumedWith };
}

/** Sends one line to a cmux tab by its title; rejects when cmux refuses or is missing. */
export type SendRunner = (title: string, text: string) => Promise<void>;

export function execSend(bin: string, timeoutMs: number = NUDGE_TIMEOUT_MS): SendRunner {
  return (title, text) =>
    new Promise((resolve, reject) => {
      execFile(bin, ['agent', 'message', title, text], { timeout: timeoutMs, maxBuffer: 64 * 1024, encoding: 'utf8', windowsHide: true }, (err, _stdout, stderr) => {
        if (err) reject(new Error(`${(stderr || err.message).trim().split('\n')[0] ?? 'failed'}`.slice(0, 200)));
        else resolve();
      });
    });
}

const SOFT_TEXT = (limit: number) => `context over ${Math.round(limit / 1000)}k: write HANDOFF.md at the next boundary`;
const HARD_TEXT = (limit: number) => `context over ${Math.round(limit / 1000)}k: finish the step, write HANDOFF.md, and be ready for a fresh restart`;

/**
 * The opt-in nudge. A message waits for the session's next step, so it never interrupts a turn. One per crossing; a refusal by
 * cmux (it only answers processes started inside it) is logged once and stops every nudge for NUDGE_BACKOFF_MS.
 */
export class ContextNudge {
  private deniedUntil = 0;
  private lastFailure: string | null = null;

  constructor(
    private readonly logger: Logger,
    private readonly send: SendRunner,
    private readonly now: () => number = Date.now,
  ) {}

  /** Resolves when the attempt is over; never rejects. Skips are logged with the session and the reason. */
  async nudge(sessionId: string, title: string | null, name: string, c: Crossing): Promise<'sent' | 'skipped' | 'failed'> {
    if (!title) return this.skip(sessionId, 'no_cmux_tab');
    if (isOrchestrator(title, name)) return this.skip(sessionId, 'orchestrator');
    if (this.now() < this.deniedUntil) return this.skip(sessionId, 'cmux_backoff');
    try {
      await this.send(title, c.level === 'soft' ? SOFT_TEXT(c.limit) : HARD_TEXT(c.limit));
      this.lastFailure = null;
      this.logger.info('context_nudge.sent', `podium: nudged the tab of session ${sessionId} at ${c.tokens} tokens`, { session_id: sessionId, level: c.level, tokens: c.tokens });
      return 'sent';
    } catch (err) {
      const reason = (err as Error).message;
      this.deniedUntil = this.now() + NUDGE_BACKOFF_MS;
      if (this.lastFailure !== reason) {
        this.lastFailure = reason;
        this.logger.warn('context_nudge.failed', `podium: could not nudge the tab of session ${sessionId}: ${reason}`, { session_id: sessionId, level: c.level, reason });
      }
      return 'failed';
    }
  }

  private skip(sessionId: string, reason: string): 'skipped' {
    this.logger.info('context_nudge.skipped', `podium: no nudge for session ${sessionId} (${reason})`, { session_id: sessionId, reason });
    return 'skipped';
  }
}

export function contextNudgeOn(env: NodeJS.ProcessEnv): boolean {
  const v = (env.PODIUM_CONTEXT_NUDGE ?? '').toLowerCase();
  return v === '1' || v === 'true';
}

export function contextNudgeFromEnv(env: NodeJS.ProcessEnv, logger: Logger): ContextNudge | null {
  return contextNudgeOn(env) ? new ContextNudge(logger, execSend(env.PODIUM_CMUX_BIN || CMUX_BIN)) : null;
}

export function limitsSourceFromEnv(env: NodeJS.ProcessEnv, logger: Logger, home: string = os.homedir(), now: () => number = Date.now): LimitsSource {
  return new LimitsSource(env.PODIUM_CONTEXT_LIMITS_FILE || defaultLimitsFile(home), logger, now);
}
