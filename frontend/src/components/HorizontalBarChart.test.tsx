import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { HorizontalBarChart } from "./HorizontalBarChart";
import { formatTokens } from "../format";

describe("HorizontalBarChart", () => {
  it("renders the chart title", () => {
    render(
      <HorizontalBarChart
        title="Claude Code tokens by model"
        data={[
          { label: "claude-opus-4-8", value: 5000 },
          { label: "claude-sonnet-5", value: 3000 },
        ]}
        valueFormatter={formatTokens}
      />,
    );
    expect(screen.getByText("Claude Code tokens by model")).toBeInTheDocument();
  });

  it("renders without crashing when given no entries", () => {
    render(<HorizontalBarChart title="Empty" data={[]} valueFormatter={formatTokens} />);
    expect(screen.getByText("Empty")).toBeInTheDocument();
  });
});
