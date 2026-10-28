// Card names from cmux tab titles: the resolver's parsing, its refresh rules and what it does when cmux or a hook file misbehaves.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanTitle, CmuxNames, cmuxNamesFromEnv, cmuxNamesOn, defaultHookFiles, defaultTitlesFile, execList, parseHookSessions, parseWindowIds, parseWorkspaceTitles, readTitlesFile, withTitlesFile, writeTitlesFile } from './cmuxNames.js';
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
    const names = new CmuxNames(logger, async () => [list({ id: WS_A, custom_title: 'Orchestrator' })], [file]);
    expect(names.titleFor('sess1')).toBeNull(); // nothing refreshed yet
    await names.refresh();
    expect(names.titleFor('sess1')).toBe('Orchestrator');
    expect(names.titleFor('sess2')).toBeNull();
    expect(names.titleFor('unknown')).toBeNull();
  });

  it('gives the workspace id a session runs in, with or without a title, and nothing for an unknown session', async () => {
    fs.writeFileSync(file, hooks({ sess1: WS_A, sess2: WS_B }));
    const names = new CmuxNames(logger, async () => [list({ id: WS_A, custom_title: 'Gardener' })], [file]);
    expect(names.workspaceFor('sess1')).toBeNull();
    await names.refresh();
    expect(names.workspaceFor('sess1')).toBe(WS_A.toUpperCase());
    expect(names.workspaceFor('sess2')).toBe(WS_B.toUpperCase());
    expect(names.titleFor('sess2')).toBeNull();
    expect(names.workspaceFor('unknown')).toBeNull();
  });

  it('gives the title of a workspace by its id, for a session found some other way', async () => {
    const names = new CmuxNames(logger, async () => [list({ id: WS_A, custom_title: 'Manual PR Reviewer' })], [file]);
    expect(names.titleOfWorkspace(WS_A)).toBeNull();
    await names.refresh();
    expect(names.titleOfWorkspace(WS_A)).toBe('Manual PR Reviewer');
    expect(names.titleOfWorkspace('nope')).toBeNull();
  });

  it('picks up a rename on the next refresh, and a session that moved tabs when the hook file changes', async () => {
    fs.writeFileSync(file, hooks({ sess1: WS_A }));
    let title = 'Orchestrator';
    const names = new CmuxNames(logger, async () => [list({ id: WS_A, custom_title: title }, { id: WS_B, custom_title: 'Other' })], [file]);
    await names.refresh();
    title = 'Chief';
    await names.refresh();
    expect(names.titleFor('sess1')).toBe('Chief');
    fs.writeFileSync(file, hooks({ sess1: WS_B, extra: WS_A }));
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    await names.refresh();
    expect(names.titleFor('sess1')).toBe('Other');
  });

  it('merges the tabs of every window, and one window that returns garbage keeps the last names', async () => {
    fs.writeFileSync(file, hooks({ a: WS_A, b: WS_B }));
    let second = list({ id: WS_B, custom_title: 'In window two' });
    const names = new CmuxNames(logger, async () => [list({ id: WS_A, custom_title: 'In window one' }), second], [file]);
    await names.refresh();
    expect(names.titleFor('a')).toBe('In window one');
    expect(names.titleFor('b')).toBe('In window two');
    second = 'not json';
    await names.refresh();
    expect(names.titleFor('b')).toBe('In window two');
    expect(warnings.at(-1)!.event).toBe('cmux_names.refresh_failed');
  });

  it('reads the Codex file too', async () => {
    const codex = path.join(dir, 'codex-hook-sessions.json');
    fs.writeFileSync(file, hooks({ c1: WS_A }));
    fs.writeFileSync(codex, hooks({ x1: WS_B }));
    const names = new CmuxNames(logger, async () => [list({ id: WS_A, custom_title: 'A' }, { id: WS_B, custom_title: 'Manual PR Reviewer' })], [file, codex]);
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
        return [mode === 'garbage' ? '{"workspaces":"x"}' : list({ id: WS_A, custom_title: 'Orchestrator' })];
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
    const names = new CmuxNames(logger, async () => [list({ id: WS_A, custom_title: 'Orchestrator' })], [file]);
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
    const names = new CmuxNames(logger, async () => [list({ id: WS_A, custom_title: 'Orchestrator' })], [file]);
    await names.refresh();
    fs.rmSync(file);
    await names.refresh();
    expect(names.titleFor('sess1')).toBeNull();
  });

  it('never runs two refreshes at once', async () => {
    fs.writeFileSync(file, hooks({}));
    let calls = 0;
    let release: () => void = () => undefined;
    const names = new CmuxNames(logger, () => new Promise<string[]>((resolve) => { calls++; release = () => resolve([list()]); }), [file]);
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
    const names = new CmuxNames(logger, async () => (calls++, [list({ id: WS_A, custom_title: 'T' })]), [file]);
    const stop = names.start(10_000_000);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(1);
    expect(names.titleFor('sess1')).toBe('T');
    stop();
  });
});

