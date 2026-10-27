// Headless runs (`claude -p`, `codex exec`) report through the mod like any session but have no window. Their start and end
// lines flooded the activity feed, so the feed leaves them out; the wall and the costs are unchanged. The same file covers a
// card named after its cmux tab, since both change what a session shows.
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, FleetDb } from './db.js';
import { DEFAULT_CONFIG, Fleet, configFromEnv, type FleetConfig } from './fleet.js';
import { attachedEver } from './ingest.js';
import { isHeadless } from './derive.js';
import type { Report } from './protocol.js';
import { fixtureReport } from './testing.js';

const CFG: FleetConfig = { ...DEFAULT_CONFIG, home: '/Users/dev', dbPath: ':memory:' };
const T0 = 1_791_648_000_000;

let clock = T0;
let db: FleetDb;
beforeEach(() => {
  clock = T0;
  db = new FleetDb(openDb(':memory:'));
});

/** A session that did real work (so it is not "unused"), with the given attach state and one feed event. */
function report(id: string, attached: boolean | null | undefined, name = 'scan'): Report {
  const r = structuredClone(fixtureReport());
  r.session = { ...r.session, id, name, costUsd: 0.2, tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 } };
  const s = r.session as unknown as Record<string, unknown>;
  if (attached === undefined) delete s.attached;
  else s.attached = attached;
  r.events = [{ id: `${id}:start`, t: T0, kind: 'start', agentId: null, text: 'session.start', data: null }] as unknown as Report['events'];
  return r;
}

const feedIds = (fleet: Fleet, id: string) => fleet.events({ limit: 50 }).filter((e) => e.sessionId === id);
const sentFor = (sent: string[], id: string) => sent.join('').includes(`"sessionId":"${id}"`);

describe('headless runs and the activity feed', () => {
  it('a run nobody was ever attached to puts no line in the feed, live or listed, and stays on the wall', () => {
    const fleet = new Fleet(db, CFG, () => clock);
    const sent: string[] = [];
    fleet.hub.add({ write: (c: string) => void sent.push(c) });
    fleet.ingest(report('headless', false));
    expect(isHeadless(db.getSession('headless')!)).toBe(true);
    expect(feedIds(fleet, 'headless')).toEqual([]);
    expect(sent.join('')).not.toContain('"kind":"start"');
    expect(fleet.state().sessions.map((s) => s.id)).toContain('headless');
  });

  it('its end line is left out too', () => {
    const fleet = new Fleet(db, CFG, () => clock);
    const sent: string[] = [];
    fleet.hub.add({ write: (c: string) => void sent.push(c) });
    fleet.ingest(report('headless', false));
    const end = report('headless', false);
    end.session.status = 'done';
    end.session.waitReason = null;
    end.session.endReason = 'other';
    fleet.ingest(end);
    clock += CFG.lingerMs + 1000;
    fleet.sweep();
    expect(feedIds(fleet, 'headless')).toEqual([]);
    expect(sent.join('')).not.toContain('session ended');
  });

  it('an interactive session still has its lines', () => {
    const fleet = new Fleet(db, CFG, () => clock);
    const sent: string[] = [];
    fleet.hub.add({ write: (c: string) => void sent.push(c) });
    fleet.ingest(report('terminal', true, 'work'));
    expect(feedIds(fleet, 'terminal').length).toBeGreaterThan(0);
    expect(sent.join('')).toContain('"kind":"start"');
  });

  it('a session that was attached and later detached keeps its lines', () => {
    const fleet = new Fleet(db, CFG, () => clock);
    fleet.ingest(report('closed-window', true, 'work'));
    fleet.ingest(report('closed-window', false, 'work'));
    expect(db.getSession('closed-window')!.attached_ever).toBe(1);
    expect(feedIds(fleet, 'closed-window').length).toBeGreaterThan(0);
  });

  it('a reporter that sends no attached field is never taken for headless', () => {
    const fleet = new Fleet(db, CFG, () => clock);
    fleet.ingest(report('old-reporter', undefined, 'work'));
    expect(isHeadless(db.getSession('old-reporter')!)).toBe(false);
    expect(feedIds(fleet, 'old-reporter').length).toBeGreaterThan(0);
  });

  it('a settings-hooks session is never headless', () => {
    const fleet = new Fleet(db, CFG, () => clock);
    fleet.ingestHook({ hook_event_name: 'SessionStart', session_id: 'hook-only', cwd: '/Users/dev/skills' });
    expect(isHeadless(db.getSession('hook-only')!)).toBe(false);
  });

  it('a session first stored as detached before the history was tracked stays unknown, not headless', () => {
    const fleet = new Fleet(db, CFG, () => clock);
    fleet.ingest(report('long-lived', undefined, 'work'));
    db.db.prepare("UPDATE sessions SET attached = 0, attached_ever = NULL WHERE id = 'long-lived'").run();
    fleet.ingest(report('long-lived', false, 'work'));
    expect(db.getSession('long-lived')!.attached_ever).toBeNull();
    expect(isHeadless(db.getSession('long-lived')!)).toBe(false);
  });

  it('a feed read finds the interactive lines behind a page of headless ones', () => {
    const fleet = new Fleet(db, CFG, () => clock);
    fleet.ingest(report('terminal', true, 'work'));
    for (let i = 0; i < 40; i++) {
      const r = report(`scan-${i}`, false);
      r.events = [{ id: `scan-${i}:start`, t: T0 + 1000 + i, kind: 'start', agentId: null, text: 'session.start', data: null }] as unknown as Report['events'];
      fleet.ingest(r);
    }
    expect(fleet.events({ limit: 10 }).map((e) => e.sessionId)).toEqual(['terminal']);
    expect(fleet.state().events.map((e) => e.sessionId)).toEqual(['terminal']);
  });

  it('a session attached when the history began to be kept is not taken for headless when it detaches', () => {
    const fleet = new Fleet(db, CFG, () => clock);
    fleet.ingest(report('open-window', true, 'work'));
    db.db.prepare("UPDATE sessions SET attached_ever = NULL WHERE id = 'open-window'").run();
    fleet.ingest(report('open-window', false, 'work'));
    expect(db.getSession('open-window')!.attached_ever).toBe(1);
    expect(feedIds(fleet, 'open-window').length).toBeGreaterThan(0);
  });

  it('SHOW_HEADLESS_FEED=1 brings the lines back', () => {
    expect(configFromEnv({}, { home: '/h', dbPath: ':memory:' }).hideHeadlessFeed).toBe(true);
    expect(configFromEnv({ SHOW_HEADLESS_FEED: '1' }, { home: '/h', dbPath: ':memory:' }).hideHeadlessFeed).toBe(false);
    const fleet = new Fleet(db, { ...CFG, hideHeadlessFeed: false }, () => clock);
    fleet.ingest(report('headless', false));
    expect(feedIds(fleet, 'headless').length).toBeGreaterThan(0);
  });

  it('a first report with no answer yet and a later one with none attached is headless', () => {
    const fleet = new Fleet(db, CFG, () => clock);
    fleet.ingest(report('slow-roster', null));
    expect(db.getSession('slow-roster')!.attached_ever).toBeNull();
    fleet.ingest(report('slow-roster', false));
    expect(db.getSession('slow-roster')!.attached_ever).toBe(0);
    expect(isHeadless(db.getSession('slow-roster')!)).toBe(true);
  });
});

