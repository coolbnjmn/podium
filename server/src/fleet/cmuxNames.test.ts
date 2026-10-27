// Card names from cmux tab titles: the resolver's parsing, its refresh rules and what it does when cmux or a hook file misbehaves.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanTitle, CmuxNames, cmuxNamesFromEnv, cmuxNamesOn, defaultHookFiles, parseHookSessions, parseWorkspaceTitles } from './cmuxNames.js';
import { silentLogger, type Logger } from '../logging/logger.js';

const WS_A = '191435E4-457D-43F6-A92B-FC731B8391EA';
const WS_B = '9DAA108D-E1FD-4EE0-A0EF-D42AFD944A36';

const list = (...ws: { id: string; custom_title?: string | null; title?: string }[]) => JSON.stringify({ window_ref: 'window:1', workspaces: ws });
const hooks = (map: Record<string, string>) => JSON.stringify({ version: 1, sessions: Object.fromEntries(Object.entries(map).map(([s, w]) => [s, { sessionId: s, workspaceId: w, cwd: '/x' }])) });

let dir: string;
let file: string;
let warnings: { event: string; fields?: Record<string, unknown> }[];
let logger: Logger;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmux-names-'));
  file = path.join(dir, 'claude-hook-sessions.json');
  warnings = [];
  logger = { ...silentLogger, warn: (event: string, _m: string, fields?: Record<string, unknown>) => void warnings.push({ event, fields }) } as unknown as Logger;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('parsing', () => {
  it('takes the title the person gave, then cmux own title, and ignores blank ones', () => {
    const m = parseWorkspaceTitles(list({ id: WS_A, custom_title: 'Orchestrator', title: 'zsh' }, { id: WS_B, custom_title: null, title: 'Podium' }, { id: 'x', custom_title: '  ', title: '' }));
    expect([...m]).toEqual([[WS_A, 'Orchestrator'], [WS_B, 'Podium']]);
  });

  it('rejects JSON that is not a workspace list', () => {
    expect(() => parseWorkspaceTitles('{"nope":1}')).toThrow('no_workspaces_array');
    expect(() => parseWorkspaceTitles('not json')).toThrow();
  });

  it('maps sessions to upper-cased workspace ids and skips entries without one', () => {
    const m = parseHookSessions(JSON.stringify({ sessions: { s1: { workspaceId: WS_A.toLowerCase() }, s2: {}, s3: null } }));
    expect([...m]).toEqual([['s1', WS_A]]);
    expect(() => parseHookSessions('{"sessions":null}')).toThrow('no_sessions_object');
  });

  it('cleans a title: control characters and runs of space out, cut at 80', () => {
    expect(cleanTitle('a\u0000b\n  c')).toBe('a b c');
    expect(cleanTitle('x'.repeat(200))).toHaveLength(80);
    expect(cleanTitle(5)).toBeNull();
    expect(cleanTitle('\u0001')).toBeNull();
  });
});

