import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearEntryCoverCache,
  loadCachedCoverSource,
  peekCoverSource,
} from "./libraryBridge";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("Library cover source cache", () => {
  beforeEach(() => clearEntryCoverCache());

  it("coalesces in-flight reads while keeping immutable asset variants separate", async () => {
    const libraryLoad = vi.fn(async () => "data:image/png;base64,library");
    const recapLoad = vi.fn(async () => "data:image/png;base64,recap");
    const libraryA = loadCachedCoverSource("library:asset-1", libraryLoad);
    const libraryB = loadCachedCoverSource("library:asset-1", libraryLoad);
    const recap = loadCachedCoverSource("recap:asset-1", recapLoad);

    await expect(Promise.all([libraryA, libraryB, recap])).resolves.toEqual([
      "data:image/png;base64,library",
      "data:image/png;base64,library",
      "data:image/png;base64,recap",
    ]);
    expect(libraryLoad).toHaveBeenCalledTimes(1);
    expect(recapLoad).toHaveBeenCalledTimes(1);
    expect(peekCoverSource("library:asset-1")).toBe("data:image/png;base64,library");
    expect(peekCoverSource("recap:asset-1")).toBe("data:image/png;base64,recap");
  });

  it("makes a warmed source available synchronously without loading again", async () => {
    const load = vi.fn(async () => "data:image/png;base64,warmed");
    await loadCachedCoverSource("library:asset-2", load);

    expect(peekCoverSource("library:asset-2")).toBe("data:image/png;base64,warmed");
    await expect(loadCachedCoverSource("library:asset-2", load)).resolves.toBe("data:image/png;base64,warmed");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not let a cleared request repopulate or delete a newer pending request", async () => {
    const stale = deferred<string | null>();
    const current = deferred<string | null>();
    const staleLoad = vi.fn(() => stale.promise);
    const currentLoad = vi.fn(() => current.promise);
    const staleRequest = loadCachedCoverSource("recap:asset-3", staleLoad);

    clearEntryCoverCache();
    const currentRequest = loadCachedCoverSource("recap:asset-3", currentLoad);
    stale.resolve("data:image/png;base64,stale");
    await expect(staleRequest).resolves.toBe("data:image/png;base64,stale");

    expect(peekCoverSource("recap:asset-3")).toBeNull();
    const thirdLoad = vi.fn(async () => "data:image/png;base64,third");
    const coalescedCurrent = loadCachedCoverSource("recap:asset-3", thirdLoad);
    expect(thirdLoad).not.toHaveBeenCalled();

    current.resolve("data:image/png;base64,current");
    await expect(Promise.all([currentRequest, coalescedCurrent])).resolves.toEqual([
      "data:image/png;base64,current",
      "data:image/png;base64,current",
    ]);
    expect(peekCoverSource("recap:asset-3")).toBe("data:image/png;base64,current");
    expect(currentLoad).toHaveBeenCalledTimes(1);
  });
});
