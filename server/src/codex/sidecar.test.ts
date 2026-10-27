import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, Fleet } from '../fleet/fleet.js';
import { validateReport, type Report } from '../fleet/protocol.js';
import { openDb, FleetDb } from '../fleet/db.js';
import { createLogger, type Logger } from '../logging/logger.js';
import { configFromEnv, isInteractiveCodex, makeSidecar, MAX_FILES, parsePs, parseEnvFile, Sidecar, workspaceIdIn, type SidecarConfig, type SidecarDeps } from './sidecar.js';
import { complete, message, meta, SECRET_TEXT, started, T0, tmpDir, tokens, turnContext, writeRollout } from './testing.js';

const dirs: string[] = [];
const dir = () => {
  const d = tmpDir();
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Report;
  raw: string;
}

function setup(over: { token?: string | null; status?: (r: Report) => number; throws?: boolean; titles?: Record<string, string>; workspaces?: Record<string, string>; processTab?: SidecarDeps['processTab']; userName?: string | null } = {}) {
  const root = dir();
  const sessionsDir = path.join(root, 'sessions');
  const home = path.join(root, 'home');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const logs: { level: string; event: string; fields: unknown; line: string }[] = [];
  const logger: Logger = createLogger({ level: 'debug', format: 'json', write: (line, level) => logs.push({ level, event: (JSON.parse(line) as { event: string }).event, fields: JSON.parse(line), line }) });
  const sent: Sent[] = [];
  const state = { now: T0 + 60_000, status: over.status, throws: over.throws ?? false };
  const config: SidecarConfig = { enabled: true, url: 'http://127.0.0.1:4317', token: over.token === undefined ? 'pdm_secret_token_value' : over.token, userName: over.userName ?? null, sessionsDir, indexFile: path.join(root, 'session_index.jsonl'), home };
  const fakeFetch = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    if (state.throws) throw new Error('ECONNREFUSED');
    const body = JSON.parse(init.body) as Report;
    sent.push({ url, headers: init.headers, body, raw: init.body });
    return new Response('{}', { status: state.status ? state.status(body) : 200 });
  }) as unknown as typeof fetch;
  const names = { titleFor: (id: string) => over.titles?.[id] ?? null, titleOfWorkspace: (id: string) => over.workspaces?.[id] ?? null };
  const sidecar = new Sidecar({ config, logger, fetch: fakeFetch, names, now: () => state.now, processTab: over.processTab });
  return { sidecar, sessionsDir, config, logs, sent, state, root };
}

const interactive = (id: string, cwd = '/Users/dev/app') => [meta(id, cwd, 'vscode'), turnContext('gpt-5-codex'), started('t1', T0 + 1000), tokens(2000, 500, 80, 1800, T0 + 2000), complete('t1', T0 + 3000)];

