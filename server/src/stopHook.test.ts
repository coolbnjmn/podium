import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { forwardBody, tokenFor, nextCronAt as hookNextCronAt } from '../../mod/podium-reporter/hooks/stop-hook.mjs';

const SCRIPT = fileURLToPath(new URL('../../mod/podium-reporter/hooks/stop-hook.mjs', import.meta.url));

const stop = {
  hook_event_name: 'Stop',
  session_id: 's-1',
  cwd: '/Users/dev/x',
  transcript_path: '/Users/dev/.claude/projects/x/s-1.jsonl',
  last_assistant_message: 'private answer text',
  background_tasks: [{ id: 'b1', type: 'shell', status: 'running', description: 'build', command: 'API_KEY=hunter2 make' }],
  session_crons: [{ id: 'c1', schedule: '*/3 * * * *', recurring: true, prompt: 'status update' }],
};

describe('forwardBody', () => {
  it('keeps the session, folder, background tasks and wake-ups of a Stop, and nothing else', () => {
    const body = forwardBody(stop)!;
    expect(Object.keys(body).sort()).toEqual(['background_tasks', 'cwd', 'hook_event_name', 'session_crons', 'session_id']);
    expect(JSON.stringify(body)).not.toMatch(/private answer|transcript|hunter2/);
    expect(body.background_tasks).toEqual([{ id: 'b1', type: 'shell', status: 'running', description: 'build' }]);
  });

  it('sends only the event and the session for a new prompt, and nothing for any other event', () => {
    expect(forwardBody({ hook_event_name: 'UserPromptSubmit', session_id: 's-1', cwd: '/x', prompt: 'secret prompt' })).toEqual({ hook_event_name: 'UserPromptSubmit', session_id: 's-1', cwd: '/x' });
    expect(forwardBody({ hook_event_name: 'PreToolUse', session_id: 's-1' })).toBeNull();
    expect(forwardBody({ hook_event_name: 'Stop' })).toBeNull();
    expect(forwardBody('nope')).toBeNull();
  });

  it('cuts a wake-up\'s own prompt to the length the card shows', () => {
    const long = 'x'.repeat(500);
    expect(forwardBody({ ...stop, session_crons: [{ id: 'c1', schedule: '* * * * *', prompt: long }] })!.session_crons![0]!.prompt).toHaveLength(120);
  });

  it('adds when each wake-up next fires, in this machine\'s time zone, and leaves it out for a schedule it cannot read', () => {
    const body = forwardBody({ ...stop, session_crons: [{ id: 'c1', schedule: '*/3 * * * *', prompt: 'x' }, { id: 'c2', schedule: 'every day', prompt: 'y' }] })!;
    expect(typeof body.session_crons![0]!.next_at).toBe('number');
    expect(body.session_crons![0]!.next_at! - Date.now()).toBeLessThanOrEqual(180_000);
    expect(body.session_crons![1]!.next_at).toBeUndefined();
  });

  it('reads a schedule exactly as the reporter does (the hook carries a copy of its parser)', async () => {
    // Loaded by a path built at run time: the reporter's source is outside this package's compiled tree.
    const cronFile = fileURLToPath(new URL('../../mod/podium-reporter/hooks/cron.ts', import.meta.url));
    const { nextCronAt } = (await import(/* @vite-ignore */ cronFile)) as { nextCronAt: (s: string, from: number) => number | null };
    const from = new Date(2026, 10, 4, 14, 5, 17).getTime();
    for (const s of ['*/3 * * * *', '7 */3 * * *', '0 9 * * 1-5', '30 14 4 11 *', '0,30 * * * *', '5-10/2 8 * * 0', '0 0 29 2 *', '* * * * *', '61 * * * *', 'a b c d e', '1 2 3', '0 9 * * 7', '*/0 * * * *']) {
      expect(hookNextCronAt(s, from), s).toBe(nextCronAt(s, from));
    }
  });

  it('caps the lists', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ id: `c${i}`, schedule: '* * * * *', prompt: 'x' }));
    expect(forwardBody({ ...stop, session_crons: many })!.session_crons).toHaveLength(20);
  });
});

describe('tokenFor', () => {
  it('reads the local config file only for a server on this machine', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stophook-'));
    fs.mkdirSync(path.join(home, '.podium'));
    fs.writeFileSync(path.join(home, '.podium', 'config.env'), 'OTHER=1\nPODIUM_TOKEN="tok-from-file"\n');
    expect(tokenFor('http://127.0.0.1:4317', {}, home)).toBe('tok-from-file');
    expect(tokenFor('http://localhost:4317', {}, home)).toBe('tok-from-file');
    expect(tokenFor('https://podium.example.com', {}, home)).toBe('');
    expect(tokenFor('http://127.0.0.1.evil.example', {}, home)).toBe('');
    expect(tokenFor('https://podium.example.com', { PODIUM_TOKEN: 'from-env' }, home)).toBe('from-env');
    expect(tokenFor('http://127.0.0.1:4317', {}, path.join(home, 'nope'))).toBe('');
  });
});

let servers: http.Server[] = [];
afterEach(() => {
  for (const s of servers) s.close();
  servers = [];
});

function listen(): Promise<{ port: number; got: { headers: http.IncomingHttpHeaders; body: string }[] }> {
  const got: { headers: http.IncomingHttpHeaders; body: string }[] = [];
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        got.push({ headers: req.headers, body });
        res.end('{}');
      });
    });
    servers.push(s);
    s.listen(0, '127.0.0.1', () => resolve({ port: (s.address() as { port: number }).port, got }));
  });
}

function run(stdin: string, env: Record<string, string>): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], { env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('close', resolve);
    child.stdin.end(stdin);
  });
}

describe('stop-hook.mjs', () => {
  it('posts the trimmed Stop to the server with the token from the server\'s own config file, and exits 0', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stophook-'));
    fs.mkdirSync(path.join(home, '.podium'));
    fs.writeFileSync(path.join(home, '.podium', 'config.env'), 'PODIUM_TOKEN=tok-from-file\n');
    const { port, got } = await listen();
    expect(await run(JSON.stringify(stop), { HOME: home, PODIUM_URL: `http://127.0.0.1:${port}` })).toBe(0);
    expect(got).toHaveLength(1);
    expect(got[0]!.headers['x-podium-token']).toBe('tok-from-file');
    expect(JSON.parse(got[0]!.body)).toMatchObject({ hook_event_name: 'Stop', session_id: 's-1' });
    expect(got[0]!.body).not.toMatch(/private answer|transcript|hunter2/);
  });

  it('never sends the config file\'s token to a server that is not on this machine, and still exits 0', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stophook-'));
    fs.mkdirSync(path.join(home, '.podium'));
    fs.writeFileSync(path.join(home, '.podium', 'config.env'), 'PODIUM_TOKEN=tok-from-file\n');
    // 192.0.2.1 is a documentation address nothing answers on; the script must give up quickly and exit 0.
    expect(await run(JSON.stringify(stop), { HOME: home, PODIUM_URL: 'http://192.0.2.1:9', STOP_HOOK_TIMEOUT_MS: '300' })).toBe(0);
  });

  it('exits 0 on garbage input or when the server is down', async () => {
    expect(await run('not json', { HOME: os.tmpdir() })).toBe(0);
    expect(await run(JSON.stringify(stop), { HOME: os.tmpdir(), PODIUM_URL: 'http://127.0.0.1:1' })).toBe(0);
  });
});
