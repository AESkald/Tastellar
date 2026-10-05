import type { Entry, MediaType, Tag } from "../../../shared/bridge/libraryTypes";
import { buildLibraryRankIndex } from "../../library/domain/rankDisplay";

export type ScoreCounts = Record<number, number>;

export interface RatingObservation {
  key: string;
  values: Record<string, string | number>;
}

export interface RatingDistribution {
  total: number;
  counts: ScoreCounts;
  percentages: Record<number, number>;
  mean: number | null;
  median: number | null;
  populationStandardDeviation: number | null;
  occupiedBins: number;
  modes: number[];
  observations: RatingObservation[];
}

export interface MediaDistributionSeries {
  typeId: string | null;
  name: string | null;
  count: number;
  /** Counts for scores 1 through 10. */
  counts: number[];
  mean: number;
  median: number;
  modes: number[];
  highShare: number;
}

export type MediaComparisonKind =
  | "imbalanced"
  | "similar"
  | "higherAverage"
  | "modest"
  | "mixed";

export interface MediaDistributionComparison {
  typeAId: string | null;
  typeBId: string | null;
  nA: number;
  nB: number;
  meanA: number;
  meanB: number;
  medianA: number;
  medianB: number;
  modesA: number[];
  modesB: number[];
  highShareA: number;
  highShareB: number;
  peakRelation: "same" | "different";
  kind: MediaComparisonKind;
  higherTypeId?: string | null;
}

export interface MediaDistributions {
  series: MediaDistributionSeries[];
  comparisons: MediaDistributionComparison[];
  /** Comparable types tied for the largest share of ratings at 8–10. */
  highShareLeaders: Array<{
    typeId: string;
    name: string;
    count: number;
    highCount: number;
    highShare: number;
  }>;
}

export interface RatingRarity {
  score: number;
  count: number;
  percentage: number;
}

export interface RankingTierOrder {
  score: number;
  placedIds: string[];
}

export type RankedTierMediaExclusionReason = "unplaced" | "sparseRelative";

export interface RankedTierMediaSeries {
  typeId: string | null;
  name: string | null;
  /** Explicitly placed works of this type in this rating tier. */
  count: number;
  /** All active rated works of this type in this rating tier. */
  ratedCount: number;
  unplacedCount: number;
  excludedPlacedCount: number;
  /** 1-based mean position among explicitly placed works in this tier. */
  meanRank: number | null;
  /** Reverse-scaled mean rank before normalization. */
  rawStrength: number | null;
  /** Normalized relative rank weight; null when this tier cannot be compared. */
  score: number | null;
  excludedReason: RankedTierMediaExclusionReason | null;
}

export interface RankedTierMediaDistributionTier {
  score: number;
  /** All active rated works at this rating, whether explicitly placed or not. */
  totalRated: number;
  /** Valid, canonical placed works used to calculate rank positions. */
  rankedCount: number;
  coverage: number;
  /** A tier needs at least two placed works across at least two media groups. */
  available: boolean;
  series: RankedTierMediaSeries[];
}

export interface RankedTierMediaDistribution {
  tiers: RankedTierMediaDistributionTier[];
}

export interface TopListCandidate {
  id: string;
  kind: "mediaType" | "tag";
  titleKey: "analytics.top.type" | "analytics.top.tag";
  values: { name: string };
  /** All eligible entries in canonical ranking order, best first. */
  entryIds: string[];
}

export interface BoundaryReviewCandidate {
  highScore: number;
  lowScore: number;
  highEntryId: string;
  lowEntryId: string;
  fingerprint: string;
}

const SCORES = Array.from({ length: 10 }, (_, index) => index + 1);
const EMPTY_COUNTS = () => Object.fromEntries(SCORES.map((score) => [score, 0])) as ScoreCounts;

