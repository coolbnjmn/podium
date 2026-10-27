// Reads what a card needs from a Codex rollout file (~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl): ids, the folder,
// how the session was started, the model, turn boundaries and token counts. Nothing else is looked at: no message, prompt, tool
// call or output text is kept, and a line that is not one of the few kinds below is skipped after one JSON parse.
import fs from 'node:fs';

/** The most bytes read from one file in one pass. */
export const READ_CHUNK_BYTES = 512 * 1024;
/** A file bigger than this, seen for the first time, is read from its start (the session record) and then from its tail. */
export const TAIL_THRESHOLD_BYTES = 2 * 1024 * 1024;
/** The tail read after the start of a big file the first time it is seen: enough for the last turns and the running totals. */
export const INITIAL_TAIL_BYTES = 512 * 1024;
/** The first line (the session record) carries the agent's instructions, so it can be long; past this it is not read. */
const HEAD_BYTES = 256 * 1024;
const MAX_OPEN_TURNS = 64;

export interface TokenTotals {
  /** Prompt tokens that were not served from the cache. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface RolloutFacts {
  sessionId: string | null;
  cwd: string | null;
  /** `exec` for a headless `codex exec` run, anything else (`vscode`, `cli`) for a session someone sits in. */
  source: string | null;
  originator: string | null;
  startedAt: number | null;
  model: string | null;
  contextWindow: number | null;
  /** The prompt size of the last model request: how full the context is. */
  lastPromptTokens: number | null;
  tokens: TokenTotals;
  /** Turns started and not yet finished. */
  openTurns: Set<string>;
  /** When the newest record was written (epoch ms), or null before any record carried a time. */
  lastRecordAt: number | null;
  /** The newest turn's finish time, for a headless run that is over. */
  lastCompleteAt: number | null;
}

