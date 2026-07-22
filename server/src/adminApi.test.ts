import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchApiUsage } from "./adminApi.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function usageResponse() {
  return {
    data: [
      {
        starting_at: "2026-07-20T00:00:00Z",
        ending_at: "2026-07-21T00:00:00Z",
        results: [
          {
            model: "claude-opus-4-8",
            uncached_input_tokens: 1000,
            cache_read_input_tokens: 200,
            cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 100 },
            output_tokens: 500,
          },
        ],
      },
    ],
    has_more: false,
    next_page: null,
  };
}

function costResponse() {
  return {
    data: [
      {
        starting_at: "2026-07-20T00:00:00Z",
        ending_at: "2026-07-21T00:00:00Z",
        results: [{ amount: "250.00", model: "claude-opus-4-8" }],
      },
    ],
    has_more: false,
    next_page: null,
  };
}

describe("fetchApiUsage", () => {
  it("returns a not-configured result when no API key is provided", async () => {
    const result = await fetchApiUsage(undefined);
    expect(result.configured).toBe(false);
    expect(result.daily).toEqual([]);
  });

  it("aggregates usage and cost reports into daily and per-model rollups", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = url.toString();
      if (href.includes("usage_report/messages")) {
        return new Response(JSON.stringify(usageResponse()), { status: 200 });
      }
      if (href.includes("cost_report")) {
        return new Response(JSON.stringify(costResponse()), { status: 200 });
      }
      throw new Error(`Unexpected URL: ${href}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const now = new Date("2026-07-21T12:00:00.000Z");
    const result = await fetchApiUsage("sk-ant-admin01-test", now);

    expect(result.configured).toBe(true);
    expect(result.daily).toEqual([{ date: "2026-07-20", totalTokens: 1800, costUsd: 2.5 }]);
    expect(result.byModel).toEqual([{ model: "claude-opus-4-8", totalTokens: 1800, costUsd: 2.5 }]);
    expect(result.week.costUsd).toBeCloseTo(2.5);
  });

  it("throws when the Admin API returns a non-2xx status", async () => {
    const fetchMock = vi.fn(async () => new Response("forbidden", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchApiUsage("bad-key", new Date())).rejects.toThrow(/403/);
  });
});
