import { describe, it, expect, vi, afterEach } from "vitest";
import { TTLCache } from "./cache.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TTLCache", () => {
  it("loads once and serves the cached value within the TTL window", async () => {
    const loader = vi.fn().mockResolvedValue("value-1");
    const cache = new TTLCache<string>(1000);

    const first = await cache.getOrLoad(loader);
    const second = await cache.getOrLoad(loader);

    expect(first).toBe("value-1");
    expect(second).toBe("value-1");
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("reloads after the TTL expires", async () => {
    const loader = vi.fn().mockResolvedValueOnce("value-1").mockResolvedValueOnce("value-2");
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(0);

    const cache = new TTLCache<string>(1000);
    const first = await cache.getOrLoad(loader);

    nowSpy.mockReturnValue(1500);
    const second = await cache.getOrLoad(loader);

    expect(first).toBe("value-1");
    expect(second).toBe("value-2");
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("invalidate() forces the next call to reload", async () => {
    const loader = vi.fn().mockResolvedValueOnce("value-1").mockResolvedValueOnce("value-2");
    const cache = new TTLCache<string>(10_000);

    await cache.getOrLoad(loader);
    cache.invalidate();
    const second = await cache.getOrLoad(loader);

    expect(second).toBe("value-2");
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
