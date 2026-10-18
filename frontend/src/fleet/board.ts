// The kanban board (#346): every session's plan steps sorted into one column per state. Pure, so the page and its tests share it.
import { idleOnBackground } from "./waiting";
import type { PlanStep, SessionView } from "./types";

export type BoardColumn = "pending" | "active" | "review" | "blocked" | "done";

export const BOARD_COLUMNS: readonly { key: BoardColumn; label: string; hint: string }[] = [
  { key: "pending", label: "Pending", hint: "Not started" },
  { key: "active", label: "In progress", hint: "" },
  { key: "review", label: "Review", hint: "Waiting on a person" },
  { key: "blocked", label: "Blocked", hint: "Needs something" },
  { key: "done", label: "Done", hint: "Until its orchestrator finishes" },
];

export const EMPTY_COLUMN: Record<BoardColumn, string> = {
  pending: "Nothing waiting. Every step has started or finished.",
  active: "Nothing in progress. Sessions are idle or between steps.",
  review: "Nothing waiting on a person right now.",
  blocked: "No blocked steps. Claude Code marks a step blocked when it cannot proceed.",
  done: "Nothing done yet.",
};

/** Cards a column shows before it pages. */
export const CARDS_PER_PAGE = 25;

export interface BoardCard {
  /** Stable across updates, so a card can be followed from one column to another. */
  key: string;
  session: SessionView;
  step: PlanStep;
  column: BoardColumn;
}

/** Whether the session waits on its person, as the rail and the wall count it: a wait on background work is not one. */
function waitsOnPerson(s: SessionView): boolean {
  return s.status === "waiting" && !idleOnBackground(s);
}

/** Review holds an in-progress step while its session waits on its person; every other step sits in its own state's column. */
export function columnOf(s: SessionView, step: PlanStep): BoardColumn {
  return step.state === "active" && waitsOnPerson(s) ? "review" : step.state;
}

/** A plan with every step done on a session that is no longer running or waiting: its Done cards leave the board. */
export function sessionFinished(s: SessionView): boolean {
  const steps = s.plan?.steps;
  return !!steps?.length && steps.every((x) => x.state === "done") && (s.status === "stale" || s.status === "done");
}

export interface Board {
  columns: Record<BoardColumn, BoardCard[]>;
  /** Sessions with no plan, an empty one, or a finished one: on the board's page, but with nothing to put in a column. */
  withoutSteps: SessionView[];
}

export function buildBoard(sessions: readonly SessionView[]): Board {
  const columns: Record<BoardColumn, BoardCard[]> = { pending: [], active: [], review: [], blocked: [], done: [] };
  const withoutSteps: SessionView[] = [];
  for (const s of sessions) {
    if (!s.plan?.steps.length || sessionFinished(s)) {
      withoutSteps.push(s);
      continue;
    }
    for (const step of s.plan.steps) {
      const column = columnOf(s, step);
      columns[column].push({ key: `${s.id}:${step.id}`, session: s, step, column });
    }
  }
  return { columns, withoutSteps };
}

/** The step that changed last first; steps that have not changed since the page opened keep their order. */
export function orderCards(cards: readonly BoardCard[], changedAt: ReadonlyMap<string, number>): BoardCard[] {
  return cards.map((c, i) => ({ c, i })).sort((a, b) => (changedAt.get(b.c.key) ?? 0) - (changedAt.get(a.c.key) ?? 0) || a.i - b.i).map((x) => x.c);
}

/** Cards of one session next to each other, sessions in the order their first card appears; each session keeps its cards' order. */
export function groupBySession(cards: readonly BoardCard[]): BoardCard[] {
  const by = new Map<string, BoardCard[]>();
  for (const c of cards) {
    const list = by.get(c.session.id);
    if (list) list.push(c);
    else by.set(c.session.id, [c]);
  }
  return [...by.values()].flat();
}
