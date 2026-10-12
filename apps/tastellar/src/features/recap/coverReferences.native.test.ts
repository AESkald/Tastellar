import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Entry, MediaType } from "../../shared/bridge/libraryTypes";

const nativeMock = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: nativeMock.invoke,
}));

import { createRecapComposition } from "./domain/recap";
import { refreshRecapCoverReferences } from "./coverReferences";
import { loadRecapCover } from "../../shared/bridge/recapBridge";
import { clearEntryCoverCache } from "../../shared/bridge/libraryBridge";

const entry: Entry = {
  id: "cover-entry",
  importOrder: 0,
  version: 1,
  title: "Cover entry",
  disposition: "experienced",
  mediaTypeId: "book",
  overallRating: 8,
  coverAssetId: "old-cover-asset",
  releaseDate: { year: 2020, precision: "year" },
  reviewText: "",
  shortLabel: null,
  criterionRatings: {},
  tagIds: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const book: MediaType = {
  id: "book",
  name: "Books",
  sortOrder: 0,
  iconKey: "book-open",
  criterionIds: [],
  archivedAt: null,
  version: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("Recap current native cover reference", () => {
  beforeEach(() => {
    clearEntryCoverCache();
    nativeMock.invoke.mockReset();
  });

  it("loads the current asset after refreshing a stale saved draft snapshot", async () => {
    const saved = createRecapComposition(
      "topTen",
      [entry],
      [{ score: 8, placedIds: [entry.id] }],
      [book],
      undefined,
      { id: "saved-cover-draft", now: "2026-01-01T00:00:00.000Z" },
    );
    const currentLibraryEntry = { ...entry, coverAssetId: "current-cover-asset" };
    const preview = refreshRecapCoverReferences(saved, [currentLibraryEntry]);
    const currentSnapshot = preview.slots.find((slot) => slot.entry)?.entry;
    expect(currentSnapshot?.coverAssetId).toBe("current-cover-asset");

    nativeMock.invoke.mockResolvedValue("data:image/jpeg;base64,current-cover");
    await expect(
      loadRecapCover(currentSnapshot!.id, currentSnapshot!.coverAssetId),
    ).resolves.toBe("data:image/jpeg;base64,current-cover");
    expect(nativeMock.invoke).toHaveBeenCalledWith("load_recap_cover", {
      assetId: "current-cover-asset",
    });
    expect(nativeMock.invoke).not.toHaveBeenCalledWith("load_recap_cover", {
      assetId: "old-cover-asset",
    });
  });
});
