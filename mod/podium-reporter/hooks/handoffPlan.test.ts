import { describe, test, expect } from 'claude-code/testing'
import { chooseFallback, fallbackToPlan, isHandoffPath, MAX_FALLBACK_STEPS, parseBeads, parseHandoff } from './handoffPlan.ts'
import { newSession, setFallback, toolResult } from './state.ts'

const DOC = `# Podium handoff

## Goal
Ben views sessions.

## Open items
- \`npm audit\` reports 1 high-severity vulnerability; not reviewed.
- [x] Node 26.10 is installed vs the documented Node 24.
- [ ] Decide whether to run **podiumctl enable**.

### Details
1. A numbered item under the same heading
Plain prose is not a step.

## Resume
- Session id: abc (this bullet is outside an open-work heading)
`

describe('parseHandoff', () => {
  test('takes the bullets under the open-work headings, with checkboxes as done', () => {
    const p = parseHandoff(DOC)!
    expect(p.source).toBe('handoff')
    expect(p.title).toBe('Podium handoff')
    expect(p.steps).toEqual([
      { text: 'npm audit reports 1 high-severity vulnerability; not reviewed.', state: 'pending' },
      { text: 'Node 26.10 is installed vs the documented Node 24.', state: 'done' },
      { text: 'Decide whether to run podiumctl enable.', state: 'pending' },
      { text: 'A numbered item under the same heading', state: 'pending' },
    ])
  })

  test('also reads "In flight / next actions" and stops at the next heading of the same level', () => {
    const p = parseHandoff('# Orchestrator\n## In flight / next actions\n- one\n- two\n## Where things live\n- not a step\n')!
    expect(p.steps.map((s) => s.text)).toEqual(['one', 'two'])
  })

  test('gives nothing for text with no open-work heading, empty text or a non-string', () => {
    expect(parseHandoff('# T\n## Goal\n- a bullet\n')).toBeNull()
    expect(parseHandoff('')).toBeNull()
    expect(parseHandoff(undefined)).toBeNull()
    expect(parseHandoff({ not: 'text' })).toBeNull()
  })

  test('caps the number of steps and the length of each', () => {
    const many = `# T\n## Open items\n${Array.from({ length: 40 }, (_, i) => `- item ${i}`).join('\n')}\n- ${'x'.repeat(500)}\n`
    expect(parseHandoff(many)!.steps).toHaveLength(MAX_FALLBACK_STEPS)
    const long = parseHandoff(`# T\n## Open items\n- ${'y'.repeat(500)}\n`)!
    expect(long.steps[0]!.text.length).toBeLessThanOrEqual(160)
  })
})

describe('parseBeads', () => {
  test('makes in-progress issues active and first, open ones pending, and leaves out closed ones', () => {
    const rows = [
      { id: 'a-1', title: 'First open', status: 'open' },
      { id: 'a-2', title: 'Doing it', status: 'in_progress' },
      { id: 'a-3', title: 'Finished', status: 'closed' },
    ]
    expect(parseBeads(JSON.stringify(rows))!.steps).toEqual([
      { text: 'a-2: Doing it', state: 'active' },
      { text: 'a-1: First open', state: 'pending' },
    ])
  })

  test('ignores malformed input: bad JSON, a non-array, rows without a title or a known status', () => {
    expect(parseBeads('not json')).toBeNull()
    expect(parseBeads('{"a":1}')).toBeNull()
    expect(parseBeads('')).toBeNull()
    expect(parseBeads([null, 5, { status: 'open' }, { title: 'no status' }])).toBeNull()
  })
})

describe('the fallback', () => {
  test('prefers the HANDOFF plan over beads, and uses beads when there is no HANDOFF plan', () => {
    const h = parseHandoff(DOC)
    const b = parseBeads([{ id: 'x', title: 't', status: 'open' }])
    expect(chooseFallback(h, b)).toBe(h)
    expect(chooseFallback(null, b)).toBe(b)
    expect(chooseFallback(null, null)).toBeNull()
  })

  test('becomes a report plan with stable step ids, or nothing', () => {
    const plan = fallbackToPlan(parseHandoff(DOC))!
    expect(plan.source).toBe('handoff')
    expect(plan.steps.map((s) => s.id)).toEqual(['handoff-0', 'handoff-1', 'handoff-2', 'handoff-3'])
    expect(plan.steps.map((s) => s.state)).toEqual(['pending', 'done', 'pending', 'pending'])
    expect(fallbackToPlan(null)).toBeNull()
  })

  test('only absolute paths named HANDOFF.md count', () => {
    expect(isHandoffPath('/Users/x/Code/_agent-data/projects/podium/HANDOFF.md')).toBe(true)
    expect(isHandoffPath('/tmp/handoff.md')).toBe(true)
    expect(isHandoffPath('HANDOFF.md')).toBe(false)
    expect(isHandoffPath('/tmp/NOT-HANDOFF.md.bak')).toBe(false)
    expect(isHandoffPath('/tmp/x/HANDOFF.md\0.txt')).toBe(false)
    expect(isHandoffPath(42)).toBe(false)
  })
})

describe('the session', () => {
  const s0 = newSession({ id: 's', cwd: '/c', startedAt: 0 })
  const call = (s: typeof s0, tool: string, file: unknown, agentId?: string) => toolResult(s, { agentId, tool, input: { file_path: file }, result: {} }, 1)

  test('remembers the HANDOFF.md it read or wrote, and no other file', () => {
    expect(call(s0, 'Read', '/p/HANDOFF.md').handoffPath).toBe('/p/HANDOFF.md')
    expect(call(s0, 'Write', '/q/HANDOFF.md').handoffPath).toBe('/q/HANDOFF.md')
    expect(call(s0, 'Read', '/p/README.md').handoffPath).toBeNull()
    expect(call(s0, 'Grep', '/p/HANDOFF.md').handoffPath).toBeNull()
  })

  test('ignores a subagent reading one, and keeps the same state when nothing changes', () => {
    expect(call(s0, 'Read', '/p/HANDOFF.md', 'agent-1').handoffPath).toBeNull()
    const s = setFallback(s0, parseHandoff(DOC))
    expect(setFallback(s, parseHandoff(DOC))).toBe(s)
    expect(setFallback(s, null).fallback).toBeNull()
  })
})
