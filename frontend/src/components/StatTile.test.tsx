import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { StatTile } from "./StatTile";

describe("StatTile", () => {
  it("renders label, primary value, and optional secondary value", () => {
    render(<StatTile label="Today — Claude Code" primaryValue="12.3K" secondaryValue="tokens" />);
    expect(screen.getByText("Today — Claude Code")).toBeInTheDocument();
    expect(screen.getByText("12.3K")).toBeInTheDocument();
    expect(screen.getByText("tokens")).toBeInTheDocument();
  });

  it("omits the secondary value node when not provided", () => {
    render(<StatTile label="Today — API spend" primaryValue="$4.20" />);
    expect(screen.queryByText("tokens")).not.toBeInTheDocument();
  });
});