function isRated(entry: Entry): entry is Entry & { overallRating: number } {
  return (
    entry.disposition === "experienced" &&
    Number.isInteger(entry.overallRating) &&
    (entry.overallRating ?? 0) >= 1 &&
    (entry.overallRating ?? 0) <= 10
  );
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function modes(counts: readonly number[]): number[] {
  const maximum = Math.max(0, ...counts);
  if (maximum === 0) return [];
  return counts.flatMap((count, index) => (count === maximum ? [index + 1] : []));
}

function localPeaks(counts: ScoreCounts): number[] {
  return SCORES.filter((score) => {
    const value = counts[score];
    if (value === 0) return false;
    return value >= (counts[score - 1] ?? 0) && value >= (counts[score + 1] ?? 0);
  });
}

function shapeObservations(
  counts: ScoreCounts,
  total: number,
  mean: number,
  standardDeviation: number,
  occupiedBins: number,
  allModes: number[],
): RatingObservation[] {
  if (total < 20) return [];

  const observations: RatingObservation[] = [];
  const highestBinShare = Math.max(...SCORES.map((score) => counts[score] / total));
  if (highestBinShare >= 0.6) {
    const score = allModes[0];
    observations.push({
      key: "analytics.observation.concentrated",
      values: { score },
    });
  }

  const peaks = localPeaks(counts)
    .filter((score) => counts[score] / total >= 0.2)
    .sort((a, b) => counts[b] - counts[a] || a - b);
  const separated = peaks.flatMap((scoreA, index) =>
    peaks.slice(index + 1).flatMap((scoreB) => {
      if (Math.abs(scoreA - scoreB) < 3) return [];
      const lower = Math.min(scoreA, scoreB);
      const upper = Math.max(scoreA, scoreB);
      const clearValley = SCORES.filter((score) => score > lower && score < upper).every(
        (score) => counts[score] < counts[lower] && counts[score] < counts[upper],
      );
      return clearValley ? [[scoreA, scoreB] as const] : [];
    }),
  )[0];
  if (separated) {
    observations.push({
      key: "analytics.observation.separatedPeaks",
      values: { scoreA: separated[0], scoreB: separated[1] },
    });
  }

  const averageCount = total / 10;
  const coefficientOfVariation =
    averageCount === 0
      ? 0
      : standardDeviationOf(SCORES.map((score) => counts[score]), averageCount) / averageCount;
  if (occupiedBins >= 8 && coefficientOfVariation <= 0.35) {
    observations.push({ key: "analytics.observation.nearFlat", values: {} });
  }
  if (standardDeviation >= 2.2 && occupiedBins >= 6) {
    observations.push({ key: "analytics.observation.broadSpread", values: {} });
  }

  const bands = [
    { name: "strict", scores: [1, 2, 3, 4] },
    { name: "middle", scores: [5, 6] },
    { name: "appealing", scores: [7, 8] },
    { name: "favorites", scores: [9, 10] },
  ] as const;
  const bandShares = bands.map((band) => ({
    name: band.name,
    share: band.scores.reduce((sum, score) => sum + counts[score], 0) / total,
    containsMode: allModes.some((score) => band.scores.some((bandScore) => bandScore === score)),
  }));
  const dominantBand = bandShares.find(
    (band) =>
      band.share >= 0.45 &&
      band.containsMode &&
      band.share - Math.max(...bandShares.filter((other) => other.name !== band.name).map((other) => other.share)) >= 0.1,
  );
  if (dominantBand) {
    observations.push({
      key: "analytics.observation.ratingBand",
      values: { band: dominantBand.name, percentage: dominantBand.share * 100 },
    });
  }

  if (observations.length === 0) {
    observations.push({ key: "analytics.observation.mixed", values: {} });
  }
  return observations.slice(0, 2);
}

function standardDeviationOf(values: readonly number[], center: number): number {
  if (!values.length) return 0;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - center) ** 2, 0) / values.length);
}

