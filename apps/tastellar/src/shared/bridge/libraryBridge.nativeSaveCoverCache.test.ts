import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock, isTauri: () => true }));

import {
  clearEntryCoverCache,
  loadEntryCover,
  peekEntryCover,
  saveEntryCover,
} from "./libraryBridge";
import type { LibraryState } from "./libraryTypes";

const savedState = {
  revision: 1,
  entries: [{ id: "entry-1", coverAssetId: "asset-new" }],
  mediaTypes: [],
  criteria: [],
  tags: [],
} as unknown as LibraryState;

describe("native cover replacement cache", () => {
  beforeEach(() => {
    clearEntryCoverCache();
    invokeMock.mockReset();
  });

  it("does not cache the uploaded original as a library thumbnail", async () => {
    const thumbnail = "data:image/png;base64,small-thumbnail";
    invokeMock.mockImplementation(async (command: string) =>
      command === "save_entry_cover" ? savedState : thumbnail,
    );

    await saveEntryCover(0, "entry-1", "image/png", "large-original-bytes");

    expect(peekEntryCover("entry-1", "asset-new")).toBeNull();
    await expect(loadEntryCover("entry-1", "asset-new")).resolves.toBe(thumbnail);
    expect(invokeMock).toHaveBeenCalledWith("load_entry_cover", { entryId: "entry-1" });
    expect(peekEntryCover("entry-1", "asset-new")).toBe(thumbnail);
  });

  it("does not let an old in-flight asset request repopulate after replacement", async () => {
    let resolveOld!: (source: string) => void;
    const oldRequest = new Promise<string>((resolve) => { resolveOld = resolve; });
    const newThumbnail = "data:image/png;base64,new-thumbnail";
    let loadCount = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === "save_entry_cover") return Promise.resolve(savedState);
      if (command === "load_entry_cover") {
        loadCount += 1;
        return loadCount === 1 ? oldRequest : Promise.resolve(newThumbnail);
      }
      return Promise.resolve(null);
    });

    const pendingOld = loadEntryCover("entry-1", "asset-old");
    await saveEntryCover(0, "entry-1", "image/png", "large-original-bytes");
    const pendingNew = loadEntryCover("entry-1", "asset-new");
    await expect(pendingNew).resolves.toBe(newThumbnail);
    resolveOld("data:image/png;base64,old-thumbnail");
    await expect(pendingOld).resolves.toBe("data:image/png;base64,old-thumbnail");

    expect(peekEntryCover("entry-1")).toBe(newThumbnail);
    expect(peekEntryCover("entry-1", "asset-old")).toBeNull();
  });
});