describe('the resolver', () => {
  it('gives a session the title of the tab it runs in, and nothing for one cmux does not know', async () => {
    fs.writeFileSync(file, hooks({ sess1: WS_A, sess2: 'GONE' }));
    const names = new CmuxNames(logger, async () => list({ id: WS_A, custom_title: 'Orchestrator' }), [file]);
    expect(names.titleFor('sess1')).toBeNull(); // nothing refreshed yet
    await names.refresh();
    expect(names.titleFor('sess1')).toBe('Orchestrator');
    expect(names.titleFor('sess2')).toBeNull();
    expect(names.titleFor('unknown')).toBeNull();
  });

  it('picks up a rename on the next refresh, and a session that moved tabs when the hook file changes', async () => {
    fs.writeFileSync(file, hooks({ sess1: WS_A }));
    let title = 'Orchestrator';
    const names = new CmuxNames(logger, async () => list({ id: WS_A, custom_title: title }, { id: WS_B, custom_title: 'Other' }), [file]);
    await names.refresh();
    title = 'Chief';
    await names.refresh();
    expect(names.titleFor('sess1')).toBe('Chief');
    fs.writeFileSync(file, hooks({ sess1: WS_B, extra: WS_A }));
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    await names.refresh();
    expect(names.titleFor('sess1')).toBe('Other');
  });

  it('reads the Codex file too', async () => {
    const codex = path.join(dir, 'codex-hook-sessions.json');
    fs.writeFileSync(file, hooks({ c1: WS_A }));
    fs.writeFileSync(codex, hooks({ x1: WS_B }));
    const names = new CmuxNames(logger, async () => list({ id: WS_A, custom_title: 'A' }, { id: WS_B, custom_title: 'Manual PR Reviewer' }), [file, codex]);
    await names.refresh();
    expect(names.titleFor('x1')).toBe('Manual PR Reviewer');
    expect(names.titleFor('c1')).toBe('A');
  });

  it('keeps the last titles when cmux fails, logs once per reason, and logs again after a recovery', async () => {
    fs.writeFileSync(file, hooks({ sess1: WS_A }));
    let mode: 'ok' | 'missing' | 'garbage' = 'ok';
    const names = new CmuxNames(
      logger,
      async () => {
        if (mode === 'missing') throw new Error('spawn ENOENT');
        return mode === 'garbage' ? '{"workspaces":"x"}' : list({ id: WS_A, custom_title: 'Orchestrator' });
      },
      [file],
    );
    await names.refresh();
    mode = 'missing';
    await names.refresh();
    await names.refresh();
    expect(names.titleFor('sess1')).toBe('Orchestrator');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ event: 'cmux_names.refresh_failed', fields: { source: 'cmux', reason: 'spawn ENOENT' } });
    mode = 'garbage';
    await names.refresh();
    expect(warnings).toHaveLength(2);
    mode = 'ok';
    await names.refresh();
    mode = 'missing';
    await names.refresh();
    expect(warnings).toHaveLength(3);
  });

  it('treats a missing hook file as normal and a garbled or oversized one as a logged failure that keeps the old map', async () => {
    const names = new CmuxNames(logger, async () => list({ id: WS_A, custom_title: 'Orchestrator' }), [file]);
    await names.refresh();
    expect(warnings).toHaveLength(0);
    expect(names.titleFor('sess1')).toBeNull();
    fs.writeFileSync(file, hooks({ sess1: WS_A }));
    await names.refresh();
    expect(names.titleFor('sess1')).toBe('Orchestrator');
    fs.writeFileSync(file, '{"sessions":');
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    await names.refresh();
    expect(names.titleFor('sess1')).toBe('Orchestrator');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.fields).toMatchObject({ source: 'claude-hook-sessions.json' });
    fs.writeFileSync(file, `{"sessions":{"a":{"workspaceId":"${'x'.repeat(5 * 1024 * 1024)}"}}}`);
    fs.utimesSync(file, new Date(), new Date(Date.now() + 10_000));
    await names.refresh();
    expect(warnings).toHaveLength(2);
    expect(warnings[1]!.fields).toMatchObject({ reason: 'hook_file_too_large' });
  });

  it('forgets the sessions of a hook file that is deleted', async () => {
    fs.writeFileSync(file, hooks({ sess1: WS_A }));
    const names = new CmuxNames(logger, async () => list({ id: WS_A, custom_title: 'Orchestrator' }), [file]);
    await names.refresh();
    fs.rmSync(file);
    await names.refresh();
    expect(names.titleFor('sess1')).toBeNull();
  });

  it('never runs two refreshes at once', async () => {
    fs.writeFileSync(file, hooks({}));
    let calls = 0;
    let release: () => void = () => undefined;
    const names = new CmuxNames(logger, () => new Promise<string>((resolve) => { calls++; release = () => resolve(list()); }), [file]);
    const first = names.refresh();
    await names.refresh();
    expect(calls).toBe(1);
    release();
    await first;
    const again = names.refresh();
    expect(calls).toBe(2);
    release();
    await again;
  });

  it('start refreshes at once and stop ends the timer', async () => {
    fs.writeFileSync(file, hooks({ sess1: WS_A }));
    let calls = 0;
    const names = new CmuxNames(logger, async () => (calls++, list({ id: WS_A, custom_title: 'T' })), [file]);
    const stop = names.start(10_000_000);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(1);
    expect(names.titleFor('sess1')).toBe('T');
    stop();
  });
});

describe('the switch', () => {
  it('is off unless PODIUM_CMUX_NAMES is 1 or true', () => {
    expect(cmuxNamesOn({})).toBe(false);
    expect(cmuxNamesOn({ PODIUM_CMUX_NAMES: '0' })).toBe(false);
    expect(cmuxNamesOn({ PODIUM_CMUX_NAMES: '1' })).toBe(true);
    expect(cmuxNamesOn({ PODIUM_CMUX_NAMES: 'TRUE' })).toBe(true);
    expect(cmuxNamesFromEnv({}, logger, dir)).toBeNull();
    expect(cmuxNamesFromEnv({ PODIUM_CMUX_NAMES: '1' }, logger, dir)).toBeInstanceOf(CmuxNames);
  });

  it('reads the two cmux hook files under the home folder', () => {
    expect(defaultHookFiles('/h')).toEqual(['/h/.cmuxterm/claude-hook-sessions.json', '/h/.cmuxterm/codex-hook-sessions.json']);
  });

  it('runs the real cmux binary the owner names, and a missing one is a logged failure that changes nothing', async () => {
    const script = path.join(dir, 'fake-cmux');
    fs.writeFileSync(script, `#!/bin/sh\nif [ "$1 $2 $3" = "workspace list --json" ]; then echo '${list({ id: WS_A, custom_title: 'Fake tab' })}'; else exit 3; fi\n`, { mode: 0o755 });
    fs.writeFileSync(file, hooks({ sess1: WS_A }));
    const ok = new CmuxNames(logger, (await import('./cmuxNames.js')).execList(script), [file]);
    await ok.refresh();
    expect(ok.titleFor('sess1')).toBe('Fake tab');
    const gone = new CmuxNames(logger, (await import('./cmuxNames.js')).execList(path.join(dir, 'nope')), [file]);
    await gone.refresh();
    expect(gone.titleFor('sess1')).toBeNull();
    expect(warnings.at(-1)!.event).toBe('cmux_names.refresh_failed');
  });
});