export function deriveRatingDistribution(entries: readonly Entry[]): RatingDistribution {
  const rated = entries.filter(isRated);
  const counts = EMPTY_COUNTS();
  for (const entry of rated) counts[entry.overallRating] += 1;
  const total = rated.length;
  const percentages = Object.fromEntries(
    SCORES.map((score) => [score, total ? (counts[score] / total) * 100 : 0]),
  ) as Record<number, number>;
  const values = rated.map((entry) => entry.overallRating);
  const mean = total ? values.reduce((sum, value) => sum + value, 0) / total : null;
  const populationStandardDeviation = mean === null ? null : standardDeviationOf(values, mean);
  const allModes = modes(SCORES.map((score) => counts[score]));
  return {
    total,
    counts,
    percentages,
    mean,
    median: total ? median(values) : null,
    populationStandardDeviation,
    occupiedBins: SCORES.filter((score) => counts[score] > 0).length,
    modes: allModes,
    observations:
      mean === null || populationStandardDeviation === null
        ? []
        : shapeObservations(
            counts,
            total,
            mean,
            populationStandardDeviation,
            SCORES.filter((score) => counts[score] > 0).length,
            allModes,
          ),
  };
}

function mediaSummary(entries: readonly Entry[]): Omit<MediaDistributionSeries, "typeId" | "name" | "counts"> {
  const ratings = entries.filter(isRated).map((entry) => entry.overallRating);
  const total = ratings.length;
  const countByScore = EMPTY_COUNTS();
  for (const score of ratings) countByScore[score] += 1;
  return {
    count: total,
    mean: ratings.reduce((sum, score) => sum + score, 0) / total,
    median: median(ratings),
    modes: modes(SCORES.map((score) => countByScore[score])),
    highShare: ratings.filter((score) => score >= 8).length / total,
  };
}

export function deriveMediaDistributions(
  entries: readonly Entry[],
  mediaTypes: readonly MediaType[],
): MediaDistributions {
  const groups: Array<{ typeId: string | null; name: string | null; entries: Entry[] }> = [];
  for (const type of mediaTypes) {
    groups.push({
      typeId: type.id,
      name: type.name,
      entries: entries.filter((entry) => entry.mediaTypeId === type.id && isRated(entry)),
    });
  }
  const noType = entries.filter((entry) => entry.mediaTypeId === null && isRated(entry));
  if (noType.length) groups.push({ typeId: null, name: null, entries: noType });

  const series = groups
    .filter((group) => group.entries.length >= 5)
    .map(({ typeId, name, entries: groupEntries }) => {
      const summary = mediaSummary(groupEntries);
      const counts = EMPTY_COUNTS();
      for (const entry of groupEntries) counts[entry.overallRating!] += 1;
      return {
        typeId,
        name,
        ...summary,
        counts: SCORES.map((score) => counts[score]),
      };
    });

  const comparable = groups
    .filter((group) => group.typeId !== null && group.entries.length >= 20)
    .sort((a, b) => b.entries.length - a.entries.length || (a.typeId ?? "").localeCompare(b.typeId ?? ""));
  const comparisons: MediaDistributionComparison[] = [];
  for (let left = 0; left < comparable.length; left += 1) {
    for (let right = left + 1; right < comparable.length; right += 1) {
      const a = comparable[left];
      const b = comparable[right];
      const summaryA = mediaSummary(a.entries);
      const summaryB = mediaSummary(b.entries);
      const ratio = Math.max(summaryA.count, summaryB.count) / Math.min(summaryA.count, summaryB.count);
      const meanDifference = Math.abs(summaryA.mean - summaryB.mean);
      const highShareDifference = Math.abs(summaryA.highShare - summaryB.highShare);
      const medianDifference = Math.abs(summaryA.median - summaryB.median);
      let kind: MediaComparisonKind;
      let higherTypeId: string | null | undefined;
      if (ratio > 4) kind = "imbalanced";
      else if (
        meanDifference < 0.35 &&
        highShareDifference < 0.15 &&
        medianDifference < 1
      ) kind = "similar";
      else if (
        meanDifference >= 0.6 &&
        medianDifference >= 0.5 &&
        Math.sign(summaryA.mean - summaryB.mean) === Math.sign(summaryA.median - summaryB.median)
      ) {
        kind = "higherAverage";
        higherTypeId = summaryA.mean > summaryB.mean ? a.typeId : b.typeId;
      } else if (meanDifference >= 0.6) kind = "mixed";
      else kind = "modest";
      comparisons.push({
        typeAId: a.typeId,
        typeBId: b.typeId,
        nA: summaryA.count,
        nB: summaryB.count,
        meanA: summaryA.mean,
        meanB: summaryB.mean,
        medianA: summaryA.median,
        medianB: summaryB.median,
        modesA: summaryA.modes,
        modesB: summaryB.modes,
        highShareA: summaryA.highShare,
        highShareB: summaryB.highShare,
        peakRelation:
          summaryA.modes.length === summaryB.modes.length &&
          summaryA.modes.every((score, index) => score === summaryB.modes[index])
            ? "same"
            : "different",
        kind,
        ...(higherTypeId !== undefined ? { higherTypeId } : {}),
      });
    }
  }
  const highShareEligible = series.filter(
    (item): item is MediaDistributionSeries & { typeId: string; name: string } =>
      item.typeId !== null && item.name !== null && item.count >= 20,
  );
  const highShareLeaders = highShareEligible.length < 2
    ? []
    : (() => {
        const highest = highShareEligible.reduce((best, item) =>
          item.highShare > best.highShare ? item : best,
        );
        const highCount = (item: MediaDistributionSeries) =>
          item.counts.slice(7).reduce((sum, count) => sum + count, 0);
        const tied = highShareEligible.filter(
          (item) =>
            highCount(item) * highest.count === highCount(highest) * item.count,
        );
        return tied.length === highShareEligible.length
          ? []
          : tied.map((item) => ({
              typeId: item.typeId,
              name: item.name,
              count: item.count,
              highCount: highCount(item),
              highShare: item.highShare,
            }));
      })();
  return { series, comparisons: comparisons.slice(0, 3), highShareLeaders };
}

