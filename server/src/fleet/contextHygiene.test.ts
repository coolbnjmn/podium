// Context hygiene: the limits file, a crossing seen once, the feed line and the view a session gets, the opt-in nudge and its refusals.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger, type Logger } from '../logging/logger.js';
import {
  ContextNudge,
  ContextWatch,
  DEFAULT_LIMITS,
  hygieneView,
  isOrchestrator,
  LimitsSource,
  NUDGE_BACKOFF_MS,
  parseLimits,
  type Crossing,
} from './contextHygiene.js';
import { DEFAULT_CONFIG, Fleet, type FleetConfig } from './fleet.js';
import { FleetDb, openDb } from './db.js';
import type { Report } from './protocol.js';
import { fixtureReport } from './testing.js';

interface Logged {
  level: string;
  event: string;
  fields?: Record<string, unknown>;
}

let dir: string;
let logged: Logged[];
let logger: Logger;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-ctx-'));
  logged = [];
  const at = (level: string) => (event: string, _m: string, fields?: Record<string, unknown>) => void logged.push({ level, event, fields });
  logger = { ...silentLogger, info: at('info'), warn: at('warn') } as unknown as Logger;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.PODIUM_CONTEXT_LIMITS_FILE;
});

const write = (name: string, text: string) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return file;
};
const warnings = (event: string) => logged.filter((l) => l.level === 'warn' && l.event === event);

describe('the limits file', () => {
  it('reads soft and hard, and a bad pair is refused', () => {
    expect(parseLimits('{"soft":100000,"hard":250000}')).toEqual({ soft: 100000, hard: 250000 });
    expect(() => parseLimits('{"soft":250000,"hard":100000}')).toThrow('limits_not_soft_below_hard');
    expect(() => parseLimits('{"soft":1.5,"hard":9}')).toThrow();
    expect(() => parseLimits('{"soft":"100k","hard":250000}')).toThrow();
    expect(() => parseLimits('null')).toThrow();
    expect(() => parseLimits('not json')).toThrow();
  });

  it('uses the file, and picks up a change within the recheck time', () => {
    const file = write('limits.json', '{"soft":50000,"hard":120000}');
    let now = 1_000_000;
    const src = new LimitsSource(file, logger, () => now);
    expect(src.get()).toEqual({ soft: 50000, hard: 120000 });
    fs.writeFileSync(file, '{"soft":60000,"hard":130000}');
    fs.utimesSync(file, new Date(now + 5000), new Date(now + 5000));
    expect(src.get()).toEqual({ soft: 50000, hard: 120000 });
    now += 11_000;
    expect(src.get()).toEqual({ soft: 60000, hard: 130000 });
    expect(warnings('context_limits.load_failed')).toEqual([]);
  });

  it('a missing file means the defaults, logged once', () => {
    let now = 1_000_000;
    const src = new LimitsSource(path.join(dir, 'nope.json'), logger, () => now);
    expect(src.get()).toEqual(DEFAULT_LIMITS);
    now += 11_000;
    expect(src.get()).toEqual(DEFAULT_LIMITS);
    expect(warnings('context_limits.load_failed')).toHaveLength(1);
    expect(warnings('context_limits.load_failed')[0]!.fields).toMatchObject({ file: 'nope.json', reason: 'limits_file_missing' });
  });

  it('a garbled or oversized file means the defaults, logged once per reason, and a fixed file recovers', () => {
    const file = write('limits.json', '{"soft":');
    let now = 1_000_000;
    const src = new LimitsSource(file, logger, () => now);
    expect(src.get()).toEqual(DEFAULT_LIMITS);
    now += 11_000;
    src.get();
    expect(warnings('context_limits.load_failed')).toHaveLength(1);
    fs.writeFileSync(file, ' '.repeat(5000));
    now += 11_000;
    expect(src.get()).toEqual(DEFAULT_LIMITS);
    expect(warnings('context_limits.load_failed').map((w) => w.fields?.reason)).toContain('limits_file_too_large');
    fs.writeFileSync(file, '{"soft":70000,"hard":90000}');
    now += 11_000;
    expect(src.get()).toEqual({ soft: 70000, hard: 90000 });
  });
});