export function emptyFacts(): RolloutFacts {
  return {
    sessionId: null,
    cwd: null,
    source: null,
    originator: null,
    startedAt: null,
    model: null,
    contextWindow: null,
    lastPromptTokens: null,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    openTurns: new Set(),
    lastRecordAt: null,
    lastCompleteAt: null,
  };
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown, max = 500): string | null => (typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const ms = (v: unknown): number | null => {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

/** `total_token_usage` as Podium counts tokens: `input_tokens` includes the cached ones, so they are taken out of it. */
function totalsOf(u: Record<string, unknown> | null): TokenTotals | null {
  if (!u) return null;
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  if (input === null || output === null) return null;
  const cached = Math.min(num(u.cached_input_tokens) ?? 0, input);
  return { input: input - cached, output, cacheRead: cached, cacheWrite: num(u.cache_write_input_tokens) ?? 0 };
}

/** Folds one line of the file into `facts`. A line that is not JSON, or not a kind used here, changes nothing. Returns whether it changed anything. */
export function applyLine(facts: RolloutFacts, line: string): boolean {
  if (line.length === 0 || line.charCodeAt(0) !== 123) return false;
  let rec: Record<string, unknown> | null;
  try {
    rec = obj(JSON.parse(line));
  } catch {
    return false;
  }
  if (!rec) return false;
  const p = obj(rec.payload);
  if (!p) return false;
  const at = ms(rec.timestamp);
  let changed = false;
  switch (rec.type) {
    case 'session_meta': {
      facts.sessionId = str(p.id, 100) ?? facts.sessionId;
      facts.cwd = str(p.cwd, 1000) ?? facts.cwd;
      facts.source = str(p.source, 40) ?? facts.source;
      facts.originator = str(p.originator, 60) ?? facts.originator;
      facts.startedAt = ms(p.timestamp) ?? at ?? facts.startedAt;
      changed = true;
      break;
    }
    case 'turn_context': {
      const model = str(p.model, 100);
      if (model) facts.model = model;
      const cwd = str(p.cwd, 1000);
      if (cwd && !facts.cwd) facts.cwd = cwd;
      changed = true;
      break;
    }
    case 'event_msg': {
      if (p.type === 'task_started') {
        const id = str(p.turn_id, 100);
        if (id) {
          if (facts.openTurns.size >= MAX_OPEN_TURNS) facts.openTurns.clear();
          facts.openTurns.add(id);
        }
        facts.contextWindow = num(p.model_context_window) ?? facts.contextWindow;
        changed = true;
      } else if (p.type === 'task_complete') {
        const id = str(p.turn_id, 100);
        if (id) facts.openTurns.delete(id);
        const done = num(p.completed_at);
        facts.lastCompleteAt = done !== null ? done * 1000 : at ?? facts.lastCompleteAt;
        changed = true;
      } else if (p.type === 'token_count') {
        const info = obj(p.info);
        const total = totalsOf(obj(info?.total_token_usage));
        if (total) facts.tokens = total;
        const last = obj(info?.last_token_usage);
        facts.lastPromptTokens = num(last?.input_tokens) ?? facts.lastPromptTokens;
        facts.contextWindow = num(info?.model_context_window) ?? facts.contextWindow;
        changed = true;
      }
      break;
    }
    default:
      break;
  }
  if (at !== null && (facts.lastRecordAt === null || at > facts.lastRecordAt)) facts.lastRecordAt = at;
  return changed;
}

/** One rollout file followed by byte offset: each pass reads only what was appended, and only whole lines are used. */
export class RolloutFile {
  facts: RolloutFacts = emptyFacts();
  private offset = 0;
  private ino: number | null = null;
  private seeded = false;
  /** The rest of a line longer than a read is being thrown away. */
  private discarding = false;
  /** Bytes the last `read()` took from the file; zero when nothing was appended. */
  bytesRead = 0;

  constructor(readonly path: string) {}

  /** Reads what was appended since the last pass. Returns true when the file was read, false when it could not be (gone, unreadable). */
  read(maxBytes: number = READ_CHUNK_BYTES): boolean {
    this.bytesRead = 0;
    let fd: number;
    try {
      fd = fs.openSync(this.path, 'r');
    } catch {
      return false;
    }
    try {
      const st = fs.fstatSync(fd);
      // A different file under the same name (rotated), or one that got shorter: start over.
      if ((this.ino !== null && this.ino !== st.ino) || st.size < this.offset) this.reset();
      this.ino = st.ino;
      if (!this.seeded) {
        this.seeded = true;
        if (st.size > TAIL_THRESHOLD_BYTES) {
          this.readRange(fd, 0, Math.min(HEAD_BYTES, st.size), true);
          this.offset = this.alignToLine(fd, st.size - INITIAL_TAIL_BYTES, st.size);
        }
      }
      if (st.size > this.offset) this.readRange(fd, this.offset, Math.min(st.size, this.offset + maxBytes), false);
      return true;
    } catch {
      return false;
    } finally {
      fs.closeSync(fd);
    }
  }

  private reset(): void {
    this.facts = emptyFacts();
    this.offset = 0;
    this.seeded = false;
    this.discarding = false;
  }

  /** The offset of the first line that starts at or after `from`. */
  private alignToLine(fd: number, from: number, size: number): number {
    const buf = Buffer.alloc(Math.min(READ_CHUNK_BYTES, size - from));
    const n = fs.readSync(fd, buf, 0, buf.length, from);
    this.bytesRead += n;
    const nl = buf.subarray(0, n).indexOf(10);
    return nl < 0 ? size : from + nl + 1;
  }

  /** Reads bytes [from, to) and uses every whole line in them. `headOnly` takes the first line and moves nothing. */
  private readRange(fd: number, from: number, to: number, headOnly: boolean): void {
    const buf = Buffer.alloc(to - from);
    const n = fs.readSync(fd, buf, 0, buf.length, from);
    this.bytesRead += n;
    let start = 0;
    const text = buf.subarray(0, n);
    for (;;) {
      const nl = text.indexOf(10, start);
      if (nl < 0) break;
      if (this.discarding) this.discarding = false;
      else applyLine(this.facts, text.subarray(start, nl).toString('utf8'));
      start = nl + 1;
      if (headOnly) return;
    }
    if (headOnly) return;
    if (start === 0 && n >= to - from && n >= READ_CHUNK_BYTES) {
      // One line longer than a whole read: throw it away rather than hold it, and carry on after its end.
      this.discarding = true;
      this.offset = from + n;
      return;
    }
    this.offset = from + start;
  }
}