/**
 * Compare media types by their relative positions inside each score tier.
 * Only explicit placements contribute to rank and media frequency. Unplaced
 * rated works remain in `totalRated`, so the chart can show how complete each
 * tier's ranking is without inventing positions for them.
 */
export function deriveRankedTierMediaDistribution(
  entries: readonly Entry[],
  mediaTypes: readonly MediaType[],
  tiers: readonly RankingTierOrder[],
): RankedTierMediaDistribution {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const uniqueEntries = [...byId.values()];
  const rankIndex = buildLibraryRankIndex(uniqueEntries, tiers);
  const knownTypes = new Map(mediaTypes.map((type) => [type.id, type]));
  const observedTypeIds = new Set<string | null>(
    uniqueEntries.filter(isRated).map((entry) => entry.mediaTypeId),
  );
  const orderedTypeIds: Array<string | null> = [
    ...mediaTypes.filter((type) => observedTypeIds.has(type.id)).map((type) => type.id),
    ...[...observedTypeIds]
      .filter((typeId): typeId is string => typeId !== null && !knownTypes.has(typeId))
      .sort((a, b) => a.localeCompare(b)),
    ...(observedTypeIds.has(null) ? [null] : []),
  ];

  const result = SCORES.map((score): RankedTierMediaDistributionTier => {
    const ratedInTier = uniqueEntries.filter(
      (entry) => isRated(entry) && entry.overallRating === score,
    );
    const rankedInTier = ratedInTier.filter((entry) => rankIndex.withinScore.has(entry.id));
    const rankedCount = rankedInTier.length;
    const groups = orderedTypeIds.flatMap((typeId) => {
      const ratedEntries = ratedInTier.filter((entry) => entry.mediaTypeId === typeId);
      if (!ratedEntries.length) return [];
      const placedEntries = ratedEntries.filter((entry) => rankIndex.withinScore.has(entry.id));
      const positions = placedEntries.flatMap((entry) => {
        const rank = rankIndex.withinScore.get(entry.id);
        return rank === undefined ? [] : [rank];
      });
      const count = positions.length;
      const meanRank = count
        ? positions.reduce((sum, rank) => sum + rank, 0) / count
        : null;
      return [{
        typeId,
        name: typeId === null ? null : (knownTypes.get(typeId)?.name ?? null),
        count,
        ratedCount: ratedEntries.length,
        unplacedCount: ratedEntries.length - count,
        meanRank,
        rawStrength: meanRank === null || rankedCount === 0
          ? null
          : (rankedCount + 1 - meanRank) / rankedCount,
      }];
    });
    const largestTypePlacedCount = Math.max(0, ...groups.map((group) => group.count));
    const eligible = groups.filter(
      (group) =>
        group.count > 0 &&
        !(group.count < 3 && group.count <= largestTypePlacedCount / 4),
    );
    const placedTypeCount = groups.filter((group) => group.count > 0).length;
    const available = rankedCount >= 2 && placedTypeCount >= 2;
    const strengthTotal = eligible.reduce(
      (sum, group) => sum + (group.rawStrength ?? 0),
      0,
    );
    const series = groups.map((group): RankedTierMediaSeries => {
      const sparseRelative =
        group.count > 0 &&
        group.count < 3 &&
        group.count <= largestTypePlacedCount / 4;
      const excludedReason: RankedTierMediaExclusionReason | null = group.count === 0
        ? "unplaced"
        : sparseRelative
          ? "sparseRelative"
          : null;
      const scoreValue = !available
        ? null
        : group.count === 0 || sparseRelative
          ? 0
          : strengthTotal > 0
            ? (group.rawStrength ?? 0) / strengthTotal
            : 0;
      return {
        ...group,
        excludedPlacedCount: sparseRelative ? group.count : 0,
        excludedReason,
        score: scoreValue,
      };
    });

    return {
      score,
      totalRated: ratedInTier.length,
      rankedCount,
      coverage: ratedInTier.length ? rankedCount / ratedInTier.length : 0,
      available,
      series,
    };
  });

  return { tiers: result };
}

