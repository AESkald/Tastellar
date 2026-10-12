import { describe, expect, it, vi } from "vitest";
import { loadRecapCoverWithCache } from "./coverCache";

describe("Recap cover request cache", () => {
  it("drops settled reads so source bytes remain governed by the shared bounded cache", async () => {
    const cache = new Map<string, Promise<string | null>>();
    const load = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("data:image/png;base64,recovered");

    await expect(loadRecapCoverWithCache(cache, "same-cover", load)).resolves.toBeNull();
    expect(cache.has("same-cover")).toBe(false);
    await expect(loadRecapCoverWithCache(cache, "same-cover", load)).resolves.toBe("data:image/png;base64,recovered");
    expect(cache.has("same-cover")).toBe(false);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("shares the in-flight read for duplicate recap slots", async () => {
    const cache = new Map<string, Promise<string | null>>();
    let finish!: (source: string | null) => void;
    const load = vi.fn(() => new Promise<string | null>((resolve) => { finish = resolve; }));
    const first = loadRecapCoverWithCache(cache, "shared-cover", load);
    const second = loadRecapCoverWithCache(cache, "shared-cover", load);

    expect(load).toHaveBeenCalledTimes(0);
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    finish("data:image/png;base64,shared");
    await expect(Promise.all([first, second])).resolves.toEqual([
      "data:image/png;base64,shared", "data:image/png;base64,shared",
    ]);
    expect(cache.has("shared-cover")).toBe(false);
  });
});
