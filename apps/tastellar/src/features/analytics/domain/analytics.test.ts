import { describe, expect, it } from "vitest";
import type { Entry, MediaType, Tag } from "../../../shared/bridge/libraryTypes";
import { mediaTypeName } from "../../library/MediaTypeIcon";
import {
  buildTopListCandidates,
  deriveMediaDistributions,
  deriveNextBoundaryReview,
  deriveRankedTierMediaDistribution,
  deriveRatingDistribution,
  deriveRarity,
  selectTopLists,
  type RankingTierOrder,
} from "./analytics";

function entry(
  id: string,
  score: number | null,
  options: Partial<Entry> = {},
): Entry {
  return {
    id,
    importOrder: 0,
    version: 1,
    title: id,
    disposition: "experienced",
    mediaTypeId: null,
    overallRating: score,
    coverAssetId: null,
    releaseDate: null,
    reviewText: "",
    shortLabel: null,
    criterionRatings: {},
    tagIds: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...options,
  };
}

function mediaType(id: string, name = id): MediaType {
  return {
    id,
    name,
    sortOrder: 0,
    iconKey: "film",
    criterionIds: [],
    archivedAt: null,
    version: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function tag(id: string, name = id): Tag {
  return {
    id,
    name,
    version: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function scores(values: readonly number[], options: Partial<Entry> = {}) {
  return values.map((score, index) => entry(`work-${index}`, score, options));
}

function repeated(score: number, count: number, options: Partial<Entry> = {}) {
  return Array.from({ length: count }, (_, index) => entry(`work-${index}`, score, options));
}

describe("rating distribution and rarity", () => {
  it("returns stable empty metrics without dividing by zero", () => {
    const result = deriveRatingDistribution([]);
    expect(result.total).toBe(0);
    expect(Object.values(result.counts)).toEqual(Array(10).fill(0));
    expect(Object.values(result.percentages)).toEqual(Array(10).fill(0));
    expect(result.mean).toBeNull();
    expect(result.median).toBeNull();
    expect(result.populationStandardDeviation).toBeNull();
    expect(result.observations).toEqual([]);
    expect(deriveRarity([]).map(({ score }) => score)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  });

  it("includes only active experienced works with an integer score from 1 to 10", () => {
    const values = [
      entry("rated", 8),
      entry("unrated", null),
      entry("planned", 10, { disposition: "planned" }),
      entry("dropped", 1, { disposition: "dropped" }),
      entry("invalid", 11),
    ];
    const result = deriveRatingDistribution(values);
    expect(result.total).toBe(1);
    expect(result.counts[8]).toBe(1);
    expect(result.percentages[8]).toBe(100);
    expect(deriveRarity(values).find(({ score }) => score === 8)).toEqual({ score: 8, count: 1, percentage: 100 });
  });

  it("keeps the entire page interpretation silent below 20, then recognizes a concentrated peak", () => {
    expect(deriveRatingDistribution(repeated(7, 19)).observations).toEqual([]);
    expect(deriveRatingDistribution(repeated(7, 20)).observations[0]).toEqual({
      key: "analytics.observation.concentrated",
      values: { score: 7 },
    });
  });

  it.each([
    { values: [6, 6, 6, 6, 6, 6, 5, 5, 5, 5, 4, 4, 7, 7, 8, 8, 9, 9, 10, 10], band: "middle" },
    { values: [7, 7, 7, 7, 7, 7, 7, 8, 8, 8, 8, 8, 8, 9, 9, 9, 10, 10, 6, 6], band: "appealing" },
    { values: [9, 9, 9, 9, 9, 9, 9, 9, 10, 10, 10, 10, 10, 10, 8, 8, 8, 7, 6, 6], band: "favorites" },
  ])("names a plausible broad rating band around its mode", ({ values, band }) => {
    const observations = deriveRatingDistribution(scores(values)).observations;
    const ratingBand = observations.find(({ key }) => key === "analytics.observation.ratingBand");
    expect(ratingBand?.values.band).toBe(band);
  });

  it("recognizes tied, separated peaks without breaking their tie", () => {
    const observations = deriveRatingDistribution(scores([
      1, 2, 4, 4, 4, 4, 4, 4, 4, 4,
      7, 7, 7, 7, 7, 7, 7, 7,
      9, 10,
    ])).observations;
    const peaks = observations.find(({ key }) => key === "analytics.observation.separatedPeaks");
    expect(peaks?.values).toEqual({ scoreA: 4, scoreB: 7 });
  });

  it("describes a flat spread and separately detects a genuinely broad spread", () => {
    const flat = deriveRatingDistribution(scores(Array.from({ length: 10 }, (_, score) => score + 1).flatMap((score) => [score, score])));
    expect(flat.observations.map(({ key }) => key)).toEqual([
      "analytics.observation.nearFlat",
      "analytics.observation.broadSpread",
    ]);

    const broad = deriveRatingDistribution(scores([
      1, 1, 1, 2, 2, 2, 4, 4, 4, 6, 6, 6, 8, 8, 8, 8, 10, 10, 10, 10,
    ]));
    expect(broad.occupiedBins).toBe(6);
    expect(broad.populationStandardDeviation).toBeGreaterThanOrEqual(2.2);
    expect(broad.observations.some(({ key }) => key === "analytics.observation.broadSpread")).toBe(true);
  });

  it("preserves exact counts and uses population spread for all-identical ratings", () => {
    const result = deriveRatingDistribution(repeated(8, 20));
    expect(result.modes).toEqual([8]);
    expect(result.mean).toBe(8);
    expect(result.median).toBe(8);
    expect(result.populationStandardDeviation).toBe(0);
    expect(result.counts[8]).toBe(20);
    expect(result.percentages[8]).toBe(100);
  });
});

describe("media distributions", () => {
  it("shows small supported samples but withholds comparisons below 20 and excludes archived types", () => {
    const entries = [
      ...repeated(8, 5, { mediaTypeId: "small" }),
      ...repeated(7, 19, { mediaTypeId: "almost" }),
      ...repeated(6, 5, { mediaTypeId: null }),
      ...repeated(9, 25, { mediaTypeId: "retired" }),
    ];
    const types = [mediaType("small"), mediaType("almost"), mediaType("retired")];
    types[2].archivedAt = "2026-09-01T00:00:00Z";
    // The page filters archived media types before supplying them to this projection.
    const result = deriveMediaDistributions(entries, types.filter((item) => !item.archivedAt));
    expect(result.series.map(({ typeId }) => typeId)).toEqual(["small", "almost", null]);
    expect(result.comparisons).toEqual([]);
    expect(result.series.find(({ typeId }) => typeId === null)?.count).toBe(5);
  });

  it("does not mistake different modes for a meaningful average difference", () => {
    const entries = [
      ...scores(Array(10).fill(6).concat(Array(10).fill(8)), { mediaTypeId: "a" }),
      ...scores(Array(10).fill(5).concat(Array(10).fill(9)), { mediaTypeId: "b" }),
    ];
    const comparison = deriveMediaDistributions(entries, [mediaType("a"), mediaType("b")]).comparisons[0];
    expect(comparison).toMatchObject({ kind: "similar", meanA: 7, meanB: 7, medianA: 7, medianB: 7 });
    expect(comparison.modesA).toEqual([6, 8]);
    expect(comparison.modesB).toEqual([5, 9]);
    expect(comparison.peakRelation).toBe("different");
  });

  it("states when well-supported media types share the same peak", () => {
    const entries = [
      ...repeated(7, 20, { mediaTypeId: "a" }),
      ...repeated(7, 20, { mediaTypeId: "b" }),
    ];
    expect(deriveMediaDistributions(entries, [mediaType("a"), mediaType("b")]).comparisons[0]).toMatchObject({
      kind: "similar",
      peakRelation: "same",
      modesA: [7],
      modesB: [7],
    });
  });

  it("calls a well-supported one-point shift higher average only when medians agree", () => {
    const entries = [
      ...repeated(7, 20, { mediaTypeId: "a" }),
      ...repeated(8, 20, { mediaTypeId: "b" }),
    ];
    const comparison = deriveMediaDistributions(entries, [mediaType("a"), mediaType("b")]).comparisons[0];
    expect(comparison).toMatchObject({ kind: "higherAverage", higherTypeId: "b", meanA: 7, meanB: 8, medianA: 7, medianB: 8 });
  });

  it("separates a close 0.2 mean shift from a meaningful 0.8 shift", () => {
    const close = [
      ...Array.from({ length: 95 }, (_, index) => entry(`a-${index}`, 7, { mediaTypeId: "a" })),
      ...Array.from({ length: 5 }, (_, index) => entry(`a-high-${index}`, 9, { mediaTypeId: "a" })),
      ...Array.from({ length: 85 }, (_, index) => entry(`b-${index}`, 7, { mediaTypeId: "b" })),
      ...Array.from({ length: 15 }, (_, index) => entry(`b-high-${index}`, 9, { mediaTypeId: "b" })),
    ];
    const closePair = deriveMediaDistributions(close, [mediaType("a"), mediaType("b")]).comparisons[0];
    expect(closePair).toMatchObject({ kind: "similar", meanA: 7.1, meanB: 7.3, medianA: 7, medianB: 7 });

    const meaningful = [
      ...Array.from({ length: 90 }, (_, index) => entry(`c-${index}`, 7, { mediaTypeId: "c" })),
      ...Array.from({ length: 10 }, (_, index) => entry(`c-high-${index}`, 8, { mediaTypeId: "c" })),
      ...Array.from({ length: 90 }, (_, index) => entry(`d-${index}`, 8, { mediaTypeId: "d" })),
      ...Array.from({ length: 10 }, (_, index) => entry(`d-low-${index}`, 7, { mediaTypeId: "d" })),
    ];
    const meaningfulPair = deriveMediaDistributions(meaningful, [mediaType("c"), mediaType("d")]).comparisons[0];
    expect(meaningfulPair).toMatchObject({ kind: "higherAverage", higherTypeId: "d", meanA: 7.1, meanB: 7.9, medianA: 7, medianB: 8 });
  });

  it("calls out every highest 8–10 share tie only with supported types", () => {
    const entries = [
      ...repeated(8, 20, { mediaTypeId: "a" }),
      ...repeated(9, 20, { mediaTypeId: "b" }),
      ...repeated(7, 20, { mediaTypeId: "lower" }),
      ...repeated(10, 19, { mediaTypeId: "small" }),
    ];
    const tied = deriveMediaDistributions(entries, [mediaType("a"), mediaType("b"), mediaType("lower"), mediaType("small")]);
    expect(tied.highShareLeaders.map(({ typeId, highShare, count }) => ({ typeId, highShare, count }))).toEqual([
      { typeId: "a", highShare: 1, count: 20 },
      { typeId: "b", highShare: 1, count: 20 },
    ]);

    const equal = deriveMediaDistributions([
      ...repeated(8, 20, { mediaTypeId: "a" }),
      ...repeated(9, 20, { mediaTypeId: "b" }),
    ], [mediaType("a"), mediaType("b")]);
    expect(equal.highShareLeaders).toEqual([]);
  });

  it("keeps the no-type series visible but does not use it for medium interpretation", () => {
    const entries = [
      ...repeated(7, 20, { mediaTypeId: "anime" }),
      ...repeated(9, 20, { mediaTypeId: null }),
    ];
    const result = deriveMediaDistributions(entries, [mediaType("anime")]);
    expect(result.series.some(({ typeId }) => typeId === null)).toBe(true);
    expect(result.comparisons).toEqual([]);
  });

  it("flags samples more than four times apart without speculative direction", () => {
    const entries = [
      ...repeated(9, 101, { mediaTypeId: "large" }),
      ...repeated(5, 20, { mediaTypeId: "small" }),
    ];
    const comparison = deriveMediaDistributions(entries, [mediaType("large"), mediaType("small")]).comparisons[0];
    expect(comparison).toMatchObject({ kind: "imbalanced", nA: 101, nB: 20 });
    expect(comparison.higherTypeId).toBeUndefined();
  });
});

describe("ranked media distribution within tiers", () => {
  const getTier = (result: ReturnType<typeof deriveRankedTierMediaDistribution>, score: number) =>
    result.tiers.find((tier) => tier.score === score)!;

  it("normalizes mean-rank strength to one without letting type volume set the result", () => {
    const entries = [
      entry("a-first", 8, { mediaTypeId: "a" }),
      entry("b-first", 8, { mediaTypeId: "b" }),
      entry("b-second", 8, { mediaTypeId: "b" }),
      entry("a-second", 8, { mediaTypeId: "a" }),
      entry("b-third", 8, { mediaTypeId: "b" }),
    ];
    const tier: RankingTierOrder[] = [{ score: 8, placedIds: entries.map(({ id }) => id) }];
    const result = getTier(deriveRankedTierMediaDistribution(entries, [mediaType("a"), mediaType("b")], tier), 8);
    const a = result.series.find(({ typeId }) => typeId === "a")!;
    const b = result.series.find(({ typeId }) => typeId === "b")!;

    expect(result).toMatchObject({ totalRated: 5, rankedCount: 5, coverage: 1, available: true });
    expect(a).toMatchObject({ count: 2, meanRank: 2.5, rawStrength: 0.7 });
    expect(b.count).toBe(3);
    expect(b.meanRank).toBeCloseTo(10 / 3);
    expect(a.score!).toBeGreaterThan(b.score!);
    expect(result.series.reduce((sum, series) => sum + (series.score ?? 0), 0)).toBeCloseTo(1);
  });

  it("excludes a sparse type only when both its small count and low relative share conditions hold", () => {
    const balanced = [
      entry("one", 8, { mediaTypeId: "one" }),
      entry("two-a", 8, { mediaTypeId: "two" }),
      entry("two-b", 8, { mediaTypeId: "two" }),
    ];
    const balancedTier: RankingTierOrder[] = [{ score: 8, placedIds: balanced.map(({ id }) => id) }];
    const balancedResult = getTier(
      deriveRankedTierMediaDistribution(balanced, [mediaType("one"), mediaType("two")], balancedTier),
      8,
    );
    expect(balancedResult.series.find(({ typeId }) => typeId === "one")).toMatchObject({
      count: 1,
      excludedReason: null,
      score: expect.any(Number),
    });

    const sparse = [
      entry("tiny-a", 8, { mediaTypeId: "tiny" }),
      ...Array.from({ length: 8 }, (_, index) => entry(`large-${index}`, 8, { mediaTypeId: "large" })),
      entry("tiny-b", 8, { mediaTypeId: "tiny" }),
    ];
    const sparseTier: RankingTierOrder[] = [{ score: 8, placedIds: sparse.map(({ id }) => id) }];
    const sparseResult = getTier(
      deriveRankedTierMediaDistribution(sparse, [mediaType("tiny"), mediaType("large")], sparseTier),
      8,
    );
    expect(sparseResult.series.find(({ typeId }) => typeId === "tiny")).toMatchObject({
      count: 2,
      excludedPlacedCount: 2,
      excludedReason: "sparseRelative",
      score: 0,
    });
    expect(sparseResult.series.find(({ typeId }) => typeId === "large")?.score).toBe(1);
    expect(sparseResult.series.reduce((sum, series) => sum + (series.score ?? 0), 0)).toBe(1);
  });

  it("keeps a type with three placed works even when it is at least four times smaller", () => {
    const entries = [
      ...Array.from({ length: 3 }, (_, index) => entry(`small-${index}`, 8, { mediaTypeId: "small" })),
      ...Array.from({ length: 100 }, (_, index) => entry(`large-${index}`, 8, { mediaTypeId: "large" })),
    ];
    const tier: RankingTierOrder[] = [{ score: 8, placedIds: entries.map(({ id }) => id) }];
    const result = getTier(deriveRankedTierMediaDistribution(entries, [mediaType("small"), mediaType("large")], tier), 8);
    expect(result.series.find(({ typeId }) => typeId === "small")).toMatchObject({
      count: 3,
      excludedReason: null,
      score: expect.any(Number),
    });
    expect(result.series.reduce((sum, series) => sum + (series.score ?? 0), 0)).toBeCloseTo(1);
  });

  it("keeps excluded works in canonical rank positions when calculating remaining type strength", () => {
    const entries = [
      entry("tiny-first", 8, { mediaTypeId: "tiny" }),
      entry("tiny-second", 8, { mediaTypeId: "tiny" }),
      ...Array.from({ length: 8 }, (_, index) => entry(`large-${index}`, 8, { mediaTypeId: "large" })),
    ];
    const tier: RankingTierOrder[] = [{ score: 8, placedIds: entries.map(({ id }) => id) }];
    const result = getTier(deriveRankedTierMediaDistribution(entries, [mediaType("tiny"), mediaType("large")], tier), 8);
    expect(result.series.find(({ typeId }) => typeId === "large")).toMatchObject({
      count: 8,
      meanRank: 6.5,
      rawStrength: 0.45,
      score: 1,
    });
  });

  it("changes within-tier strengths when the same type counts are ordered differently", () => {
    const entries = [
      entry("a-1", 8, { mediaTypeId: "a" }), entry("a-2", 8, { mediaTypeId: "a" }),
      entry("b-1", 8, { mediaTypeId: "b" }), entry("b-2", 8, { mediaTypeId: "b" }),
    ];
    const firstOrder: RankingTierOrder[] = [{ score: 8, placedIds: ["a-1", "a-2", "b-1", "b-2"] }];
    const reversedOrder: RankingTierOrder[] = [{ score: 8, placedIds: ["b-1", "b-2", "a-1", "a-2"] }];
    const types = [mediaType("a"), mediaType("b")];
    const first = getTier(deriveRankedTierMediaDistribution(entries, types, firstOrder), 8);
    const reversed = getTier(deriveRankedTierMediaDistribution(entries, types, reversedOrder), 8);
    expect(first.series.find(({ typeId }) => typeId === "a")?.score).toBeGreaterThan(
      first.series.find(({ typeId }) => typeId === "b")!.score!,
    );
    expect(reversed.series.find(({ typeId }) => typeId === "b")?.score).toBeGreaterThan(
      reversed.series.find(({ typeId }) => typeId === "a")!.score!,
    );
  });

  it("uses only validated placed entries and reports partial coverage without inventing ranks", () => {
    const entries = [
      entry("a-1", 7, { mediaTypeId: "a" }), entry("a-2", 7, { mediaTypeId: "a" }),
      entry("b-1", 7, { mediaTypeId: "b" }), entry("b-2", 7, { mediaTypeId: "b" }),
      entry("c-1", 7, { mediaTypeId: "c" }), entry("c-2", 7, { mediaTypeId: "c" }),
      entry("wrong-tier", 6, { mediaTypeId: "a" }),
    ];
    const tiers: RankingTierOrder[] = [{
      score: 7,
      placedIds: ["a-1", "stale", "b-1", "a-2", "a-1", "wrong-tier", "b-2"],
    }];
    const result = getTier(
      deriveRankedTierMediaDistribution(entries, [mediaType("a"), mediaType("b"), mediaType("c")], tiers),
      7,
    );
    expect(result).toMatchObject({ totalRated: 6, rankedCount: 4, coverage: 4 / 6, available: true });
    expect(result.series.find(({ typeId }) => typeId === "c")).toMatchObject({
      count: 0,
      ratedCount: 2,
      unplacedCount: 2,
      meanRank: null,
      excludedReason: "unplaced",
      score: 0,
    });
    expect(result.series.find(({ typeId }) => typeId === "b")?.meanRank).toBe(3);
    expect(result.series.reduce((sum, series) => sum + (series.score ?? 0), 0)).toBeCloseTo(1);
  });

  it("keeps untyped works visible in ranked coverage without dropping their tier position", () => {
    const entries = [
      entry("untyped", 8, { mediaTypeId: null }),
      entry("a", 8, { mediaTypeId: "a" }),
      entry("b", 8, { mediaTypeId: "b" }),
    ];
    const tier: RankingTierOrder[] = [{ score: 8, placedIds: ["untyped", "a", "b"] }];
    const result = getTier(deriveRankedTierMediaDistribution(entries, [mediaType("a"), mediaType("b")], tier), 8);
    const untyped = result.series.find(({ typeId }) => typeId === null);
    expect(untyped).toMatchObject({ count: 1, meanRank: 1, score: expect.any(Number) });
    expect(result).toMatchObject({ totalRated: 3, rankedCount: 3, coverage: 1, available: true });
    expect(result.series.reduce((sum, series) => sum + (series.score ?? 0), 0)).toBeCloseTo(1);
  });

  it("leaves empty, single-placement and single-type tiers unavailable instead of inventing a share", () => {
    const entries = [
      entry("a-1", 8, { mediaTypeId: "a" }),
      entry("a-2", 8, { mediaTypeId: "a" }),
      entry("b-1", 8, { mediaTypeId: "b" }),
    ];
    const tiers: RankingTierOrder[] = [{ score: 8, placedIds: ["a-1"] }];
    const result = deriveRankedTierMediaDistribution(entries, [mediaType("a"), mediaType("b")], tiers);
    expect(result.tiers.map(({ score }) => score)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const unavailable = getTier(result, 8);
    expect(unavailable).toMatchObject({ rankedCount: 1, coverage: 1 / 3, available: false });
    expect(unavailable.series.every(({ score }) => score === null)).toBe(true);
    expect(getTier(result, 7)).toMatchObject({ totalRated: 0, rankedCount: 0, coverage: 0, available: false });
  });
});

describe("ranked top candidates", () => {
  const types = [mediaType("anime", "Animation")];
  const tags = [tag("space", "Space"), tag("other", "Other")];

  it("requires enough deliberately placed works and score variety", () => {
    const works = Array.from({ length: 16 }, (_, index) => entry(`work-${index}`, [10, 9, 8][index % 3], {
      mediaTypeId: "anime",
      tagIds: [index < 8 ? "space" : "other"],
    }));
    const onlySevenPlaced: RankingTierOrder[] = [
      { score: 10, placedIds: ["work-0", "work-3"] },
      { score: 9, placedIds: ["work-1", "work-4"] },
      { score: 8, placedIds: ["work-2"] },
    ];
    expect(buildTopListCandidates(works, types, tags, onlySevenPlaced)).toEqual([]);

    const placed: RankingTierOrder[] = [
      { score: 10, placedIds: ["work-0", "work-3", "work-6", "work-9", "work-12", "work-15"] },
      { score: 9, placedIds: ["work-1", "work-4", "work-7", "work-10", "work-13"] },
      { score: 8, placedIds: ["work-2", "work-5", "work-8", "work-11", "work-14"] },
    ];
    expect(buildTopListCandidates(works, types, tags, placed).map(({ id }) => id)).toEqual([
      "type:anime",
      "tag:space",
      "tag:other",
    ]);
  });

  it("keeps useful tag filters when they contain the same works as a media type", () => {
    const comicWorks = Array.from({ length: 13 }, (_, index) => entry(`comic-${index}`, 8 + index % 3, {
      mediaTypeId: "comic",
      tagIds: ["manga"],
    }));
    const novelWorks = Array.from({ length: 10 }, (_, index) => entry(`novel-${index}`, 8 + index % 3, {
      mediaTypeId: "literature",
      tagIds: ["webnovel"],
    }));
    const all = [...comicWorks, ...novelWorks];
    const tiers: RankingTierOrder[] = [10, 9, 8].map((score) => ({
      score,
      placedIds: all.filter((work) => work.overallRating === score).map(({ id }) => id),
    }));
    const candidates = buildTopListCandidates(
      all,
      [mediaType("comic", "Comic"), mediaType("literature", "Literature")],
      [tag("manga", "Manga"), tag("webnovel", "Web Novel")],
      tiers,
    );
    expect(new Set(candidates.map(({ id }) => id))).toEqual(new Set([
      "type:comic",
      "tag:manga",
      "type:literature",
      "tag:webnovel",
    ]));
    expect(candidates.find(({ id }) => id === "tag:manga")?.entryIds).toEqual(
      candidates.find(({ id }) => id === "type:comic")?.entryIds,
    );
    expect(candidates.find(({ id }) => id === "tag:webnovel")?.entryIds).toEqual(
      candidates.find(({ id }) => id === "type:literature")?.entryIds,
    );
  });

  it("supports eight same-score works only when their supplied canonical order is explicit", () => {
    const works = repeated(10, 8, { mediaTypeId: "anime" });
    const tier: RankingTierOrder[] = [{ score: 10, placedIds: works.map(({ id }) => id) }];
    expect(buildTopListCandidates(works, types, [], tier)).toHaveLength(1);
  });

  it("uses the displayed media type name in filters while preserving custom names", () => {
    const works = repeated(8, 8, { mediaTypeId: "anime" });
    const tier: RankingTierOrder[] = [{ score: 8, placedIds: works.map(({ id }) => id) }];
    const animation = mediaType("anime", "Anime");
    animation.name = mediaTypeName(animation.id, animation.name);
    const animationCandidate = buildTopListCandidates(works, [animation], [], tier)[0];
    expect(animationCandidate.values.name).toBe("Animation");

    const custom = mediaType("cartoons", "Western animation");
    custom.name = mediaTypeName(custom.id, custom.name);
    expect(buildTopListCandidates(
      works.map((work) => ({ ...work, mediaTypeId: custom.id })),
      [custom],
      [],
      tier,
    )[0].values.name).toBe("Western animation");
  });

  it("ignores stale and duplicate ranked references and keeps canonical score/order", () => {
    const works = [
      entry("ten-a", 10, { mediaTypeId: "anime" }),
      entry("ten-b", 10, { mediaTypeId: "anime" }),
      ...Array.from({ length: 8 }, (_, index) => entry(`nine-${index}`, 9, { mediaTypeId: "anime" })),
    ];
    const tiers: RankingTierOrder[] = [
      { score: 9, placedIds: ["missing-id", ...works.slice(2).map(({ id }) => id), "nine-0"] },
      { score: 10, placedIds: ["ten-a", "ten-b"] },
    ];
    const list = buildTopListCandidates(works, types, [], tiers)[0];
    expect(list.entryIds).toEqual(["ten-a", "ten-b", ...works.slice(2).map(({ id }) => id)]);
  });

  it("uses a new candidate when one is available and avoids near-duplicate prior selections", () => {
    const candidates = Array.from({ length: 4 }, (_, index) => ({
      id: `type-${index}`,
      kind: "mediaType" as const,
      titleKey: "analytics.top.type" as const,
      values: { name: `Type ${index}` },
      entryIds: Array.from({ length: 8 }, (_, offset) => `set-${index}-${offset}`),
    }));
    const first = selectTopLists(candidates, 13, [], 1);
    const refreshed = selectTopLists(candidates, 42, first.map(({ entryIds }) => entryIds), 1);
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0].id).not.toBe(first[0].id);
    expect(selectTopLists(candidates, 13, [], 1)).toEqual(first);
  });

  it("can refresh to another filter when the eligible filters contain the same works", () => {
    const sharedWorks = Array.from({ length: 8 }, (_, index) => `shared-${index}`);
    const candidates = [
      {
        id: "type:comic",
        kind: "mediaType" as const,
        titleKey: "analytics.top.type" as const,
        values: { name: "Comic" },
        entryIds: sharedWorks,
      },
      {
        id: "tag:manga",
        kind: "tag" as const,
        titleKey: "analytics.top.tag" as const,
        values: { name: "Manga" },
        entryIds: sharedWorks,
      },
    ];
    const refreshed = selectTopLists(candidates, 42, [sharedWorks], 1, ["type:comic"]);
    expect(refreshed.map(({ id }) => id)).toEqual(["tag:manga"]);
  });
});

describe("rating boundary review", () => {
  it("chooses a real adjacent boundary in the documented descending priority order", () => {
    const entries = [entry("ten", 10), entry("nine", 9), entry("eight", 8), entry("six", 6)];
    const tiers: RankingTierOrder[] = [
      { score: 10, placedIds: ["ten"] },
      { score: 9, placedIds: ["nine"] },
      { score: 8, placedIds: ["eight"] },
      { score: 7, placedIds: [] },
      { score: 6, placedIds: ["six"] },
    ];
    const first = deriveNextBoundaryReview(entries, tiers);
    expect(first).toMatchObject({ highScore: 10, lowScore: 9, highEntryId: "ten", lowEntryId: "nine" });
    expect(deriveNextBoundaryReview(entries, tiers, [first!.fingerprint])).toMatchObject({
      highScore: 9,
      lowScore: 8,
      highEntryId: "nine",
      lowEntryId: "eight",
    });
  });

  it("does not bridge an empty score or repeat an unchanged confirmation", () => {
    const entries = [entry("ten", 10), entry("eight", 8)];
    const tiers: RankingTierOrder[] = [
      { score: 10, placedIds: ["ten"] },
      { score: 9, placedIds: [] },
      { score: 8, placedIds: ["eight"] },
    ];
    expect(deriveNextBoundaryReview(entries, tiers)).toBeNull();
    expect(deriveNextBoundaryReview(entries, tiers, ["unrelated"])).toBeNull();
  });

  it("changes the confirmation fingerprint when a boundary neighbor changes", () => {
    const entries = [entry("ten", 10), entry("ten-inner", 10), entry("nine", 9), entry("nine-inner", 9)];
    const tiers: RankingTierOrder[] = [
      { score: 10, placedIds: ["ten-inner", "ten"] },
      { score: 9, placedIds: ["nine", "nine-inner"] },
    ];
    const first = deriveNextBoundaryReview(entries, tiers)!;
    const reordered: RankingTierOrder[] = [
      { score: 10, placedIds: ["ten", "ten-inner"] },
      tiers[1],
    ];
    expect(deriveNextBoundaryReview(entries, reordered, [first.fingerprint])?.fingerprint).not.toBe(first.fingerprint);
  });

  it("ignores stale and duplicate ordered IDs when selecting boundary participants", () => {
    const entries = [entry("ten", 10), entry("nine", 9)];
    const tiers: RankingTierOrder[] = [
      { score: 10, placedIds: ["stale", "ten", "ten"] },
      { score: 9, placedIds: ["nine", "stale"] },
    ];
    const review = deriveNextBoundaryReview(entries, tiers);
    expect(review).toMatchObject({ highEntryId: "ten", lowEntryId: "nine" });
    expect(review?.highEntryId).not.toBe(review?.lowEntryId);
  });
});
