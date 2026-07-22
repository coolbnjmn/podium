import { describe, it, expect } from "vitest";
import { formatTokens, formatUsd } from "./format";

describe("formatTokens", () => {
  it("formats small numbers as-is", () => {
    expect(formatTokens(42)).toBe("42");
  });

  it("formats thousands with a K suffix", () => {
    expect(formatTokens(12_345)).toBe("12.3K");
  });

  it("formats millions with an M suffix", () => {
    expect(formatTokens(2_500_000)).toBe("2.5M");
  });
});

describe("formatUsd", () => {
  it("formats to two decimal places with a dollar sign", () => {
    expect(formatUsd(12.5)).toBe("$12.50");
    expect(formatUsd(0)).toBe("$0.00");
  });
});
