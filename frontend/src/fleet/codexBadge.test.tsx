import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { SessionCard } from "./components/SessionCard";
import { STATUS_FILTERS } from "./logic";
import { makeSession } from "./fixtures";

afterEach(cleanup);

const CFG = { staleAfterMs: 15_000, dropAfterMs: 60_000, lingerMs: 8_000, detachedHideAfterMs: 60_000 };
const card = (agent: "claude" | "codex") => render(<SessionCard s={makeSession({ agent, model: agent === "codex" ? "gpt-5-codex" : "claude-opus-5-5", modelFamily: agent === "codex" ? "other" : "opus" })} now={2_000_000} config={CFG} entering={false} leaving={false} onOpen={() => {}} />);

describe("the codex badge", () => {
  it("marks a Codex card next to its model, and a Claude Code card has none", () => {
    card("codex");
    expect(screen.getByTitle("A Codex session, reported by the Codex sidecar").textContent).toBe("codex");
    cleanup();
    card("claude");
    expect(screen.queryByTitle("A Codex session, reported by the Codex sidecar")).toBeNull();
  });
  it("has a Codex tab among the status filters", () => {
    expect(STATUS_FILTERS.codex).toBe("Codex");
  });
});