describe('a crossing is seen once', () => {
  const watch = () => new ContextWatch(() => DEFAULT_LIMITS);

  it('the first sight only sets the state, so a restart repeats nothing', () => {
    const w = watch();
    expect(w.observe('s', 300_000, false)).toEqual([]);
    expect(w.observe('s', 310_000, false)).toEqual([]);
  });

  it('reports soft then hard as they are crossed, once each', () => {
    const w = watch();
    w.observe('s', 50_000, false);
    expect(w.observe('s', 120_000, false)).toEqual([{ level: 'soft', tokens: 120_000, limit: 100_000 }]);
    expect(w.observe('s', 130_000, false)).toEqual([]);
    expect(w.observe('s', 260_000, false)).toEqual([{ level: 'hard', tokens: 260_000, limit: 250_000 }]);
    expect(w.observe('s', 270_000, false)).toEqual([]);
  });

  it('re-arms only below 90% of a limit', () => {
    const w = watch();
    w.observe('s', 50_000, false);
    w.observe('s', 120_000, false);
    expect(w.observe('s', 95_000, false)).toEqual([]);
    expect(w.observe('s', 105_000, false)).toEqual([]);
    expect(w.observe('s', 80_000, false)).toEqual([]);
    expect(w.observe('s', 101_000, false)).toEqual([{ level: 'soft', tokens: 101_000, limit: 100_000 }]);
  });

  it('a jump past both limits reports both', () => {
    const w = watch();
    w.observe('s', 10_000, false);
    expect(w.observe('s', 300_000, false).map((c) => c.level)).toEqual(['soft', 'hard']);
  });

  it('a new session that starts over the soft limit was resumed with that much; an old one is not marked', () => {
    const w = watch();
    expect(w.observe('fresh', 20_000, true)).toEqual([]);
    expect(w.resumedWith('fresh')).toBeNull();
    expect(w.observe('resumed', 180_000, true)).toEqual([]);
    expect(w.resumedWith('resumed')).toBe(180_000);
    w.observe('seen-before', 180_000, false);
    expect(w.resumedWith('seen-before')).toBeNull();
  });

  it('no number, no crossing; and a forgotten session starts over', () => {
    const w = watch();
    expect(w.observe('s', null, true)).toEqual([]);
    expect(w.observe('s', undefined, true)).toEqual([]);
    expect(w.observe('s', Number.NaN, true)).toEqual([]);
    expect(w.size()).toBe(0);
    w.observe('s', 150_000, false);
    w.forget('s');
    expect(w.size()).toBe(0);
    expect(w.observe('s', 300_000, false)).toEqual([]);
  });
});

describe('the view of a session', () => {
  const base = { tokens: 300_000, idle: true, backgroundPending: false, claude: true, orchestrator: false, resumedWith: null };

  it('the level follows the limits', () => {
    expect(hygieneView({ ...base, tokens: 50_000 }, DEFAULT_LIMITS).level).toBe('ok');
    expect(hygieneView({ ...base, tokens: 100_000 }, DEFAULT_LIMITS).level).toBe('soft');
    expect(hygieneView({ ...base, tokens: 250_000 }, DEFAULT_LIMITS).level).toBe('hard');
    expect(hygieneView({ ...base, tokens: null }, DEFAULT_LIMITS).level).toBe('ok');
  });

  it('reset is due only at the hard limit, idle, with no background work', () => {
    expect(hygieneView(base, DEFAULT_LIMITS).resetDue).toBe(true);
    expect(hygieneView({ ...base, idle: false }, DEFAULT_LIMITS).resetDue).toBe(false);
    expect(hygieneView({ ...base, backgroundPending: true }, DEFAULT_LIMITS).resetDue).toBe(false);
    expect(hygieneView({ ...base, tokens: 150_000 }, DEFAULT_LIMITS).resetDue).toBe(false);
  });

  it('never for the Orchestrator or a Codex card', () => {
    expect(hygieneView({ ...base, orchestrator: true }, DEFAULT_LIMITS).resetDue).toBe(false);
    expect(hygieneView({ ...base, claude: false }, DEFAULT_LIMITS).resetDue).toBe(false);
    expect(isOrchestrator('Orchestrator', 'x')).toBe(true);
    expect(isOrchestrator(null, ' orchestrator ')).toBe(true);
    expect(isOrchestrator('Orchestrator 2', 'x')).toBe(false);
  });
});

