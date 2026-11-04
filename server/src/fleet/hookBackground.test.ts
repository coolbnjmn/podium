import { describe, it, expect } from 'vitest';
import { openDb, FleetDb } from './db.js';
import { DEFAULT_CONFIG, Fleet } from './fleet.js';
import { fixtureReport } from './testing.js';

// Claude Code can skip the reporter's own Stop handler, so a Stop settings hook is the only place a mod-reported session's
// scheduled wake-ups and background tasks arrive from. The hook sets them on the stored session; the reporter's next report must not blank them.

function setup() {
  let now = 1_800_000_000_000;
  const fleet = new Fleet(new FleetDb(openDb(':memory:')), { ...DEFAULT_CONFIG, home: '/Users/dev', dbPath: ':memory:' }, () => now);
  const idleReport = () => {
    const r = fixtureReport();
    r.session = { ...r.session, status: 'waiting', waitReason: 'input', waitNote: null };
    return { ...r, sentAt: now };
  };
  const runningReport = () => ({ ...fixtureReport(), sentAt: now, session: { ...fixtureReport().session, status: 'running' as const, waitReason: null, waitNote: null } });
  const hook = (event: string, extra: object = {}) => {
    now += 1000;
    return fleet.ingestHook({ hook_event_name: event, session_id: fixtureReport().session.id, cwd: '/Users/dev/x', ...extra });
  };
  return { fleet, id: fixtureReport().session.id, idleReport, runningReport, hook, tick: (ms: number) => (now += ms) };
}

const CRON = { id: 'c1', schedule: '*/3 * * * *', recurring: true, prompt: 'status update every three minutes' };

describe('Stop hook for a session the mod reports', () => {
  it('shows its scheduled wake-ups as background work, so the session is not waiting on the person', () => {
    const { fleet, id, idleReport, hook } = setup();
    fleet.ingest(idleReport());
    expect(fleet.view(id)).toMatchObject({ reporter: 'mod', status: 'waiting', waitReason: 'input', background: null });
    hook('Stop', { session_crons: [CRON], background_tasks: [] });
    const v = fleet.view(id)!;
    expect(v.reporter).toBe('mod');
    expect(v.waitReason).toBeNull();
    expect(v.background?.tasks).toEqual([{ type: 'wakeup', description: 'status update every three minutes', status: 'scheduled' }]);
    fleet.close();
  });

  it('carries the wake time the hook worked out in the session\'s own time zone, or none when any wake-up has no readable time', () => {
    const { fleet, id, idleReport, hook } = setup();
    fleet.ingest(idleReport());
    const soon = 1_800_000_000_000 + 180_000;
    hook('Stop', { session_crons: [{ ...CRON, next_at: soon + 60_000 }, { ...CRON, id: 'c2', next_at: soon }] });
    expect(fleet.view(id)!.background?.wakeAt).toBe(soon);
    hook('Stop', { session_crons: [{ ...CRON, next_at: soon }, { ...CRON, id: 'c2' }] });
    expect(fleet.view(id)!.background?.wakeAt).toBeNull();
    hook('Stop', { session_crons: [{ ...CRON, next_at: 'tomorrow' }] });
    expect(fleet.view(id)!.background?.wakeAt).toBeNull();
    hook('Stop', { session_crons: [{ ...CRON, next_at: 1_800_000_000_000 + 400 * 86_400_000 }] });
    expect(fleet.view(id)!.background?.wakeAt).toBeNull();
    fleet.close();
  });

  it('reads every wake-up\'s time even when the card can list only some of the tasks', () => {
    const { fleet, id, idleReport, hook } = setup();
    fleet.ingest(idleReport());
    const now = 1_800_000_000_000;
    const shells = Array.from({ length: 19 }, (_, i) => ({ id: `b${i}`, type: 'shell', status: 'running', description: `job ${i}` }));
    hook('Stop', { background_tasks: shells, session_crons: [{ ...CRON, next_at: now + 3_600_000 }, { ...CRON, id: 'c2', next_at: now + 60_000 }] });
    const bg = fleet.view(id)!.background!;
    expect(bg.tasks).toHaveLength(20);
    expect(bg.wakeAt).toBe(now + 60_000);
    fleet.close();
  });

  it('survives the reporter\'s next report, which carries no background work', () => {
    const { fleet, id, idleReport, hook, tick } = setup();
    fleet.ingest(idleReport());
    hook('Stop', { session_crons: [CRON] });
    tick(5000);
    fleet.ingest(idleReport());
    expect(fleet.view(id)!.background?.tasks).toHaveLength(1);
    expect(fleet.view(id)!.waitReason).toBeNull();
    fleet.close();
  });

  it('ends with the next prompt, a Stop that lists nothing, or a report that says the session is running', () => {
    const a = setup();
    a.fleet.ingest(a.idleReport());
    a.hook('Stop', { session_crons: [CRON] });
    a.hook('UserPromptSubmit', { prompt: 'hi' });
    expect(a.fleet.view(a.id)).toMatchObject({ background: null, waitReason: 'input' });
    a.fleet.close();

    const b = setup();
    b.fleet.ingest(b.idleReport());
    b.hook('Stop', { session_crons: [CRON] });
    b.hook('Stop', { session_crons: [], background_tasks: [] });
    expect(b.fleet.view(b.id)).toMatchObject({ background: null, waitReason: 'input' });
    b.fleet.close();

    const c = setup();
    c.fleet.ingest(c.idleReport());
    c.hook('Stop', { session_crons: [CRON] });
    c.fleet.ingest(c.runningReport());
    c.fleet.ingest(c.idleReport());
    expect(c.fleet.view(c.id)).toMatchObject({ background: null, waitReason: 'input' });
    c.fleet.close();
  });

  it('is not erased by a running report that was built before the hook arrived', () => {
    const { fleet, id, idleReport, runningReport, hook, tick } = setup();
    fleet.ingest(idleReport());
    const early = runningReport();
    tick(1000);
    hook('Stop', { session_crons: [CRON] });
    tick(10);
    fleet.ingest(early);
    fleet.ingest(idleReport());
    expect(fleet.view(id)!.background?.tasks).toHaveLength(1);
    expect(fleet.view(id)!.waitReason).toBeNull();
    fleet.close();
  });

  it('refuses a hook for a session another owner reports, and changes nothing', () => {
    const { fleet, id, idleReport, hook } = setup();
    fleet.ingest(idleReport(), 'Alice');
    expect(() => fleet.ingestHook({ hook_event_name: 'Stop', session_id: id, cwd: '/x', session_crons: [CRON] }, 'Bob')).toThrow('belongs to another owner');
    expect(fleet.view(id)!.background).toBeNull();
    hook('Stop', { session_crons: [CRON] });
    expect(fleet.view(id)!.background?.tasks).toHaveLength(1);
    fleet.close();
  });

  it('never hides a wait for the person\'s approval, and never changes the mod\'s other fields', () => {
    const { fleet, id, hook, tick } = setup();
    const r = fixtureReport();
    fleet.ingest({ ...r, sentAt: 1, session: { ...r.session, status: 'waiting', waitReason: 'permission', waitNote: 'Bash(rm)' } });
    const before = fleet.view(id)!;
    tick(10);
    hook('Stop', { session_crons: [CRON] });
    const after = fleet.view(id)!;
    expect(after.waitReason).toBe('permission');
    expect(after.background).toBeNull();
    expect(after.costUsd).toBe(before.costUsd);
    expect(after.plan).toEqual(before.plan);
    fleet.close();
  });
});
