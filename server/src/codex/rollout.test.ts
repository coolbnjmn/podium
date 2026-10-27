import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyLine, emptyFacts, INITIAL_TAIL_BYTES, RolloutFile, TAIL_THRESHOLD_BYTES } from './rollout.js';
import { complete, message, meta, SECRET_TEXT, started, T0, tmpDir, tokens, turnContext } from './testing.js';

const dirs: string[] = [];
const dir = () => {
  const d = tmpDir();
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('applyLine', () => {
  it('reads who the session is, how it started, its model, turns and tokens', () => {
    const f = emptyFacts();
    applyLine(f, meta('abc', '/Users/dev/app', 'vscode'));
    applyLine(f, turnContext('gpt-5-codex'));
    applyLine(f, started('t1', T0 + 1000));
    expect(f).toMatchObject({ sessionId: 'abc', cwd: '/Users/dev/app', source: 'vscode', originator: 'codex-tui', model: 'gpt-5-codex', contextWindow: 475_000, startedAt: T0 });
    expect([...f.openTurns]).toEqual(['t1']);
    applyLine(f, tokens(32_000, 15_000, 170, 32_000, T0 + 2000));
    expect(f.tokens).toEqual({ input: 17_000, output: 170, cacheRead: 15_000, cacheWrite: 0 });
    expect(f.lastPromptTokens).toBe(32_000);
    applyLine(f, complete('t1', T0 + 3000));
    expect(f.openTurns.size).toBe(0);
    expect(f.lastCompleteAt).toBe(T0 + 3000);
    expect(f.lastRecordAt).toBe(T0 + 3000);
  });

  it('keeps no prompt, response or instruction text', () => {
    const f = emptyFacts();
    for (const l of [meta('abc', '/x', 'exec'), turnContext('m'), message(), started('t'), complete('t')]) applyLine(f, l);
    expect(JSON.stringify({ ...f, openTurns: [...f.openTurns] })).not.toContain(SECRET_TEXT);
  });

  it('skips a line that is not JSON, not an object, or not a kind it uses, without throwing', () => {
    const f = emptyFacts();
    for (const l of ['', 'not json', '[1,2]', '{"type":"session_meta"}', '{"type":"session_meta","payload":5}', message(), '{"type":"event_msg","payload":{"type":"agent_message"}}']) expect(() => applyLine(f, l)).not.toThrow();
    expect(f.sessionId).toBeNull();
  });

  it('ignores token numbers that are negative, missing or not numbers', () => {
    const f = emptyFacts();
    applyLine(f, JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: -5, output_tokens: 'x' } } } }));
    expect(f.tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it('holds at most a few dozen open turns', () => {
    const f = emptyFacts();
    for (let i = 0; i < 200; i++) applyLine(f, started(`t${i}`));
    expect(f.openTurns.size).toBeLessThanOrEqual(64);
  });
});

describe('RolloutFile', () => {
  it('reads only appended bytes and uses whole lines only', () => {
    const file = path.join(dir(), 'r.jsonl');
    const first = meta('abc', '/x', 'exec') + '\n' + started('t1');
    fs.writeFileSync(file, first); // the last line has no newline yet: it is not used
    const r = new RolloutFile(file);
    expect(r.read()).toBe(true);
    expect(r.facts.sessionId).toBe('abc');
    expect(r.facts.openTurns.size).toBe(0);
    fs.appendFileSync(file, '\n' + tokens(10, 0, 5, 10) + '\n');
    r.read();
    expect([...r.facts.openTurns]).toEqual(['t1']);
    expect(r.facts.tokens.output).toBe(5);
  });

  it('starts over when the file is replaced or gets shorter', () => {
    const d = dir();
    const file = path.join(d, 'r.jsonl');
    fs.writeFileSync(file, [meta('one', '/x', 'exec'), started('t1'), tokens(10, 0, 5, 10)].join('\n') + '\n');
    const r = new RolloutFile(file);
    r.read();
    fs.writeFileSync(file, meta('two', '/y', 'exec') + '\n'); // shorter: truncated and rewritten
    r.read();
    expect(r.facts).toMatchObject({ sessionId: 'two', cwd: '/y' });
    expect(r.facts.openTurns.size).toBe(0);
    fs.rmSync(file);
    fs.writeFileSync(file, [meta('three', '/z', 'exec'), started('a'), started('b'), started('c')].join('\n') + '\n'); // rotated: a new file, longer
    r.read();
    expect(r.facts.sessionId).toBe('three');
  });

  it('starts over when a longer, different file is written over the same one, inode kept', () => {
    const file = path.join(dir(), 'r.jsonl');
    fs.writeFileSync(file, [meta('one', '/x', 'exec'), started('t1')].join('\n') + '\n');
    const r = new RolloutFile(file);
    r.read();
    const before = fs.statSync(file).ino;
    fs.writeFileSync(file, [meta('two', '/y', 'vscode'), started('a'), started('b'), started('c'), tokens(10, 0, 5, 10)].join('\n') + '\n'); // same path and inode, and longer
    expect(fs.statSync(file).ino).toBe(before);
    r.read();
    expect(r.facts).toMatchObject({ sessionId: 'two', source: 'vscode' });
    expect([...r.facts.openTurns]).toEqual(['a', 'b', 'c']);
  });

  it('reports a file that is gone as unreadable', () => {
    expect(new RolloutFile(path.join(dir(), 'missing.jsonl')).read()).toBe(false);
  });

  it('reads a big file first from its start and its tail, and keeps up after that', () => {
    const file = path.join(dir(), 'big.jsonl');
    const filler = JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'x'.repeat(8000) } });
    const lines = [meta('big', '/b', 'vscode'), started('old'), complete('old')];
    for (let i = 0; i < Math.ceil((TAIL_THRESHOLD_BYTES + 3 * INITIAL_TAIL_BYTES) / filler.length); i++) lines.push(filler);
    lines.push(turnContext('gpt-5'), started('t9'), tokens(500, 100, 50, 500));
    fs.writeFileSync(file, lines.join('\n') + '\n');
    const r = new RolloutFile(file);
    r.read();
    expect(r.facts).toMatchObject({ sessionId: 'big', model: 'gpt-5', source: 'vscode' });
    expect([...r.facts.openTurns]).toEqual(['t9']);
    expect(r.facts.tokens.output).toBe(50);
    fs.appendFileSync(file, complete('t9') + '\n');
    r.read();
    expect(r.facts.openTurns.size).toBe(0);
  });

  it('throws away one line longer than a whole read and carries on after it', () => {
    const file = path.join(dir(), 'long.jsonl');
    fs.writeFileSync(file, meta('long', '/l', 'exec') + '\n' + JSON.stringify({ type: 'x', payload: { t: 'y'.repeat(700 * 1024) } }) + '\n' + started('after') + '\n');
    const r = new RolloutFile(file);
    for (let i = 0; i < 4; i++) r.read();
    expect(r.facts.sessionId).toBe('long');
    expect([...r.facts.openTurns]).toEqual(['after']);
  });
});
