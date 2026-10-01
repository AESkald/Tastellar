import { describe, expect, it } from "vitest";
import { buildLibraryRankIndex, sortEntriesByRank } from "./rankDisplay";

const entries = [
  { id: "ten-second", disposition: "experienced", overallRating: 10, importOrder: 1 },
  { id: "nine-only", disposition: "experienced", overallRating: 9, importOrder: 2 },
  { id: "ten-first", disposition: "experienced", overallRating: 10, importOrder: 0 },
  { id: "ten-unplaced", disposition: "experienced", overallRating: 10, importOrder: 3 },
  { id: "ten-unplaced-next", disposition: "experienced", overallRating: 10, importOrder: 4 },
  { id: "planned", disposition: "planned", overallRating: 10, importOrder: 5 },
];

describe("library rank display", () => {
  it("uses explicit placed order for within-score and overall positions", () => {
    const ranks = buildLibraryRankIndex(entries, [
      { score: 10, placedIds: ["ten-first", "ten-second"] },
      { score: 9, placedIds: ["nine-only"] },
    ]);

    expect(ranks.withinScore.get("ten-first")).toBe(1);
    expect(ranks.withinScore.get("ten-second")).toBe(2);
    expect(ranks.overall.get("ten-first")).toBe(1);
    expect(ranks.overall.get("ten-second")).toBe(2);
    expect(ranks.overall.get("nine-only")).toBe(3);
    expect(ranks.overall.has("ten-unplaced")).toBe(false);
    expect(ranks.overall.has("planned")).toBe(false);
    expect(ranks.totalPlaced).toBe(3);
  });

  it("sorts placed works first, then unplaced works in immutable import order", () => {
    const ranks = buildLibraryRankIndex(entries, [
      { score: 10, placedIds: ["ten-first", "ten-second"] },
    ]);
    const scoreGroup = [
      entries[4],
      entries[3],
      entries[0],
      entries[2],
    ];

    expect(
      sortEntriesByRank(scoreGroup, entries, ranks.overall).map(
        (entry) => entry.id,
      ),
    ).toEqual([
      "ten-first",
      "ten-second",
      "ten-unplaced",
      "ten-unplaced-next",
    ]);
  });

  it("does not invent ranks while ranking state is unavailable", () => {
    const ranks = buildLibraryRankIndex(entries, null);
    expect(ranks.totalPlaced).toBe(0);
    expect(ranks.withinScore.size).toBe(0);
    expect(ranks.overall.size).toBe(0);
  });
});