describe('Sidecar', () => {
  it('posts a card for an interactive session and one folded card for its headless runs, with the token as a header and no text', async () => {
    const t = setup({ titles: { i1: '"Manual" PR Reviewer', e1: 'Statsig Clean Up', e2: 'Statsig Clean Up' } });
    writeRollout(t.sessionsDir, 'i1', [...interactive('i1'), message()]);
    writeRollout(t.sessionsDir, 'e1', [meta('e1', '/p/one', 'exec'), turnContext('gpt-5-codex'), started('a', T0 + 1000), complete('a', T0 + 2000)]);
    writeRollout(t.sessionsDir, 'e2', [meta('e2', '/p/two', 'exec'), started('b', T0 + 1000), complete('b', T0 + 2000)]);
    const r = await t.sidecar.tick();
    expect(r).toMatchObject({ reports: 2, posted: 2, failed: 0 });
    expect(t.sent.map((s) => s.body.session.name).sort()).toEqual(['"Manual" PR Reviewer', 'Statsig Clean Up · codex runs']);
    for (const s of t.sent) {
      expect(s.url).toBe('http://127.0.0.1:4317/api/fleet/report');
      expect(s.headers['x-podium-token']).toBe('pdm_secret_token_value');
      expect(s.raw).not.toContain(SECRET_TEXT);
      expect(s.raw).not.toContain('pdm_secret_token_value');
      expect(validateReport(JSON.parse(s.raw)).ok).toBe(true);
    }
    expect(JSON.stringify(t.logs)).not.toContain('pdm_secret_token_value');
  });

  it('sends the person it is configured as, and no token header when it has none', async () => {
    const t = setup({ token: null, userName: 'Ben' });
    writeRollout(t.sessionsDir, 'i1', interactive('i1'));
    await t.sidecar.tick();
    expect(t.sent[0]!.body.userName).toBe('Ben');
    expect(t.sent[0]!.headers['x-podium-token']).toBeUndefined();
  });

  it('is taken in by the real server: a Codex card on the wall, badged codex, headless runs not in the feed', async () => {
    const t = setup();
    writeRollout(t.sessionsDir, 'i1', interactive('i1'));
    writeRollout(t.sessionsDir, 'e1', [meta('e1', '/p/one', 'exec'), started('a', T0 + 1000)]);
    await t.sidecar.tick();
    const db = new FleetDb(openDb(':memory:'));
    const fleet = new Fleet(db, { ...DEFAULT_CONFIG, home: '/Users/dev', dbPath: ':memory:' }, () => T0 + 60_000);
    for (const s of t.sent) expect(fleet.ingest(s.body).sessionId).toMatch(/^codex:/);
    const state = fleet.state();
    expect(state.sessions.map((s) => [s.agent, s.status]).sort()).toEqual([['codex', 'running'], ['codex', 'waiting']]);
    expect(state.sessions.every((s) => s.reporter === 'mod' && s.compat === 'ok')).toBe(true);
    expect(state.events).toEqual([]);
  });

  it('reads only what was appended, and a turn that finishes turns the card idle', async () => {
    const t = setup();
    const file = writeRollout(t.sessionsDir, 'i1', [meta('i1', '/a', 'vscode'), started('t1', T0 + 1000)]);
    await t.sidecar.tick();
    expect(t.sent.at(-1)!.body.session.status).toBe('running');
    fs.appendFileSync(file, complete('t1', T0 + 2000) + '\n');
    await t.sidecar.tick();
    expect(t.sent.at(-1)!.body.session.status).toBe('waiting');
  });

  it('names a session by its Codex thread when cmux does not know it, from the index', async () => {
    const t = setup();
    fs.writeFileSync(t.config.indexFile, ['not json', JSON.stringify({ id: 'i1', thread_name: 'Review PR 747', updated_at: 'x' }), JSON.stringify({ id: 5 })].join('\n') + '\n');
    writeRollout(t.sessionsDir, 'i1', interactive('i1'));
    await t.sidecar.tick();
    expect(t.sent[0]!.body.session.name).toBe('Review PR 747');
  });

  it('works with no index, no cmux hook file, and no date folders at all', async () => {
    const t = setup();
    expect(await t.sidecar.tick()).toMatchObject({ files: 0, reports: 0, posted: 0 });
    expect(t.logs.filter((l) => l.level === 'warn' || l.level === 'error')).toEqual([]);
  });

  it('survives a rollout that is garbled or cut off mid-line, and reports the sessions that are fine', async () => {
    const t = setup();
    writeRollout(t.sessionsDir, 'bad', ['{"type":"session_meta","payload":{"id":', 'garbage']);
    const f = writeRollout(t.sessionsDir, 'cut', interactive('cut'));
    fs.appendFileSync(f, '{"type":"event_msg","payl');
    writeRollout(t.sessionsDir, 'ok', interactive('ok'));
    const r = await t.sidecar.tick();
    expect(r.posted).toBe(2);
    expect(t.sent.map((s) => s.body.session.id).sort()).toEqual(['codex:cut', 'codex:ok']);
  });

  it('stops following a file that disappears', async () => {
    const t = setup();
    const f = writeRollout(t.sessionsDir, 'i1', interactive('i1'));
    await t.sidecar.tick();
    fs.rmSync(f);
    const r = await t.sidecar.tick();
    expect(r.files).toBe(0);
    expect(r.reports).toBe(0);
  });

  it('leaves out a file older than a day', async () => {
    const t = setup();
    writeRollout(t.sessionsDir, 'old', interactive('old'), T0 - 3 * 86_400_000);
    t.state.now = T0 + 5 * 86_400_000;
    expect((await t.sidecar.tick()).files).toBe(0);
  });

  it('follows at most MAX_FILES files', async () => {
    const t = setup();
    for (let i = 0; i < MAX_FILES + 25; i++) writeRollout(t.sessionsDir, `f${i}`, [meta(`f${i}`, '/a', 'exec')]);
    expect((await t.sidecar.tick()).files).toBe(MAX_FILES);
  });

  describe('when the server cannot be used', () => {
    it('pauses for a minute when it does not answer, says so once, and carries on when it is back', async () => {
      const t = setup({ throws: true });
      writeRollout(t.sessionsDir, 'i1', interactive('i1'));
      writeRollout(t.sessionsDir, 'e1', [meta('e1', '/p', 'exec')]);
      expect(await t.sidecar.tick()).toMatchObject({ posted: 0, failed: 1 });
      expect(await t.sidecar.tick()).toMatchObject({ skipped: 'backoff' });
      t.state.now += 61_000;
      await t.sidecar.tick();
      expect(t.logs.filter((l) => l.event === 'codex_sidecar.server_unreachable')).toHaveLength(1);
      t.state.throws = false;
      t.state.now += 61_000;
      expect((await t.sidecar.tick()).posted).toBe(2);
    });

    it('stops when the token is refused, says so once without printing it, and tries again after a minute', async () => {
      const t = setup({ status: () => 401 });
      writeRollout(t.sessionsDir, 'i1', interactive('i1'));
      writeRollout(t.sessionsDir, 'e1', [meta('e1', '/p', 'exec')]);
      await t.sidecar.tick();
      expect(t.sent).toHaveLength(1);
      expect(await t.sidecar.tick()).toMatchObject({ skipped: 'backoff' });
      t.state.now += 61_000;
      await t.sidecar.tick();
      const refused = t.logs.filter((l) => l.event === 'codex_sidecar.token_refused');
      expect(refused).toHaveLength(1);
      expect(refused[0]!.line).not.toContain('pdm_secret_token_value');
    });

    it('logs a report the server refuses by session and status, and still posts the others', async () => {
      const t = setup({ status: (r) => (r.session.id === 'codex:bad' ? 422 : 200) });
      writeRollout(t.sessionsDir, 'bad', interactive('bad'));
      writeRollout(t.sessionsDir, 'good', interactive('good'));
      const r = await t.sidecar.tick();
      expect(r).toMatchObject({ posted: 1, failed: 1 });
      expect(t.logs.find((l) => l.event === 'codex_sidecar.report_refused')?.fields).toMatchObject({ session: 'codex:bad', status: 422 });
    });
  });

  describe('finding the tab of a session cmux does not list', () => {
    it('asks the process lookup for an interactive session, uses the answer, and does not ask again', async () => {
      const calls: number[] = [];
      const t = setup({ workspaces: { WS1: '"Manual" PR Reviewer' }, processTab: async (at) => (calls.push(at), 'WS1') });
      writeRollout(t.sessionsDir, 'i1', interactive('i1'));
      writeRollout(t.sessionsDir, 'e1', [meta('e1', '/p', 'exec')]);
      await t.sidecar.tick();
      await t.sidecar.tick();
      expect(t.sent.find((s) => s.body.session.id === 'codex:i1')!.body.session.name).toBe('"Manual" PR Reviewer');
      expect(calls).toEqual([T0]);
    });

    it('reads the tab title again every pass, so a renamed tab shows its new name without another process lookup', async () => {
      const workspaces: Record<string, string> = { WS1: 'Old name' };
      let lookups = 0;
      const t = setup({ workspaces, processTab: async () => (lookups++, 'WS1') });
      writeRollout(t.sessionsDir, 'i1', interactive('i1'));
      await t.sidecar.tick();
      expect(t.sent.at(-1)!.body.session.name).toBe('Old name');
      workspaces.WS1 = 'New name';
      await t.sidecar.tick();
      expect(t.sent.at(-1)!.body.session.name).toBe('New name');
      expect(lookups).toBe(1);
    });

    it('tries a few times a minute apart, then gives up, and a failing lookup is only a warning', async () => {
      let n = 0;
      const t = setup({ processTab: async () => (n++, Promise.reject(new Error('ps blew up'))) });
      writeRollout(t.sessionsDir, 'i1', interactive('i1'));
      for (let i = 0; i < 6; i++) {
        await t.sidecar.tick();
        t.state.now += 61_000;
      }
      expect(n).toBe(3);
      expect(t.logs.filter((l) => l.event === 'codex_sidecar.process_lookup_failed')).toHaveLength(3);
      expect(t.sent.at(-1)!.body.session.name).toBe('app');
    });
  });

  it('does not let files with nothing new use up the read budget of the ones that have', async () => {
    const t = setup();
    const filler = JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'x'.repeat(8000) } });
    const big = (id: string) => [...interactive(id), ...Array.from({ length: 80 }, () => filler)]; // about 640 KiB: a whole read each
    const files: string[] = [];
    for (let i = 0; i < 20; i++) files.push(writeRollout(t.sessionsDir, `b${i}`, big(`b${i}`), T0 + i * 1000));
    await t.sidecar.tick();
    await t.sidecar.tick();
    await t.sidecar.tick();
    expect(new Set(t.sent.map((s) => s.body.session.id)).size).toBe(20);
    // every file is read to its end by now, so a new line in the oldest one is picked up at once
    fs.appendFileSync(files[0]!, started('t2', T0 + 50_000) + '\n');
    t.state.now = T0 + 55_000;
    await t.sidecar.tick();
    expect(t.sent.at(-1)!.body.session.id).toBe('codex:b0');
    expect(t.sent.at(-1)!.body.session.status).toBe('running');
  });

  it('keeps the newest files when there are more than it follows, so old runs never shut today\'s session out', async () => {
    const t = setup();
    for (let i = 0; i < MAX_FILES + 10; i++) writeRollout(t.sessionsDir, `old${i}`, [meta(`old${i}`, '/a', 'exec', T0 - 3_600_000)], T0 - 3_600_000);
    writeRollout(t.sessionsDir, 'today', interactive('today'));
    await t.sidecar.tick();
    expect(t.sent.some((s) => s.body.session.id === 'codex:today')).toBe(true);
  });

  it('keeps following a session whose date folder has aged out of the listing, while it is written to', async () => {
    const t = setup();
    const file = writeRollout(t.sessionsDir, 'long', [meta('long', '/a', 'vscode'), started('t1', T0 + 1000)]);
    await t.sidecar.tick();
    t.state.now = T0 + 4 * 86_400_000;
    fs.appendFileSync(file, started('t2', t.state.now - 1000) + '\n');
    fs.utimesSync(file, t.state.now / 1000, t.state.now / 1000);
    const r = await t.sidecar.tick();
    expect(r.files).toBe(1);
    expect(t.sent.at(-1)!.body.session).toMatchObject({ id: 'codex:long', status: 'running' });
  });

  it('gives a Codex card a codex resume command, and a folded card of runs none; never a claude one', async () => {
    const t = setup();
    writeRollout(t.sessionsDir, 'i1', interactive('i1', '/Users/dev/my app'));
    writeRollout(t.sessionsDir, 'e1', [meta('e1', '/p', 'exec'), started('a', T0 + 1000), tokens(100, 0, 10, 100, T0 + 2000)]);
    await t.sidecar.tick();
    const fleet = new Fleet(new FleetDb(openDb(':memory:')), { ...DEFAULT_CONFIG, home: '/Users/dev', dbPath: ':memory:' }, () => T0 + 60_000);
    for (const s of t.sent) fleet.ingest(s.body);
    const byId = new Map(fleet.state().sessions.map((s) => [s.id, s]));
    expect(byId.get('codex:i1')).toMatchObject({ resumeCommand: "cd '/Users/dev/my app' && codex resume i1", forkCommand: '' });
    const folded = [...byId.values()].find((s) => s.id.startsWith('codex:runs:'))!;
    expect(folded).toMatchObject({ resumeCommand: '', forkCommand: '' });
    expect([...byId.values()].some((s) => s.resumeCommand.includes('claude'))).toBe(false);
  });

  it('never runs two passes at once', async () => {
    const t = setup();
    writeRollout(t.sessionsDir, 'i1', interactive('i1'));
    const [a, b] = await Promise.all([t.sidecar.tick(), t.sidecar.tick()]);
    expect(a.posted + b.posted).toBe(1);
  });
});

