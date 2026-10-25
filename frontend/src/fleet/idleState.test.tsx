import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { FleetView } from "./FleetApp";
import { SessionCard } from "./components/SessionCard";
import { StatusChip, chipStatusOf } from "./components/Chips";
import { buildBoard } from "./board";
import { makeSession } from "./fixtures";
import { filterSessions, sortSessions } from "./logic";
import { fleetReducer } from "./store";
import { stateFrom } from "./testState";
import { isUrgentChange } from "./updateInterval";
import { idleOnInput, needsPerson } from "./waiting";

afterEach(cleanup);

// A session between turns (waitReason "input") is idle: nothing asks the person for anything. A permission prompt or a question does.
const CFG = { staleAfterMs: 15_000, dropAfterMs: 60_000, lingerMs: 8_000, detachedHideAfterMs: 60_000 };
const idle = (over = {}) => makeSession({ status: "waiting", waitReason: "input", ...over });
const asks = (over = {}) => makeSession({ status: "waiting", waitReason: "permission", waitNote: "AskUserQuestion({\"question\":\"Which OS?\"})", ...over });
const onShell = () => makeSession({ status: "waiting", waitReason: null, background: { tasks: [{ type: "shell", description: "nightly build", status: "running" }], wakeAt: null } });
const card = (s = idle()) => render(<SessionCard s={s} now={2_000_000} config={CFG} entering={false} leaving={false} onOpen={() => {}} />);

describe("idleOnInput and needsPerson", () => {
  it("tell idle, needs-you, background and running sessions apart", () => {
    expect([idleOnInput(idle()), needsPerson(idle())]).toEqual([true, false]);
    expect([idleOnInput(asks()), needsPerson(asks())]).toEqual([false, true]);
    expect([idleOnInput(onShell()), needsPerson(onShell())]).toEqual([false, false]);
    expect([idleOnInput(makeSession({ status: "running" })), needsPerson(makeSession({ status: "running" }))]).toEqual([false, false]);
  });

  it("do not treat an input wait that carries background work as idle", () => {
    const s = idle({ background: { tasks: [{ type: "shell", description: "x", status: "running" }], wakeAt: null } });
    expect([idleOnInput(s), needsPerson(s)]).toEqual([false, true]);
  });
});

describe("an idle session on the card", () => {
  it("reads Idle, in a calm band that is not hot, with its own icon", () => {
    const { container } = card();
    const band = container.querySelector(".band")!;
    expect(band.textContent).toBe("Idle");
    expect(band.className).toContain("idle");
    expect(band.className).not.toContain("hot");
    expect(container.querySelector(".card .sd .si-idle")).not.toBeNull();
  });

  it("keeps a question or permission prompt as needs-you", () => {
    const { container } = card(asks());
    expect(container.querySelector(".band")!.className).toContain("hot");
    expect(container.querySelector(".card .sd .si-waiting")).not.toBeNull();
  });
});

describe("the status chip", () => {
  it("says idle for an idle session and needs you for one that waits on the person", () => {
    expect(chipStatusOf(idle())).toBe("idle");
    expect(chipStatusOf(asks())).toBe("waiting");
    expect(chipStatusOf(makeSession({ status: "running" }))).toBe("running");
    expect(render(<StatusChip status="idle" />).container.textContent).toBe("idle");
    cleanup();
    expect(render(<StatusChip status="waiting" />).container.textContent).toBe("needs you");
  });
});

describe("the counts", () => {
  it("count only a session that needs the person as waiting, not an idle one", () => {
    const sessions = [idle({ id: "a", name: "finished" }), asks({ id: "b", name: "asking" })];
    const { container } = render(<FleetView state={stateFrom({ sessions })} />);
    expect(container.textContent).toContain("0 running · 1 waiting · 0 stale");
  });
});

describe("the board", () => {
  it("leaves an idle session out of Review, and keeps one that asks", () => {
    expect(buildBoard([idle({ id: "i", plan: null })]).columns.review).toEqual([]);
    expect(buildBoard([asks({ id: "q", plan: null })]).columns.review.map((c) => c.key)).toEqual(["q:waiting"]);
  });
});

describe("the rail", () => {
  it("names each row's state for a screen reader: needs you, idle, blocked on shell", () => {
    const { container } = render(<FleetView state={stateFrom({ sessions: [asks({ id: "q", name: "asking" }), idle({ id: "i", name: "finished" }), { ...onShell(), id: "b", name: "bg" }] })} />);
    const word = (name: string) => [...container.querySelectorAll(".rail .ritem")].find((r) => r.querySelector(".nm")?.textContent === name)!.querySelector(".vh")!.textContent;
    expect([word("asking"), word("finished"), word("bg")]).toEqual(["needs you", "idle", "blocked on shell"]);
  });
});

describe("the Waiting filter", () => {
  it("lists the sessions the Waiting count counts", () => {
    const list = [idle({ id: "i" }), asks({ id: "q" }), onShell(), makeSession({ id: "r", status: "running" })];
    expect(filterSessions(list, { status: "waiting", q: "" }).map((s) => s.id)).toEqual(["q"]);
  });
});

describe("the order", () => {
  it("puts a session that needs the person first, then one blocked on background work, then an idle one, all ahead of stale", () => {
    const list = [makeSession({ id: "s", name: "s", status: "stale" }), idle({ id: "i", name: "a-idle" }), { ...onShell(), id: "b", name: "b-bg" }, asks({ id: "q", name: "z-asks" }), makeSession({ id: "r", name: "m-run", status: "running" })];
    expect(sortSessions(list, "status").map((s) => s.id)).toEqual(["r", "q", "b", "i", "s"]);
  });
});

describe("the update interval", () => {
  it("is urgent when a session starts needing the person, not when it goes idle", () => {
    const held = stateFrom({ sessions: [makeSession({ id: "a", status: "running" })] });
    expect(isUrgentChange(held, fleetReducer(held, { type: "session", view: asks({ id: "a" }) }))).toBe(true);
    expect(isUrgentChange(held, fleetReducer(held, { type: "session", view: idle({ id: "a" }) }))).toBe(false);
  });
});