describe('the nudge', () => {
  const crossing: Crossing = { level: 'soft', tokens: 120_000, limit: 100_000 };
  let sent: { title: string; text: string }[];
  let now: number;
  const make = (fail?: string) =>
    new ContextNudge(
      logger,
      async (title, text) => {
        if (fail) throw new Error(fail);
        sent.push({ title, text });
      },
      () => now,
    );
  beforeEach(() => {
    sent = [];
    now = 1_000_000;
  });

  it('messages the tab once with the soft text', async () => {
    expect(await make().nudge('s', 'Gardener', 'gardener', crossing)).toBe('sent');
    expect(sent).toEqual([{ title: 'Gardener', text: 'context over 100k: write HANDOFF.md at the next boundary' }]);
  });

  it('the hard crossing says so', async () => {
    await make().nudge('s', 'Gardener', 'gardener', { level: 'hard', tokens: 260_000, limit: 250_000 });
    expect(sent[0]!.text).toContain('over 250k');
  });

  it('a session with no tab is skipped, with the reason logged', async () => {
    expect(await make().nudge('s', null, 'x', crossing)).toBe('skipped');
    expect(sent).toEqual([]);
    expect(logged.find((l) => l.event === 'context_nudge.skipped')!.fields).toMatchObject({ session_id: 's', reason: 'no_cmux_tab' });
  });

  it('the Orchestrator is never messaged', async () => {
    expect(await make().nudge('s', 'Orchestrator', 'x', crossing)).toBe('skipped');
    expect(await make().nudge('s', 'Other', 'Orchestrator', crossing)).toBe('skipped');
    expect(sent).toEqual([]);
    expect(logged.filter((l) => l.event === 'context_nudge.skipped').every((l) => l.fields?.reason === 'orchestrator')).toBe(true);
  });

  it('a refusal by cmux is logged once and stops every nudge until the backoff ends', async () => {
    const n = make('ERROR: Access denied - only processes started inside cmux can connect');
    expect(await n.nudge('a', 'A', 'a', crossing)).toBe('failed');
    expect(await n.nudge('b', 'B', 'b', crossing)).toBe('skipped');
    expect(warnings('context_nudge.failed')).toHaveLength(1);
    expect(warnings('context_nudge.failed')[0]!.fields?.reason).toContain('Access denied');
    expect(logged.find((l) => l.fields?.reason === 'cmux_backoff')).toBeTruthy();
    now += NUDGE_BACKOFF_MS + 1;
    expect(await n.nudge('c', 'C', 'c', crossing)).toBe('failed');
    expect(warnings('context_nudge.failed')).toHaveLength(1);
  });

  it('a nudge that works after a failure clears the memory of it', async () => {
    let fail = true;
    const n = new ContextNudge(
      logger,
      async () => {
        if (fail) throw new Error('timeout');
      },
      () => now,
    );
    expect(await n.nudge('a', 'A', 'a', crossing)).toBe('failed');
    now += NUDGE_BACKOFF_MS + 1;
    fail = false;
    expect(await n.nudge('a', 'A', 'a', crossing)).toBe('sent');
    fail = true;
    now += NUDGE_BACKOFF_MS + 1;
    await n.nudge('a', 'A', 'a', crossing);
    expect(warnings('context_nudge.failed')).toHaveLength(2);
  });
});

