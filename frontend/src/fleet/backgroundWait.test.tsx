import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import { FleetView } from "./FleetApp";
import { SessionCard } from "./components/SessionCard";
import { makeEvent, makeSession } from "./fixtures";
import { stateFrom } from "./testState";
import { backgroundLead, backgroundTitle, wakeCountdownAt } from "./waiting";
import { WakeTimer } from "./components/WakeTimer";

afterEach(cleanup);

// A session idle on background work is not waiting on the person (#119, mockup/podium-background-wait.html).
const CFG = { staleAfterMs: 15_000, dropAfterMs: 60_000, lingerMs: 8_000, detachedHideAfterMs: 60_000 };
const task = (type: "shell" | "agent" | "monitor" | "workflow" | "wakeup", description = "nightly build") => ({ type, description, status: "running" });
const idleOn = (tasks: ReturnType<typeof task>[], wakeAt: number | null = null) =>
  makeSession({ status: "waiting", waitReason: null, background: { tasks, wakeAt } });
const renderCard = (s = idleOn([task("shell")])) => render(<SessionCard s={s} now={2_000_000} config={CFG} entering={false} leaving={false} onOpen={() => {}} />);

describe("backgroundLead", () => {
  it("counts by kind", () => {
    expect(backgroundLead({ tasks: [task("shell")], wakeAt: null })).toBe("Waiting for 1 background shell to finish.");
    expect(backgroundLead({ tasks: [task("shell"), task("shell")], wakeAt: null })).toBe("Waiting for 2 background shells to finish.");
    expect(backgroundLead({ tasks: [task("agent")], wakeAt: null })).toBe("Waiting for 1 background agent to finish.");
    expect(backgroundLead({ tasks: [task("monitor")], wakeAt: null })).toBe("Waiting for 1 background monitor to finish.");
    expect(backgroundLead({ tasks: [task("workflow")], wakeAt: null })).toBe("Waiting for 1 background workflow to finish.");
  });
  it("lists several kinds in one sentence", () => {
    expect(backgroundLead({ tasks: [task("shell"), task("agent")], wakeAt: null })).toBe("Waiting for 1 background shell and 1 background agent to finish.");
  });
  it("names a wake-up that comes with other work, and the tooltip says wake-up, not wakeup", () => {
    const b = { tasks: [task("shell"), task("wakeup", "check the deploy")], wakeAt: null };
    expect(backgroundLead(b)).toBe("Waiting for 1 background shell to finish, and a scheduled wake-up.");
    expect(backgroundTitle(b)).not.toContain("wakeup");
    expect(backgroundTitle(b)).toContain("wake-up: check the deploy");
  });
  it("says when a scheduled wake-up will wake, or that one is scheduled", () => {
    expect(backgroundLead({ tasks: [task("wakeup", "check the deploy")], wakeAt: Date.UTC(2026, 9, 13, 14, 30) })).toMatch(/^Waiting for a scheduled wake-up at \d{1,2}:\d{2}\.$/);
    expect(backgroundLead({ tasks: [task("wakeup", "check the deploy")], wakeAt: null })).toBe("Waiting for a scheduled wake-up.");
  });
  it("counts down only for a session idle on nothing but scheduled wake-ups that have a time", () => {
    const wakeAt = Date.UTC(2026, 9, 13, 14, 30);
    expect(wakeCountdownAt({ tasks: [task("wakeup"), task("wakeup")], wakeAt })).toBe(wakeAt);
    expect(wakeCountdownAt({ tasks: [task("wakeup")], wakeAt: null })).toBeNull();
    expect(wakeCountdownAt({ tasks: [task("shell"), task("wakeup")], wakeAt })).toBeNull();
    expect(wakeCountdownAt({ tasks: [], wakeAt })).toBeNull();
  });
});