export function deriveRarity(entries: readonly Entry[]): RatingRarity[] {
  const distribution = deriveRatingDistribution(entries);
  return [...SCORES].reverse().map((score) => ({
    score,
    count: distribution.counts[score],
    percentage: distribution.percentages[score],
  }));
}

function jaccardSimilarity(a: readonly string[], b: readonly string[]): number {
  const setA = new Set(a.slice(0, 5));
  const setB = new Set(b.slice(0, 5));
  if (!setA.size && !setB.size) return 1;
  let intersection = 0;
  for (const id of setA) if (setB.has(id)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union ? intersection / union : 0;
}

export function buildTopListCandidates(
  entries: readonly Entry[],
  mediaTypes: readonly MediaType[],
  tags: readonly Tag[],
  tiers: readonly RankingTierOrder[],
): TopListCandidate[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const rankIndex = buildLibraryRankIndex(entries, tiers);
  const ordered = [...rankIndex.overall.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([id]) => byId.get(id))
    .filter((entry): entry is Entry => Boolean(entry && isRated(entry)));
  const candidates: TopListCandidate[] = [];
  const add = (
    id: string,
    kind: TopListCandidate["kind"],
    titleKey: TopListCandidate["titleKey"],
    name: string,
    matches: (entry: Entry) => boolean,
  ) => {
    const selected = ordered.filter(matches);
    if (selected.length < 8) return;
    const countsPerScore = new Map<number, number>();
    for (const entry of selected) {
      const score = entry.overallRating!;
      countsPerScore.set(score, (countsPerScore.get(score) ?? 0) + 1);
    }
    const diverse = countsPerScore.size >= 3;
    const intentionallyOrderedSameScore = [...countsPerScore.values()].some((count) => count >= 8);
    if (!diverse && !intentionallyOrderedSameScore) return;
    const candidate: TopListCandidate = {
      id,
      kind,
      titleKey,
      values: { name },
      entryIds: selected.map((entry) => entry.id),
    };
    candidates.push(candidate);
  };

  for (const type of mediaTypes) {
    add(`type:${type.id}`, "mediaType", "analytics.top.type", type.name, (entry) => entry.mediaTypeId === type.id);
  }
  for (const tag of tags) {
    add(`tag:${tag.id}`, "tag", "analytics.top.tag", tag.name, (entry) => entry.tagIds.includes(tag.id));
  }
  return candidates;
}

function seededRandom(seed: number): () => number {
  let state = (Math.trunc(seed) >>> 0) || 0x9e3779b9;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function selectTopLists(
  candidates: readonly TopListCandidate[],
  seed: number,
  previousEntrySets: readonly (readonly string[])[] = [],
  limit = 3,
  previousCandidateIds: readonly string[] = [],
): TopListCandidate[] {
  if (!candidates.length || limit <= 0) return [];
  const random = seededRandom(seed);
  const shuffled = [...candidates];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
  }
  const selected: TopListCandidate[] = [];
  const isDistinct = (candidate: TopListCandidate) =>
    ![...previousEntrySets, ...selected.map((item) => item.entryIds)].some(
      (set) => jaccardSimilarity(candidate.entryIds, set) > 0.8,
    );
  const distinct = shuffled.filter(isDistinct);
  const pool = distinct.length
    ? distinct
    : previousCandidateIds.length && candidates.some((candidate) => !previousCandidateIds.includes(candidate.id))
      ? shuffled.filter((candidate) => !previousCandidateIds.includes(candidate.id))
      : shuffled;
  for (const candidate of pool) {
    if (selected.length >= limit) break;
    if (selected.some((item) => jaccardSimilarity(candidate.entryIds, item.entryIds) > 0.8)) continue;
    selected.push(candidate);
  }
  if (!selected.length) selected.push(shuffled[0]);
  return selected;
}

function boundaryFingerprint(
  highScore: number,
  lowScore: number,
  highIds: readonly string[],
  lowIds: readonly string[],
): string {
  const tuple = [
    "v1",
    highScore,
    lowScore,
    highIds.at(-1) ?? "",
    highIds.at(-2) ?? "",
    lowIds[0] ?? "",
    lowIds[1] ?? "",
  ];
  return `boundary:${JSON.stringify(tuple)}`;
}

export function deriveNextBoundaryReview(
  entries: readonly Entry[],
  tiers: readonly RankingTierOrder[],
  confirmedFingerprints: readonly string[] = [],
): BoundaryReviewCandidate | null {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const rankIndex = buildLibraryRankIndex(entries, tiers);
  const available = new Map(
    tiers.map((tier) => [
      tier.score,
      tier.placedIds.filter((id) => {
        const entry = byId.get(id);
        return (
          rankIndex.overall.has(id) &&
          entry?.disposition === "experienced" &&
          entry.overallRating === tier.score
        );
      }),
    ]),
  );
  for (let highScore = 10; highScore >= 2; highScore -= 1) {
    const highIds = available.get(highScore) ?? [];
    const lowScore = highScore - 1;
    const lowIds = available.get(lowScore) ?? [];
    if (!highIds.length || !lowIds.length) continue;
    const fingerprint = boundaryFingerprint(highScore, lowScore, highIds, lowIds);
    if (confirmedFingerprints.includes(fingerprint)) continue;
    return {
      highScore,
      lowScore,
      highEntryId: highIds[highIds.length - 1],
      lowEntryId: lowIds[0],
      fingerprint,
    };
  }
  return null;
}
