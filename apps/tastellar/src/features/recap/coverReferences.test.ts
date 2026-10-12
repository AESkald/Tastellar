import { describe, expect, it } from "vitest";
import type { Entry } from "../../shared/bridge/libraryTypes";
import { createRecapComposition } from "./domain/recap";
import { refreshRecapCoverReferences } from "./coverReferences";

const entry = (id: string, coverAssetId: string | null): Entry => ({
  id,
  importOrder: null,
  version: 1,
  title: `Work ${id}`,
  disposition: "experienced",
  mediaTypeId: "book",
  overallRating: 8,
  coverAssetId,
  releaseDate: { year: 2020, precision: "year" },
  reviewText: "",
  shortLabel: null,
  criterionRatings: {},
  tagIds: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("refreshRecapCoverReferences", () => {
  it("refreshes only current library cover references and preserves saved composition edits", () => {
    const first = entry("first", null);
    const second = entry("second", "old-cover");
    const composition = createRecapComposition(
      "topTen",
      [first, second],
      [{ score: 8, placedIds: [first.id, second.id] }],
      [{
        id: "book", name: "Books", sortOrder: 0, iconKey: "book-open",
        criterionIds: [], archivedAt: null, version: 1,
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      }],
      undefined,
      { id: "saved", now: "2026-01-01T00:00:00.000Z" },
    );
    const saved = {
      ...composition,
      caption: "Hand-edited caption",
      filter: { kind: "all" as const, tagIds: ["favorite"], tagMode: "all" as const },
      slots: composition.slots.map((slot, index) => ({
        ...slot,
        page: index,
        titleOverride: index === 0 ? "Pinned title" : slot.titleOverride,
        entry: slot.entry && {
          ...slot.entry,
          coverAssetId: index === 0 ? null : "old-cover",
        },
      })),
    };
    const latest = [
      { ...first, coverAssetId: "new-first-cover" },
      { ...second, coverAssetId: null },
    ];

    const refreshed = refreshRecapCoverReferences(saved, latest);

    expect(refreshed.slots.map((slot) => [slot.page, slot.titleOverride])).toEqual(
      saved.slots.map((slot) => [slot.page, slot.titleOverride]),
    );
    expect(refreshed).toMatchObject({ id: saved.id, caption: saved.caption, filter: saved.filter });
    expect(refreshed.slots[0].entry).toMatchObject({ id: "first", coverAssetId: "new-first-cover" });
    expect(refreshed.slots[1].entry).toMatchObject({ id: "second", coverAssetId: null });
    expect(refreshed.slots[0].entry?.title).toBe(saved.slots[0].entry?.title);
    expect(refreshed.slots[1].entry?.title).toBe(saved.slots[1].entry?.title);
  });

  it("retains the portable snapshot for deleted entries and preserves identity when references match", () => {
    const original = entry("deleted", "saved-cover");
    const composition = createRecapComposition(
      "topTen",
      [original],
      [{ score: 8, placedIds: [original.id] }],
      [{
        id: "book", name: "Books", sortOrder: 0, iconKey: "book-open",
        criterionIds: [], archivedAt: null, version: 1,
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      }],
    );
    expect(refreshRecapCoverReferences(composition, [])).toBe(composition);
    expect(refreshRecapCoverReferences(composition, [original])).toBe(composition);
  });
});
