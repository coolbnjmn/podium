// A plan for sessions that keep theirs in a HANDOFF.md or in beads instead of TaskCreate/TodoWrite.
// Pure: every function returns a value and ignores malformed input. The mod reads the files and runs `bd`.
import type { Plan, PlanStep } from './protocol.ts'

export interface FallbackPlan {
  source: 'handoff' | 'beads'
  title: string | null
  steps: { text: string; state: PlanStep['state'] }[]
}

/** Most steps taken from a file or from beads, and the most characters read from a HANDOFF.md. */
export const MAX_FALLBACK_STEPS = 12
export const MAX_HANDOFF_BYTES = 20_000
const STEP_CHARS = 160

/** An absolute path to a file named HANDOFF.md, the one name the fallback reads. */
export function isHandoffPath(p: unknown): p is string {
  return typeof p === 'string' && p.startsWith('/') && /(^|\/)HANDOFF\.md$/i.test(p) && !p.includes('\0')
}

/** The headings whose bullets are work still to do. */
const OPEN_HEADING = /\b(open items?|in flight|next( actions?| steps?)?|to-?do|remaining|still (to|has to)|pending|outstanding)\b/i

function clean(s: string): string {
  const t = s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > STEP_CHARS ? `${t.slice(0, STEP_CHARS - 1).trimEnd()}…` : t
}

/**
 * The bullets, numbered items and checkboxes under the headings that name open work, in file order. A checked
 * box is done; anything else is pending. The first line `# ...` is the title. Returns null when nothing is open.
 */
export function parseHandoff(text: unknown): FallbackPlan | null {
  if (typeof text !== 'string' || !text.trim()) return null
  const steps: FallbackPlan['steps'] = []
  let title: string | null = null
  let level = 0
  let open = false
  for (const line of text.slice(0, MAX_HANDOFF_BYTES).split('\n')) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      const depth = h[1]!.length
      if (depth === 1 && title === null) title = clean(h[2]!) || null
      if (open && depth <= level) open = false
      if (!open && depth > 1 && OPEN_HEADING.test(h[2]!)) {
        open = true
        level = depth
      }
      continue
    }
    if (!open || steps.length >= MAX_FALLBACK_STEPS) continue
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*\S.*)$/.exec(line)
    if (!item) continue
    const body = clean(item[2]!)
    if (body) steps.push({ text: body, state: item[1] && item[1] !== ' ' ? 'done' : 'pending' })
  }
  return steps.length ? { source: 'handoff', title, steps } : null
}

/** `bd list --json` rows: an in-progress issue is the active step, an open one is pending. Closed ones are left out. */
export function parseBeads(json: unknown): FallbackPlan | null {
  let rows: unknown
  try {
    rows = typeof json === 'string' ? JSON.parse(json) : json
  } catch {
    return null
  }
  if (!Array.isArray(rows)) return null
  const steps: FallbackPlan['steps'] = []
  for (const r of rows) {
    if (typeof r !== 'object' || r === null) continue
    const o = r as Record<string, unknown>
    const state = o.status === 'in_progress' ? 'active' : o.status === 'open' ? 'pending' : null
    const title = typeof o.title === 'string' ? clean(o.title) : ''
    if (!state || !title) continue
    steps.push({ text: typeof o.id === 'string' && o.id ? clean(`${o.id}: ${title}`) : title, state })
  }
  // In-progress work leads; a stable sort keeps `bd`'s own order inside each group.
  steps.sort((a, b) => Number(b.state === 'active') - Number(a.state === 'active'))
  return steps.length ? { source: 'beads', title: null, steps: steps.slice(0, MAX_FALLBACK_STEPS) } : null
}

/** HANDOFF.md first: it is written just before a clear and may not be in beads yet. */
export function chooseFallback(handoff: FallbackPlan | null, beads: FallbackPlan | null): FallbackPlan | null {
  return handoff ?? beads
}

/** The fallback as the Report carries it. */
export function fallbackToPlan(f: FallbackPlan | null): Plan | null {
  if (!f) return null
  return {
    title: f.title,
    source: f.source,
    steps: f.steps.map((s, i) => ({ id: `${f.source}-${i}`, text: s.text, state: s.state, activeText: null, ownerAgentId: null, ownerLabel: null })),
  }
}
