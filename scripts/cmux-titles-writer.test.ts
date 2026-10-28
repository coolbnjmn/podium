import { describe, expect, it } from "vitest";
import { USAGE, parseArgs } from "./cmux-titles-writer.mjs";

describe("cmux-titles-writer arguments", () => {
  it("defaults to a 15 second loop with the standard file", () => {
    expect(parseArgs([])).toEqual({ once: false, intervalMs: 15_000, file: null });
  });

  it("reads --once, --interval and --file", () => {
    expect(parseArgs(["--once", "--interval", "30", "--file", "/tmp/t.json"])).toEqual({ once: true, intervalMs: 30_000, file: "/tmp/t.json" });
  });

  it("rejects an interval under a second, a missing value and an unknown flag", () => {
    expect(() => parseArgs(["--interval", "0"])).toThrow("--interval");
    expect(() => parseArgs(["--interval", "301"])).toThrow("--interval");
    expect(() => parseArgs(["--interval", "2147484"])).toThrow("--interval");
    expect(() => parseArgs(["--interval"])).toThrow("--interval");
    expect(() => parseArgs(["--file"])).toThrow("--file");
    expect(() => parseArgs(["--bogus"])).toThrow("unknown argument");
  });

  it("answers --help with the usage text", () => {
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(USAGE).toContain("--once");
  });
});