describe("the wake-up timer", () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => vi.useRealTimers());
  const timerText = (c: HTMLElement) => c.querySelector(".wake-timer")?.textContent;

  it("counts down on its own clock, one displayed second at a time, whatever the card's now does", () => {
    const { container } = render(<WakeTimer at={1_000_000 + 161_000} />);
    expect(timerText(container)).toBe("2:41");
    act(() => void vi.advanceTimersByTime(1_000));
    expect(timerText(container)).toBe("2:40");
    act(() => void vi.advanceTimersByTime(100_000));
    expect(timerText(container)).toBe("1:00");
    act(() => void vi.advanceTimersByTime(23_000));
    expect(timerText(container)).toBe("37s");
  });

  it("changes at the moment a second elapses, not on a fixed refresh", () => {
    const { container } = render(<WakeTimer at={1_000_000 + 61_500} />);
    expect(timerText(container)).toBe("1:02");
    act(() => void vi.advanceTimersByTime(499));
    expect(timerText(container)).toBe("1:02");
    act(() => void vi.advanceTimersByTime(2));
    expect(timerText(container)).toBe("1:01");
  });

  it("says \"now\" once the time has passed, and stops ticking", () => {
    const { container } = render(<WakeTimer at={1_000_000 + 2_000} />);
    act(() => void vi.advanceTimersByTime(2_500));
    expect(timerText(container)).toBe("now");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("follows a new wake time", () => {
    const { container, rerender } = render(<WakeTimer at={1_000_000 + 60_000} />);
    expect(timerText(container)).toBe("1:00");
    rerender(<WakeTimer at={1_000_000 + 180_000} />);
    expect(timerText(container)).toBe("3:00");
  });

  it("sits right after the clock icon, before the sentence, on the card", () => {
    const s = idleOn([task("wakeup", "check the deploy")], 1_000_000 + 161_000);
    const { container } = render(<SessionCard s={s} now={1_000_000} config={CFG} entering={false} leaving={false} onOpen={() => {}} />);
    const band = container.querySelector(".band")!;
    const order = [...band.querySelectorAll(".bi, .wake-timer, .bl")].map((e) => e.className.split(" ")[0]);
    expect(order[0]).toBe("bi");
    expect(order).toContain("wake-timer");
    expect(band.textContent).toMatch(/2:41\s*Waiting for a scheduled wake-up at \d{1,2}:\d{2}\./);
  });

  it("is not shown for a session that also waits on a shell", () => {
    const s = idleOn([task("shell"), task("wakeup")], 1_000_000 + 161_000);
    const { container } = render(<SessionCard s={s} now={1_000_000} config={CFG} entering={false} leaving={false} onOpen={() => {}} />);
    expect(container.querySelector(".wake-timer")).toBeNull();
  });
});

describe("the card", () => {
  it("says what it waits on, never \"your input\", and carries no task description", () => {
    const { container } = renderCard(idleOn([task("shell", "npm run build:all && npm run test:integration -- --runInBand --coverage")]));
    expect(container.querySelector(".band")!.textContent).toBe("Waiting for 1 background shell to finish.");
    expect(container.textContent).not.toContain("your input");
    expect(container.textContent).not.toContain("npm run build");
  });

  it("is blue and quiet: a dashed-ring clock, not the waiting-on-you mark, and no amber band", () => {
    const { container } = renderCard();
    expect(container.querySelector(".st")).toBeNull();
    expect(container.querySelector(".card .sd .si-bg")).not.toBeNull();
    expect(container.querySelector(".card .sd .si-waiting")).toBeNull();
    expect(container.querySelector(".band .si-bg")).not.toBeNull();
    expect(container.querySelector(".band")!.className).toContain("bg");
    expect(container.querySelector(".band")!.className).not.toContain("hot");
  });

  it("a session that waits on the person still reads as before", () => {
    const { container } = renderCard(makeSession({ status: "waiting", waitReason: "permission" }));
    expect(container.querySelector(".band")!.textContent).toBe("Waiting for your approval.");
    expect(container.querySelector(".band")!.className).toContain("waiting");
    expect(container.querySelector(".band")!.className).toContain("hot");
    expect(container.querySelector(".card .sd .si-waiting")).not.toBeNull();
  });

  it("a permission wait wins over background work", () => {
    const { container } = renderCard(makeSession({ status: "waiting", waitReason: "permission", waitNote: "Bash(rm x)", background: { tasks: [task("shell")], wakeAt: null } }));
    expect(container.querySelector(".band")!.textContent).toBe("Waiting for your approval.");
  });
});

