// A Stop and UserPromptSubmit settings hook shipped with the reporter. Claude Code can skip the reporter's own Stop handler, so
// the scheduled wake-ups and background tasks a Stop lists reach Podium only through this hook. It posts a trimmed copy of the
// payload (the session, its folder, and those two lists; never the person's prompt, the answer or the transcript path) to the server's
// hook route, and always exits 0 so a stopped server never gets in the session's way.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_LIST = 20;
/** A wake-up's own prompt and a task's description are what the card shows, cut where the server cuts them. */
const MAX_TEXT = 120;
const MAX_STDIN = 1024 * 1024;
const DEFAULT_URL = 'http://127.0.0.1:4317';
const FORWARDED = new Set(['Stop', 'UserPromptSubmit']);

const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : undefined);

/** The fields of one list entry the server reads; the shell command is never forwarded. */
function entry(e, keys) {
  const out = {};
  if (e && typeof e === 'object') for (const k of keys) if (typeof e[k] === 'string' || typeof e[k] === 'boolean') out[k] = typeof e[k] === 'string' ? e[k].slice(0, MAX_TEXT) : e[k];
  return out;
}

/** What to post for a hook payload, or null when it is not one this hook forwards. */
export function forwardBody(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const event = text(payload.hook_event_name, 60);
  const sid = text(payload.session_id, 200);
  if (!event || !FORWARDED.has(event) || !sid) return null;
  const body = { hook_event_name: event, session_id: sid };
  const cwd = text(payload.cwd, 1024);
  if (cwd) body.cwd = cwd;
  if (event === 'Stop') {
    const list = (v, keys) => (Array.isArray(v) ? v.slice(0, MAX_LIST).map((e) => entry(e, keys)) : []);
    body.background_tasks = list(payload.background_tasks, ['id', 'type', 'status', 'description']);
    body.session_crons = list(payload.session_crons, ['id', 'schedule', 'recurring', 'prompt']);
  }
  return body;
}

const isLoopback = (url) => {
  try {
    const h = new URL(url).hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1';
  } catch {
    return false;
  }
};

/** The token for a server: the plugin option or terminal variable, else the local server's own config file, and that file's only for a server on this machine. */
export function tokenFor(url, env, home) {
  const given = env.CLAUDE_PLUGIN_OPTION_TOKEN || env.PODIUM_TOKEN;
  if (given) return given;
  if (!isLoopback(url)) return '';
  try {
    const line = fs.readFileSync(path.join(home, '.podium', 'config.env'), 'utf8').split('\n').find((l) => l.startsWith('PODIUM_TOKEN='));
    return line ? line.slice('PODIUM_TOKEN='.length).trim().replace(/^["']|["']$/g, '') : '';
  } catch {
    return '';
  }
}

async function readStdin() {
  let size = 0;
  const chunks = [];
  for await (const c of process.stdin) {
    size += c.length;
    if (size > MAX_STDIN) return '';
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return;
  }
  const body = forwardBody(payload);
  if (!body) return;
  const env = process.env;
  const url = (env.CLAUDE_PLUGIN_OPTION_SERVERURL || env.PODIUM_URL || DEFAULT_URL).replace(/\/+$/, '');
  const token = tokenFor(url, env, env.HOME || os.homedir());
  const timeout = Number(env.STOP_HOOK_TIMEOUT_MS) > 0 ? Number(env.STOP_HOOK_TIMEOUT_MS) : 3000;
  try {
    await fetch(`${url}/api/fleet/hook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Podium-Token': token } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    // a stopped or slow server is not the session's problem
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then(() => process.exit(0), () => process.exit(0));
}
