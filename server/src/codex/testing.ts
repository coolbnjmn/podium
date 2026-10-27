// Builds rollout files the way Codex writes them, for the sidecar's tests. Message text is filled with a marker so a test can check
// it never reaches a report.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SECRET_TEXT = 'PROMPT-TEXT-THAT-MUST-NOT-LEAVE';

export const T0 = Date.parse('2026-10-27T14:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

export function meta(id: string, cwd: string, source: 'exec' | 'vscode', at: number = T0): string {
  return JSON.stringify({ timestamp: iso(at), type: 'session_meta', payload: { id, session_id: id, timestamp: iso(at), cwd, originator: source === 'exec' ? 'codex_exec' : 'codex-tui', cli_version: '0.164.0', source, base_instructions: SECRET_TEXT } });
}
export const turnContext = (model: string, at: number = T0): string => JSON.stringify({ timestamp: iso(at), type: 'turn_context', payload: { turn_id: 't1', model, cwd: '/x', summary: SECRET_TEXT } });
export const started = (turn: string, at: number = T0, window = 475_000): string => JSON.stringify({ timestamp: iso(at), type: 'event_msg', payload: { type: 'task_started', turn_id: turn, model_context_window: window } });
export const complete = (turn: string, at: number = T0): string => JSON.stringify({ timestamp: iso(at), type: 'event_msg', payload: { type: 'task_complete', turn_id: turn, completed_at: Math.floor(at / 1000), last_agent_message: SECRET_TEXT } });
export const tokens = (input: number, cached: number, output: number, last: number, at: number = T0): string =>
  JSON.stringify({
    timestamp: iso(at),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output }, last_token_usage: { input_tokens: last, output_tokens: 1 }, model_context_window: 475_000 },
    },
  });
export const message = (at: number = T0): string => JSON.stringify({ timestamp: iso(at), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: SECRET_TEXT }] } });

export function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'podium-codex-'));
}

/** A rollout under `<root>/YYYY/MM/DD/` for the day of `at` (local time, as the sidecar lists them). */
export function writeRollout(root: string, id: string, lines: string[], at: number = T0): string {
  const d = new Date(at);
  const dir = path.join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-10-27T14-00-00-${id}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  fs.utimesSync(file, at / 1000, at / 1000);
  return file;
}