describe("the orchestrator page", () => {
  it("leads with the sentence and puts the task description on its own row", () => {
    const { container } = render(<FleetView state={stateFrom({ sessions: [idleOn([task("shell", "nightly build")])] })} />);
    fireEvent.click(container.querySelector(".wall .card")!);
    const callout = container.querySelector(".osum .band")!;
    expect(callout.querySelector(".bl")!.textContent).toBe("Waiting for 1 background shell to finish.");
    expect(callout.querySelector(".bd")!.textContent).toBe("Shell: nightly build");
    expect(callout.textContent).not.toContain("Answer in its terminal");
  });

  it("cuts a long description at a character limit and ends it with a space and three dots", () => {
    const { container } = render(<FleetView state={stateFrom({ sessions: [idleOn([task("shell", "npm run build:all && npm run test:integration -- --runInBand --coverage --reporters=default --reporters=jest-junit")])] })} />);
    fireEvent.click(container.querySelector(".wall .card")!);
    const detail = container.querySelector(".osum .band .bd")!.textContent!;
    expect(detail.length).toBeLessThanOrEqual(64 + 4);
    expect(detail).toMatch(/\S \.\.\.$/);
  });
});

describe("the counts", () => {
  it("do not count a session idle on background work as waiting on you", () => {
    const sessions = [makeSession({ id: "a", name: "needs-you", status: "waiting", waitReason: "permission" }), { ...idleOn([task("shell")]), id: "b", name: "on-shell" }];
    const { container } = render(<FleetView state={stateFrom({ sessions })} />);
    expect(container.textContent).toContain("0 running · 1 waiting · 0 stale");
  });

  it("the rail row says what it waits on", () => {
    const { container } = render(<FleetView state={stateFrom({ sessions: [idleOn([task("shell")])] })} />);
    const row = [...container.querySelectorAll(".rail .ritem")].find((r) => r.textContent?.includes("api-refactor"))!;
    expect(row.textContent).toContain("blocked on shell");
    expect(row.querySelector(".dot.ring")).not.toBeNull();
  });
});

describe("the activity feed", () => {
  it("the newest wait row is blue with a kind pill, like a wait on you is amber", () => {
    const events = [makeEvent({ id: "bg", t: 1_000_000, kind: "wait", text: "waiting on background: 1 shell" })];
    const { container } = render(<FleetView state={stateFrom({ sessions: [idleOn([task("shell")])], events })} />);
    const li = [...container.querySelectorAll(".side .ev li")].find((l) => l.querySelector(".lead"))!;
    expect(li.querySelector(".lead")!.textContent).toBe("Waiting for 1 background shell to finish.");
    expect(li.querySelector(".tool")!.textContent).toBe("shell");
    expect(li.className).toContain("bgw");
    expect(li.className).not.toMatch(/(^| )w( |$)/);
  });

  it("goes plain once the session is no longer waiting on that work", () => {
    const events = [makeEvent({ id: "bg", t: 1_000_000, kind: "wait", text: "waiting on background: 1 shell" })];
    const { container } = render(<FleetView state={stateFrom({ sessions: [makeSession({ status: "running" })], events })} />);
    const li = [...container.querySelectorAll(".side .ev li")].find((l) => l.textContent?.includes("background shell"))!;
    expect(li.className).not.toContain("bgw");
  });
});