describe('windows', () => {
  it('lists the window ids and rejects anything that is not a list', () => {
    expect(parseWindowIds('[{"id":"W1"},{"id":""},{"nope":1},null,{"id":"W2"}]')).toEqual(['W1', 'W2']);
    expect(() => parseWindowIds('{"id":"W1"}')).toThrow('no_windows_array');
  });

  it('a cmux that cannot list windows is asked once for its default window', async () => {
    const script = path.join(dir, 'old-cmux');
    fs.writeFileSync(script, `#!/bin/sh\nif [ "$1 $2 $3" = "workspace list --json" ] && [ -z "$4" ]; then echo '${list({ id: WS_A, custom_title: 'Only window' })}'; else exit 2; fi\n`, { mode: 0o755 });
    fs.writeFileSync(file, hooks({ sess1: WS_A }));
    const names = new CmuxNames(logger, execList(script, 30_000), [file]);
    await names.refresh();
    expect(names.titleFor('sess1')).toBe('Only window');
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
    // a feature that only needs the session-to-tab map (the context nudge) can ask for it with the renaming off
    expect(cmuxNamesFromEnv({}, logger, dir, true)).toBeInstanceOf(CmuxNames);
  });

  it('reads the two cmux hook files under the home folder', () => {
    expect(defaultHookFiles('/h')).toEqual(['/h/.cmuxterm/claude-hook-sessions.json', '/h/.cmuxterm/codex-hook-sessions.json']);
  });

  it('runs the real cmux binary the owner names, and a missing one is a logged failure that changes nothing', async () => {
    const script = path.join(dir, 'fake-cmux');
    // two windows: `workspace list --window W2` answers with the second tab; the first window is the default answer
    fs.writeFileSync(
      script,
      `#!/bin/sh\nif [ "$1" = "list-windows" ]; then echo '[{"id":"W1"},{"id":"W2"}]'; elif [ "$1 $2 $3 $4 $5" = "workspace list --json --window W2" ]; then echo '${list({ id: WS_B, custom_title: 'Second window' })}'; elif [ "$1 $2 $3 $4 $5" = "workspace list --json --window W1" ]; then echo '${list({ id: WS_A, custom_title: 'Fake tab' })}'; else exit 3; fi\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(file, hooks({ sess1: WS_A }));
    const ok = new CmuxNames(logger, execList(script, 30_000), [file]);
    await ok.refresh();
    expect(ok.titleFor('sess1')).toBe('Fake tab');
    fs.writeFileSync(file, hooks({ sess1: WS_A, other: WS_B }));
    await ok.refresh();
    expect(ok.titleFor('other')).toBe('Second window');
    const gone = new CmuxNames(logger, execList(path.join(dir, 'nope'), 30_000), [file]);
    await gone.refresh();
    expect(gone.titleFor('sess1')).toBeNull();
    expect(warnings.at(-1)!.event).toBe('cmux_names.refresh_failed');
  });
});

describe('the titles file', () => {
  const NOW = 1_800_000_000_000;
  const refused = async (): Promise<string[]> => {
    throw new Error('Access denied - only processes started inside cmux can connect');
  };

  it('lives under the Podium folder', () => {
    expect(defaultTitlesFile('/home/ben')).toBe(path.join('/home/ben', '.podium', 'cmux-titles.json'));
  });

  it('names the cards from the file when cmux refuses the server, so a login-started server keeps the tab names', async () => {
    const titles = path.join(dir, 'cmux-titles.json');
    writeTitlesFile(titles, [list({ id: WS_A, custom_title: 'Orchestrator' })], NOW - 30_000);
    fs.writeFileSync(file, hooks({ sess1: WS_A }));
    const names = new CmuxNames(logger, withTitlesFile(refused, titles, () => NOW), [file]);
    await names.refresh();
    expect(names.titleFor('sess1')).toBe('Orchestrator');
    expect(warnings).toHaveLength(0);
  });

  it('prefers cmux while it answers, and the file never overrides a live list', async () => {
    const titles = path.join(dir, 'cmux-titles.json');
    writeTitlesFile(titles, [list({ id: WS_A, custom_title: 'Old name' })], NOW);
    fs.writeFileSync(file, hooks({ sess1: WS_A }));
    const names = new CmuxNames(logger, withTitlesFile(async () => [list({ id: WS_A, custom_title: 'New name' })], titles, () => NOW), [file]);
    await names.refresh();
    expect(names.titleFor('sess1')).toBe('New name');
  });

  it('logs the cmux refusal and keeps the last names when the file is stale, missing, garbled or the wrong shape', async () => {
    const titles = path.join(dir, 'cmux-titles.json');
    fs.writeFileSync(file, hooks({ sess1: WS_A }));
    const cases: [string, () => void][] = [
      ['stale', () => writeTitlesFile(titles, [list({ id: WS_A, custom_title: 'Stale' })], NOW - 11 * 60_000)],
      ['missing', () => fs.rmSync(titles, { force: true })],
      ['garbled', () => fs.writeFileSync(titles, '{nope')],
      ['wrong shape', () => fs.writeFileSync(titles, JSON.stringify({ writtenAt: NOW, lists: 'x' }))],
      ['future', () => writeTitlesFile(titles, [list({ id: WS_A, custom_title: 'Future' })], NOW + 11 * 60_000)],
    ];
    for (const [label, arrange] of cases) {
      warnings.length = 0;
      arrange();
      const names = new CmuxNames(logger, withTitlesFile(refused, titles, () => NOW), [file]);
      await names.refresh();
      expect(names.titleFor('sess1'), label).toBeNull();
      expect(warnings, label).toHaveLength(1);
      expect(warnings[0].fields, label).toMatchObject({ source: 'cmux', reason: expect.stringContaining('only processes started inside cmux') });
    }
  });

  it('writes the file whole, owner-only, and reads back what it wrote', () => {
    const titles = path.join(dir, 'nested', 'cmux-titles.json');
    writeTitlesFile(titles, ['a', 'b'], NOW);
    expect(readTitlesFile(titles, NOW)).toEqual(['a', 'b']);
    expect(fs.statSync(titles).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(titles))).toEqual(['cmux-titles.json']);
  });

  it('refuses a file over the size cap', () => {
    const titles = path.join(dir, 'cmux-titles.json');
    fs.writeFileSync(titles, JSON.stringify({ writtenAt: NOW, lists: ['x'.repeat(1_100_000)] }));
    expect(readTitlesFile(titles, NOW)).toBeNull();
  });
});