describe('attachedEver', () => {
  it.each([
    [true, undefined, 1],
    [true, { attached: 0, attached_ever: 0 }, 1],
    [false, undefined, 0],
    [false, { attached: 1, attached_ever: 1 }, 1],
    [false, { attached: 0, attached_ever: 0 }, 0],
    [false, { attached: 0, attached_ever: null }, null],
    [false, { attached: 1, attached_ever: null }, 1],
    [false, { attached: null, attached_ever: null }, 0],
    [null, undefined, null],
    [null, { attached: 0, attached_ever: 0 }, 0],
    [undefined, { attached: 1, attached_ever: 1 }, 1],
  ] as const)('report %s over %j gives %s', (attached, prev, want) => {
    expect(attachedEver(attached, prev as { attached: number | null; attached_ever?: number | null } | undefined)).toBe(want);
  });
});

describe('a card named after its cmux tab', () => {
  it('shows the tab title on the card and in the feed lines, and the reporter name once the tab is gone', () => {
    const fleet = new Fleet(db, CFG, () => clock);
    let title: string | null = 'Orchestrator';
    fleet.names = { titleFor: (id) => (id === 'terminal' ? title : null) };
    const sent: string[] = [];
    fleet.hub.add({ write: (c: string) => void sent.push(c) });
    fleet.ingest(report('terminal', true, 'Code'));
    expect(fleet.view('terminal')!.name).toBe('Orchestrator');
    expect(feedIds(fleet, 'terminal')[0]!.sessionName).toBe('Orchestrator');
    expect(sent.join('')).toContain('"sessionName":"Orchestrator"');
    title = null;
    expect(fleet.view('terminal')!.name).toBe('Code');
    expect(db.getSession('terminal')!.name).toBe('Code');
  });

  it('a session the source does not know keeps the name the reporter sent, and with no source nothing changes', () => {
    const fleet = new Fleet(db, CFG, () => clock);
    fleet.ingest(report('plain', true, 'Code'));
    expect(fleet.view('plain')!.name).toBe('Code');
    fleet.names = { titleFor: () => null };
    expect(fleet.view('plain')!.name).toBe('Code');
    expect(feedIds(fleet, 'plain')[0]!.sessionName).toBe('Code');
  });
});