describe('in the fleet', () => {
  const CFG: FleetConfig = { ...DEFAULT_CONFIG, home: '/Users/dev', dbPath: ':memory:' };
  let clock: number;
  let db: FleetDb;
  beforeEach(() => {
    clock = 1_791_648_000_000;
    db = new FleetDb(openDb(':memory:'));
    process.env.PODIUM_CONTEXT_LIMITS_FILE = write('limits.json', '{"soft":100000,"hard":250000}');
  });

  function report(id: string, tokens: number | null, opts: { name?: string; status?: 'running' | 'waiting'; ended?: boolean } = {}): Report {
    const r = structuredClone(fixtureReport());
    r.session = {
      ...r.session,
      id,
      name: opts.name ?? 'work',
      costUsd: 0.2,
      tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
      context: { tokens, window: 1_000_000, percent: tokens === null ? null : tokens / 10_000 },
      status: opts.ended ? 'done' : (opts.status ?? 'waiting'),
      waitReason: opts.status === 'running' || opts.ended ? null : 'input',
      attached: true,
      background: null,
    } as Report['session'];
    r.events = [];
    return r;
  }
  const contextLines = (fleet: Fleet, id: string) => fleet.events({ limit: 50 }).filter((e) => e.sessionId === id && e.kind === 'note');

  it('a crossing puts one line in the feed naming the session and its tokens, live and listed', () => {
    const fleet = new Fleet(db, CFG, () => clock, logger);
    const sent: string[] = [];
    fleet.hub.add({ write: (c: string) => void sent.push(c) });
    fleet.ingest(report('a', 60_000));
    fleet.ingest(report('a', 130_000));
    fleet.ingest(report('a', 135_000));
    const lines = contextLines(fleet, 'a');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toContain('work context at 130k, over the soft limit of 100k');
    expect(lines[0]!.data).toMatchObject({ kind: 'context_soft', tokens: 130_000, limit: 100_000 });
    expect(sent.join('')).toContain('context_soft');
    expect(logged.some((l) => l.event === 'context.soft' && l.fields?.session_id === 'a')).toBe(true);
  });

  it('the state carries the limits and each session its level, reset-due and resumed marks', () => {
    const fleet = new Fleet(db, CFG, () => clock, logger);
    fleet.ingest(report('small', 40_000));
    fleet.ingest(report('big', 300_000));
    const st = fleet.state();
    expect(st.config.contextLimits).toEqual({ soft: 100000, hard: 250000 });
    const by = (id: string) => st.sessions.find((s) => s.id === id)!;
    expect(by('small').hygiene).toEqual({ level: 'ok', resetDue: false, resumedWith: null });
    expect(by('big').hygiene).toEqual({ level: 'hard', resetDue: true, resumedWith: 300_000 });
  });

  it('a running session at the hard limit is not reset-due', () => {
    const fleet = new Fleet(db, CFG, () => clock, logger);
    fleet.ingest(report('busy', 300_000, { status: 'running' }));
    expect(fleet.state().sessions.find((s) => s.id === 'busy')!.hygiene).toMatchObject({ level: 'hard', resetDue: false });
  });

  it('the Orchestrator is never reset-due, by its name or its tab', () => {
    const fleet = new Fleet(db, CFG, () => clock, logger);
    fleet.ingest(report('o1', 300_000, { name: 'Orchestrator' }));
    fleet.ingest(report('o2', 300_000, { name: 'x' }));
    fleet.names = { titleFor: (id) => (id === 'o2' ? 'Orchestrator' : null) };
    const by = (id: string) => fleet.state().sessions.find((s) => s.id === id)!;
    expect(by('o1').hygiene!.resetDue).toBe(false);
    expect(by('o2').hygiene!.resetDue).toBe(false);
  });

  it('a Codex card gets badges but is never reset-due and is never nudged', async () => {
    const fleet = new Fleet(db, CFG, () => clock, logger);
    const sent: string[] = [];
    fleet.nudge = new ContextNudge(logger, async (t) => void sent.push(t));
    fleet.names = { titleFor: () => 'Codex tab' };
    fleet.ingest(report('codex:1', 60_000));
    fleet.ingest(report('codex:1', 300_000));
    await Promise.resolve();
    const v = fleet.state().sessions.find((s) => s.id === 'codex:1')!;
    expect(v.hygiene).toMatchObject({ level: 'hard', resetDue: false });
    expect(sent).toEqual([]);
  });

  it('the nudge goes to the tab of a Claude session on a crossing, and nowhere with the flag off', async () => {
    const sent: string[] = [];
    const on = new Fleet(db, CFG, () => clock, logger);
    on.nudge = new ContextNudge(logger, async (t, text) => void sent.push(`${t}: ${text}`));
    on.names = { titleFor: () => 'Gardener' };
    on.ingest(report('a', 60_000));
    on.ingest(report('a', 130_000));
    await Promise.resolve();
    expect(sent).toEqual(['Gardener: context over 100k: write HANDOFF.md at the next boundary']);
    const off = new Fleet(new FleetDb(openDb(':memory:')), CFG, () => clock, logger);
    off.names = { titleFor: () => 'Gardener' };
    off.ingest(report('b', 60_000));
    off.ingest(report('b', 130_000));
    expect(off.nudge).toBeNull();
    expect(sent).toHaveLength(1);
  });

  it('a session that ended is forgotten, and a later one under the id starts over', () => {
    const fleet = new Fleet(db, CFG, () => clock, logger);
    fleet.ingest(report('a', 60_000));
    fleet.ingest(report('a', 130_000));
    fleet.ingest(report('a', 130_000, { ended: true }));
    clock += 60_000;
    fleet.ingest(report('a', 60_000));
    clock += 60_000;
    fleet.ingest(report('a', 140_000));
    expect(contextLines(fleet, 'a')).toHaveLength(2);
  });

  it('a report with no context number puts no line and no mark', () => {
    const fleet = new Fleet(db, CFG, () => clock, logger);
    fleet.ingest(report('a', null));
    expect(contextLines(fleet, 'a')).toEqual([]);
    expect(fleet.state().sessions.find((s) => s.id === 'a')!.hygiene).toEqual({ level: 'ok', resetDue: false, resumedWith: null });
  });

  it('a missing limits file leaves the defaults in the state', () => {
    process.env.PODIUM_CONTEXT_LIMITS_FILE = path.join(dir, 'nope.json');
    const fleet = new Fleet(db, CFG, () => clock, logger);
    fleet.ingest(report('a', 40_000));
    expect(fleet.state().config.contextLimits).toEqual(DEFAULT_LIMITS);
    expect(warnings('context_limits.load_failed')).toHaveLength(1);
  });

  it('sub-agent rows are not sessions: only the session itself is marked', () => {
    const fleet = new Fleet(db, CFG, () => clock, logger);
    const r = report('a', 300_000);
    fleet.ingest(r);
    expect(fleet.state().sessions.map((s) => s.id)).toEqual(['a']);
    expect(fleet.state().sessions[0]!.hygiene).toBeDefined();
  });
});
