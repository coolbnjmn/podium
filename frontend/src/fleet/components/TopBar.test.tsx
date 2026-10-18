import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { TopBar } from "./TopBar";

afterEach(cleanup);

function renderBar(reporters = 2) {
  return render(<TopBar page="Fleet" phase="live" reporters={reporters} />);
}

describe("TopBar", () => {
  it("puts a Fleet pill before the connection pill", () => {
    renderBar();
    // The page pill; the Fleet button next to Board and History has the same word.
    const fleet = screen.getAllByText("Fleet").find((e) => e.classList.contains("pill"))!;
    const connection = screen.getByText(/2 reporters live/);
    expect(fleet).toHaveClass("pill");
    expect(fleet.compareDocumentPosition(connection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("leaves the button for the page you are on off the bar: no Fleet on the fleet page, no Board on the board", () => {
    render(<TopBar page="Fleet" phase="live" reporters={1} />);
    expect(screen.queryByRole("link", { name: "Fleet" })).toBeNull();
    expect(screen.getByRole("link", { name: "Board" })).toHaveAttribute("href", "#/board");
    expect(screen.getByRole("link", { name: "History" })).toHaveAttribute("href", "#/history");
    cleanup();
    render(<TopBar page="Board" phase="live" reporters={1} />);
    expect(screen.queryByRole("link", { name: "Board" })).toBeNull();
    expect(screen.getByRole("link", { name: "Fleet" })).toHaveAttribute("href", "#/");
    cleanup();
    // An orchestrator's page has both, so there is a way back to the wall and over to the board.
    render(<TopBar page="Orchestrator" phase="live" reporters={1} />);
    expect(screen.getByRole("link", { name: "Fleet" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Board" })).toBeInTheDocument();
  });

  it("says how many reporters are live, with no synced time", () => {
    renderBar(3);
    expect(screen.getByRole("status")).toHaveTextContent(/^3 reporters live$/);
    expect(screen.queryByText(/synced/)).toBeNull();
  });

  it("uses the singular for one reporter and the plural for none", () => {
    renderBar(1);
    expect(screen.getByRole("status")).toHaveTextContent(/^1 reporter live$/);
    cleanup();
    renderBar(0);
    expect(screen.getByRole("status")).toHaveTextContent(/^0 reporters live$/);
  });

  it("has no clock", () => {
    renderBar();
    expect(screen.queryByLabelText("Local time")).toBeNull();
  });
});