describe('config and the process helpers', () => {
  it('is off unless PODIUM_CODEX is 1 or true', () => {
    expect(makeSidecar({}, dir())).toBeNull();
    expect(makeSidecar({ PODIUM_CODEX: '0' }, dir())).toBeNull();
    expect(makeSidecar({ PODIUM_CODEX: '1' }, dir())).not.toBeNull();
    expect(configFromEnv({ PODIUM_CODEX: 'true' }, dir()).enabled).toBe(true);
  });

  it('takes the token and port from the podiumctl config file, and the environment wins', () => {
    const home = dir();
    fs.mkdirSync(path.join(home, '.podium'));
    fs.writeFileSync(path.join(home, '.podium', 'config.env'), '# comment\nPODIUM_TOKEN=pdm_from_file\nPODIUMCTL_PORT=4400\n');
    expect(configFromEnv({}, home)).toMatchObject({ token: 'pdm_from_file', url: 'http://127.0.0.1:4400' });
    expect(configFromEnv({ PODIUM_TOKEN: 'pdm_env', PODIUM_URL: 'http://127.0.0.1:9/' }, home)).toMatchObject({ token: 'pdm_env', url: 'http://127.0.0.1:9' });
    expect(configFromEnv({}, dir()).token).toBeNull();
    expect(parseEnvFile('A=1\n# B=2\n C = "x y" \n')).toEqual({ A: '1', C: 'x y' });
  });

  it('tells an interactive codex process from the helpers, and reads the workspace id from a ps line', () => {
    expect(isInteractiveCodex('/opt/homebrew/bin/codex --disable computer_use -c a=b')).toBe(true);
    for (const c of ['/opt/homebrew/bin/codex exec --json -C /x', '/x/codex app-server --listen stdio://', 'codex sandbox -c y', '/usr/bin/vim codex', 'sh -c codex exec']) expect(isInteractiveCodex(c)).toBe(false);
    const ps = [' 16623 Mon Oct 26 20:20:25 2026 /opt/homebrew/bin/codex --disable computer_use', ' 79370 Tue Oct 27 08:03:00 2026 /opt/homebrew/bin/codex exec --json', 'garbage'].join('\n');
    expect(parsePs(ps)).toEqual([{ pid: '16623', startedAt: Date.parse('Mon Oct 26 20:20:25 2026'), command: '/opt/homebrew/bin/codex --disable computer_use' }]);
    expect(workspaceIdIn('x CMUX_WORKSPACE_ID=4B6BC247-8C37-4795-AC3D-C802015EE760 y')).toBe('4B6BC247-8C37-4795-AC3D-C802015EE760');
    expect(workspaceIdIn('nothing here')).toBeNull();
  });
});
