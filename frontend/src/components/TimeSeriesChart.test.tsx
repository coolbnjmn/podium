import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { TimeSeriesChart } from "./TimeSeriesChart";
import { formatTokens } from "../format";

describe("TimeSeriesChart", () => {
  it("renders the chart title", () => {
    render(
      <TimeSeriesChart
        title="Claude Code tokens/day"
        data={[
          { date: "2026-07-20", value: 1000 },
          { date: "2026-07-21", value: 2000 },
        ]}
        color="var(--series-1)"
        valueFormatter={formatTokens}
      />,
    );
    expect(screen.getByText("Claude Code tokens/day")).toBeInTheDocument();
  });

  it("renders without crashing when given an empty series", () => {
    render(<TimeSeriesChart title="Empty" data={[]} color="var(--series-1)" valueFormatter={formatTokens} />);
    expect(screen.getByText("Empty")).toBeInTheDocument();
  });
});
