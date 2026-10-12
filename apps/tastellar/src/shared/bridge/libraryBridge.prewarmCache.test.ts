import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock, isTauri: () => true }));

import {
  clearEntryCoverCache,
  loadEntryCover,
  prewarmEntryCovers,
} from "./libraryBridge";

describe("prewarmed library cover cache", () => {
  beforeEach(() => {
    clearEntryCoverCache();
    invokeMock.mockReset();
  });

  it("keeps the first 16 warmed covers across a 300-cover grid load", async () => {
    const source = `data:image/png;base64,${"A".repeat(128 * 1024)}`;
    invokeMock.mockImplementation(async () => source);
    const entries = Array.from({ length: 300 }, (_, index) => ({
      id: `entry-${index}`,
      coverAssetId: `asset-${index}`,
    }));

    await prewarmEntryCovers(entries, { concurrency: 3, limit: 32 });
    const queue = entries.slice(32);
    const worker = async () => {
      while (queue.length) {
        const entry = queue.shift();
        if (entry) await loadEntryCover(entry.id, entry.coverAssetId);
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    expect(invokeMock).toHaveBeenCalledTimes(300);

    await Promise.all(entries.slice(0, 16).map((entry) => loadEntryCover(entry.id, entry.coverAssetId)));
    expect(invokeMock).toHaveBeenCalledTimes(300);
  });
});
