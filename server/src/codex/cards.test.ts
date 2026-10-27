import { describe, expect, it } from 'vitest';
import { validateReport } from '../fleet/protocol.js';
import { ACTIVE_WINDOW_MS, buildReports, CODEX_PREFIX, foldKey, RUNNING_QUIET_MS, type RunInfo } from './cards.js';
import { applyLine, emptyFacts } from './rollout.js';
import { complete, meta, started, T0, tokens, turnContext } from './testing.js';

function run(id: string, source: 'exec' | 'vscode', over: { cwd?: string; tab?: string | null; thread?: string | null; lines?: string[] } = {}): RunInfo {
  const f = emptyFacts();
  for (const l of over.lines ?? [meta(id, over.cwd ?? '/Users/dev/app', source), turnContext('gpt-5-codex'), started(`${id}-t`, T0 + 1000), tokens(1000, 400, 50, 900, T0 + 2000), complete(`${id}-t`, T0 + 3000)]) applyLine(f, l);
  return { facts: f, tab: over.tab ?? null, threadName: over.thread ?? null };
}
const NOW = T0 + 60_000;

describe('buildReports', () => {
  it('makes one card of a session someone sits in, named after its tab, with model, context and tokens', () => {
    const [r] = buildReports([run('s1', 'vscode', { tab: '"Manual" PR Reviewer', thread: 'Review PR 747' })], NOW);
    expect(r!.session).toMatchObject({ id: `${CODEX_PREFIX}s1`, name: '"Manual" PR Reviewer', model: 'gpt-5-codex', status: 'waiting', waitReason: 'input', costUsd: null, attached: true });
    expect(r!.session.context).toEqual({ tokens: 900, window: 475_000, percent: 0 });
    expect(r!.session.tokens).toEqual({ input: 600, output: 50, cacheRead: 400, cacheWrite: 0 });
    expect(r!.reporter.hostSurface).toBe('codex');
    expect(r!.events).toEqual([]);
  });

  it('names a session without a tab by its thread, then by its folder', () => {
    expect(buildReports([run('s1', 'vscode', { thread: 'Review PR 747' })], NOW)[0]!.session.name).toBe('Review PR 747');
    expect(buildReports([run('s1', 'vscode')], NOW)[0]!.session.name).toBe('app');
  });

  it('shows a session with an open turn as running, and one whose turn went quiet as idle', () => {
    const open = [meta('s1', '/a', 'vscode'), started('t', T0 + 1000)];
    expect(buildReports([run('s1', 'vscode', { lines: open })], T0 + 2000)[0]!.session).toMatchObject({ status: 'running', waitReason: null });
    expect(buildReports([run('s1', 'vscode', { lines: open })], T0 + 1000 + RUNNING_QUIET_MS + 1)[0]!.session).toMatchObject({ status: 'waiting', waitReason: 'input' });
  });

  it('folds every headless run one tab launched into one card with the counts and the latest run', () => {
    const runs = Array.from({ length: 56 }, (_, i) => run(`e${i}`, 'exec', { tab: 'Statsig Clean Up', cwd: `/Users/dev/proj${i % 3}` }));
    runs.push(run('live', 'exec', { tab: 'Statsig Clean Up', cwd: '/Users/dev/latest', lines: [meta('live', '/Users/dev/latest', 'exec', T0 + 50_000), started('lt', T0 + 55_000)] }));
    const out = buildReports(runs, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]!.session).toMatchObject({ name: 'Statsig Clean Up · codex runs', status: 'running', cwd: '/Users/dev/latest' });
    expect(out[0]!.session.waitNote).toMatch(/^1 running, 56 finished in the last day\. Latest: latest at \d\d:\d\d$/);
    expect(out[0]!.session.tokens.output).toBe(56 * 50);
  });

  it('keeps the runs of different tabs apart, and folds tab-less runs by folder', () => {
    const out = buildReports([run('a', 'exec', { tab: 'One' }), run('b', 'exec', { tab: 'Two' }), run('c', 'exec', { cwd: '/p/x' }), run('d', 'exec', { cwd: '/p/x' }), run('e', 'exec', { cwd: '/p/y' })], NOW);
    expect(out.map((r) => r.session.name).sort()).toEqual(['One · codex runs', 'Two · codex runs', 'x · codex runs', 'y · codex runs']);
    expect(new Set(out.map((r) => r.session.id)).size).toBe(4);
    expect(foldKey(run('a', 'exec', { tab: 'One' }))).toBe('tab:One');
  });

  it('keeps a headless run apart from an interactive session', () => {
    const out = buildReports([run('i', 'vscode', { tab: 'Manual' }), run('e', 'exec', { tab: 'Manual' })], NOW);
    const ids = out.map((r) => r.session.id);
    expect(ids).toContain(`${CODEX_PREFIX}i`);
    expect(ids.filter((id) => /^codex:runs:[0-9a-f]{12}$/.test(id))).toHaveLength(1);
  });

  it('leaves out a session with no record for a day, or one that never said who it is', () => {
    expect(buildReports([run('old', 'vscode')], T0 + 3000 + ACTIVE_WINDOW_MS)).toEqual([]);
    expect(buildReports([run('x', 'vscode', { lines: ['{"type":"turn_context","payload":{"model":"m"},"timestamp":"2026-10-27T14:00:00.000Z"}'] })], NOW)).toEqual([]);
  });

  it('sends reports the server accepts, with no cost for a model it has no price for', () => {
    for (const r of buildReports([run('i', 'vscode', { tab: 'T' }), run('e', 'exec', { tab: 'U' })], NOW)) {
      const v = validateReport(JSON.parse(JSON.stringify(r)));
      expect(v.ok).toBe(true);
      expect(r.session.costUsd).toBeNull();
    }
  });
});
