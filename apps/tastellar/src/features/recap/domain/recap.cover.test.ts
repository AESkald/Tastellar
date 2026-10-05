import { describe, expect, it } from "vitest";
import type { Entry, MediaType, RemoteCoverReference } from "../../../shared/bridge/libraryTypes";
import {
  createRecapComposition,
  getRecapSourceFingerprint,
  normalizeRecapComposition,
} from "./recap";

const cover: RemoteCoverReference = {
  provider: "igdb",
  url: "https://images.igdb.com/igdb/image/upload/t_cover_big/recap-fixture.jpg",
  sourceUrl: "https://www.igdb.com/games/recap-fixture",
  attribution: "IGDB",
};

const mediaType: MediaType = {
  id: "games", name: "Games", sortOrder: 0, iconKey: "gamepad-2", criterionIds: [],
  archivedAt: null, version: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
};

function makeEntry(remoteCover: RemoteCoverReference | null, coverAssetId: string | null = null): Entry {
  return {
    id: "fixture", importOrder: 0, version: 1, title: "Provider cover fixture", disposition: "experienced",
    mediaTypeId: "games", overallRating: 9, coverAssetId, remoteCover, releaseDate: { year: 2020, precision: "year" },
    reviewText: "", shortLabel: null, criterionRatings: {}, tagIds: [],
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("Recap cover snapshots", () => {
  it("preserves trusted provider cover references and fingerprints their URLs", () => {
    const entry = makeEntry(cover);
    const composition = createRecapComposition("topTen", [entry], [{ score: 9, placedIds: [entry.id] }], [mediaType], undefined, {
      id: "remote-cover-draft", now: "2026-01-01T00:00:00.000Z",
    });

    expect(composition.slots[0].entry?.remoteCover).toEqual(cover);
    expect(normalizeRecapComposition(composition)?.slots[0].entry?.remoteCover).toEqual(cover);
    expect(getRecapSourceFingerprint([entry], [{ score: 9, placedIds: [entry.id] }], [mediaType])).not.toBe(
      getRecapSourceFingerprint([makeEntry({ ...cover, url: "https://images.igdb.com/igdb/image/upload/t_cover_big/changed.jpg" })], [{ score: 9, placedIds: [entry.id] }], [mediaType]),
    );
  });

  it("hydrates remote or embedded cover references into legacy drafts", () => {
    const composition = createRecapComposition("topTen", [makeEntry(cover)], [{ score: 9, placedIds: ["fixture"] }], [mediaType], undefined, {
      id: "legacy-cover-draft", now: "2026-01-01T00:00:00.000Z",
    });
    const makeLegacy = (source: typeof composition) => ({
      ...source,
      slots: source.slots.map((slot) => {
        if (!slot.entry) return slot;
        const { remoteCover: _remoteCover, ...legacyEntry } = slot.entry;
        return { ...slot, entry: { ...legacyEntry, coverAssetId: null } };
      }),
    });

    expect(normalizeRecapComposition(makeLegacy(composition), [makeEntry(cover)], [mediaType])?.slots[0].entry).toMatchObject({
      coverAssetId: null,
      remoteCover: cover,
    });

    const embeddedEntry = makeEntry(null, "asset-hash");
    const embeddedComposition = createRecapComposition("topTen", [embeddedEntry], [{ score: 9, placedIds: [embeddedEntry.id] }], [mediaType], undefined, {
      id: "legacy-embedded-cover-draft", now: "2026-01-01T00:00:00.000Z",
    });
    expect(normalizeRecapComposition(makeLegacy(embeddedComposition), [embeddedEntry], [mediaType])?.slots[0].entry).toMatchObject({
      coverAssetId: "asset-hash",
      remoteCover: null,
    });
  });
});
